-- Bed Sync AI SMS Agent - Initial Schema

-- ============================================
-- DEALERS (accounts / tenants)
-- ============================================
CREATE TABLE dealers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name TEXT NOT NULL,
  twilio_phone TEXT,
  owner_name TEXT,
  owner_phone TEXT,
  owner_email TEXT,
  plan TEXT NOT NULL DEFAULT 'single_lot' CHECK (plan IN ('single_lot', 'multi_lot')),
  messages_used INTEGER NOT NULL DEFAULT 0,
  messages_included INTEGER NOT NULL DEFAULT 1000,
  overage_rate NUMERIC(4,2) NOT NULL DEFAULT 0.05,
  monthly_cost NUMERIC(8,2) NOT NULL DEFAULT 99.00,
  billing_cycle_start DATE DEFAULT CURRENT_DATE,
  active BOOLEAN NOT NULL DEFAULT true,
  settings JSONB NOT NULL DEFAULT '{
    "auto_reply": true,
    "follow_up_enabled": true,
    "follow_up_delays": [30, 1440, 4320],
    "max_follow_ups": 3,
    "business_hours_start": "09:00",
    "business_hours_end": "20:00",
    "timezone": "America/Chicago",
    "greeting_style": "friendly",
    "store_address": "",
    "financing_url": "",
    "deposit_url": "",
    "handoff_phone": ""
  }'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================
-- LEADS
-- ============================================
CREATE TABLE leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_id UUID NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  customer_name TEXT,
  email TEXT,
  source TEXT NOT NULL DEFAULT 'website'
    CHECK (source IN ('website', 'facebook', 'google', 'manual', 'referral', 'walk_in', 'other')),
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'qualifying', 'qualified', 'hot', 'converted', 'lost', 'handed_off')),
  lead_score INTEGER NOT NULL DEFAULT 0,
  qualification JSONB NOT NULL DEFAULT '{}'::jsonb,
  tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(dealer_id, phone)
);

CREATE INDEX idx_leads_dealer ON leads(dealer_id);
CREATE INDEX idx_leads_status ON leads(status);
CREATE INDEX idx_leads_phone ON leads(phone);

-- ============================================
-- CONVERSATIONS
-- ============================================
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  dealer_id UUID NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'handed_off', 'closed', 'follow_up')),
  agent_state TEXT NOT NULL DEFAULT 'greeting'
    CHECK (agent_state IN (
      'greeting', 'qualifying', 'recommending', 'objection_handling',
      'closing', 'follow_up', 'handed_off', 'converted', 'lost'
    )),
  context JSONB NOT NULL DEFAULT '{
    "customer_name": null,
    "mattress_size": null,
    "budget_min": null,
    "budget_max": null,
    "firmness": null,
    "sleeping_position": null,
    "mattress_type": null,
    "urgency": null,
    "financing_interest": null,
    "delivery_zip": null,
    "store_location": null,
    "trade_in": null,
    "preferred_next_step": null,
    "objections": [],
    "recommendations_shown": [],
    "agent_notes": []
  }'::jsonb,
  follow_up_count INTEGER NOT NULL DEFAULT 0,
  next_follow_up_at TIMESTAMPTZ,
  handed_off_at TIMESTAMPTZ,
  handed_off_reason TEXT,
  closed_at TIMESTAMPTZ,
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_conversations_dealer ON conversations(dealer_id);
CREATE INDEX idx_conversations_lead ON conversations(lead_id);
CREATE INDEX idx_conversations_status ON conversations(status);
CREATE INDEX idx_conversations_followup ON conversations(next_follow_up_at)
  WHERE status = 'follow_up' AND next_follow_up_at IS NOT NULL;

-- ============================================
-- MESSAGES
-- ============================================
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  sender TEXT NOT NULL CHECK (sender IN ('customer', 'agent', 'human')),
  body TEXT NOT NULL,
  twilio_sid TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_messages_conversation ON messages(conversation_id);
CREATE INDEX idx_messages_created ON messages(created_at);

-- ============================================
-- INVENTORY
-- ============================================
CREATE TABLE inventory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_id UUID NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  brand TEXT NOT NULL,
  model TEXT NOT NULL,
  series TEXT,
  size TEXT NOT NULL CHECK (size IN ('twin', 'twin_xl', 'full', 'queen', 'king', 'cal_king', 'split_king')),
  firmness TEXT CHECK (firmness IN ('soft', 'medium_soft', 'medium', 'medium_firm', 'firm', 'extra_firm')),
  type TEXT CHECK (type IN ('innerspring', 'memory_foam', 'hybrid', 'latex', 'adjustable', 'pillow_top', 'gel_foam')),
  price NUMERIC(8,2) NOT NULL,
  sale_price NUMERIC(8,2),
  msrp NUMERIC(8,2),
  in_stock BOOLEAN NOT NULL DEFAULT true,
  quantity INTEGER NOT NULL DEFAULT 1,
  features TEXT[] DEFAULT '{}',
  description TEXT,
  financing_eligible BOOLEAN NOT NULL DEFAULT true,
  promotion TEXT,
  sku TEXT,
  building_serial TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_inventory_dealer ON inventory(dealer_id);
CREATE INDEX idx_inventory_size ON inventory(size);
CREATE INDEX idx_inventory_price ON inventory(price);
CREATE INDEX idx_inventory_stock ON inventory(in_stock) WHERE in_stock = true;

-- ============================================
-- RECOMMENDATIONS (audit trail)
-- ============================================
CREATE TABLE recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  inventory_id UUID NOT NULL REFERENCES inventory(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL,
  reason TEXT,
  customer_response TEXT,
  presented_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_recommendations_conversation ON recommendations(conversation_id);

-- ============================================
-- AGENT AUDIT LOG
-- ============================================
CREATE TABLE agent_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN (
    'tool_call', 'state_change', 'handoff', 'follow_up_scheduled',
    'follow_up_sent', 'recommendation', 'message_sent', 'message_received',
    'error', 'resume', 'lead_scored'
  )),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agent_logs_conversation ON agent_logs(conversation_id);
CREATE INDEX idx_agent_logs_action ON agent_logs(action);

-- ============================================
-- FOLLOW-UP SCHEDULE
-- ============================================
CREATE TABLE follow_ups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  scheduled_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  follow_up_number INTEGER NOT NULL DEFAULT 1,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'cancelled', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_follow_ups_pending ON follow_ups(scheduled_at)
  WHERE status = 'pending';

-- ============================================
-- USAGE TRACKING
-- ============================================
CREATE TABLE usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_id UUID NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('sms_sent', 'sms_received', 'agent_call')),
  message_id UUID REFERENCES messages(id),
  cost NUMERIC(6,4) DEFAULT 0,
  billing_period DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_usage_dealer_period ON usage_events(dealer_id, billing_period);

-- ============================================
-- UPDATED_AT TRIGGER
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER dealers_updated_at BEFORE UPDATE ON dealers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER leads_updated_at BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER conversations_updated_at BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER inventory_updated_at BEFORE UPDATE ON inventory
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

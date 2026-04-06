-- Outreach prospects table for MBA dealer campaign
-- When an inbound SMS comes from a number in this table,
-- route the reply to the BedSync admin instead of the AI agent.

CREATE TABLE IF NOT EXISTS outreach_prospects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone text NOT NULL,
  name text,
  business_name text,
  city text,
  state text,
  email text,
  website text,
  google_maps_url text,
  campaign text DEFAULT 'mba_outreach_v1',
  status text DEFAULT 'pending', -- pending, sent, replied, opted_out, converted
  last_message_sent text,
  last_message_sent_at timestamptz,
  last_reply text,
  last_reply_at timestamptz,
  phase integer DEFAULT 0, -- 0=not started, 1=initial sms, 2=email, 3=rvm, 4=follow-up sms
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Index on phone for fast lookups during inbound routing
CREATE UNIQUE INDEX IF NOT EXISTS idx_outreach_prospects_phone ON outreach_prospects(phone);
CREATE INDEX IF NOT EXISTS idx_outreach_prospects_status ON outreach_prospects(status);
CREATE INDEX IF NOT EXISTS idx_outreach_prospects_campaign ON outreach_prospects(campaign);

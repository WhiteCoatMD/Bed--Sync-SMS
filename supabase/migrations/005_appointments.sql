-- ============================================
-- APPOINTMENTS
-- ============================================
-- The appointments table existed in production but was never captured in a
-- migration. This makes it reproducible (safe no-op where it already exists).
-- Written from src/lib/types.ts Appointment + the agent's insert in
-- src/lib/agent/orchestrator.ts and the reminder query in
-- src/lib/agent/reminders.ts.

CREATE TABLE IF NOT EXISTS appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  dealer_id UUID NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'showroom_visit'
    CHECK (type IN ('showroom_visit', 'phone_call', 'delivery', 'other')),
  scheduled_at TIMESTAMPTZ NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'confirmed', 'completed', 'cancelled', 'no_show')),
  notes TEXT,
  created_by TEXT NOT NULL DEFAULT 'agent'
    CHECK (created_by IN ('agent', 'human')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appointments_dealer ON appointments(dealer_id);
CREATE INDEX IF NOT EXISTS idx_appointments_scheduled ON appointments(scheduled_at);
-- Used by the reminder job to find upcoming appointments to remind on.
CREATE INDEX IF NOT EXISTS idx_appointments_upcoming ON appointments(scheduled_at)
  WHERE status IN ('scheduled', 'confirmed');

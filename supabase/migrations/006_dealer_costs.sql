-- Per-dealer running cost for the current billing period, so a dealer's AI
-- usage can be capped before it eats the subscription margin.
--
-- Rates that feed this live in src/lib/cost.ts. Costs are recorded as they are
-- incurred (each message sent/received, each model call) rather than estimated
-- from message counts, because MMS and long conversations cost several times a
-- plain SMS reply.
CREATE TABLE IF NOT EXISTS dealer_costs (
    dealer_id UUID PRIMARY KEY REFERENCES dealers(id) ON DELETE CASCADE,
    period_start DATE NOT NULL DEFAULT date_trunc('month', CURRENT_DATE)::date,
    cost_usd NUMERIC(10, 4) NOT NULL DEFAULT 0,
    -- What this dealer is allowed to cost per period before the agent stops.
    -- Raise it for a dealer paying for more.
    cap_usd NUMERIC(10, 2) NOT NULL DEFAULT 25.00,
    -- Set when the cap is hit, cleared when the period rolls over.
    capped_at TIMESTAMPTZ,
    -- So the dealer is told once, not on every blocked message.
    notified_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dealer_costs_capped ON dealer_costs (capped_at) WHERE capped_at IS NOT NULL;

-- Itemised so a bill can be explained, and so the rate model can be checked
-- against the real Telnyx and Anthropic invoices.
CREATE TABLE IF NOT EXISTS cost_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dealer_id UUID NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('sms_out', 'sms_in', 'mms_out', 'llm')),
    cost_usd NUMERIC(10, 6) NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cost_events_dealer_time ON cost_events (dealer_id, created_at DESC);

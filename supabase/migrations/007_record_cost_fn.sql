-- Atomic cost accrual.
--
-- The meter previously lived in dealers.settings.cost and was updated with a
-- read-modify-write, so two messages landing in the same instant could lose an
-- increment. This does the whole thing in one statement: upsert the period row,
-- add the cost, and stamp capped_at the moment the ceiling is crossed.
--
-- Returns the running total and whether the dealer is now over their cap, so
-- the caller needs no follow-up read.
DROP FUNCTION IF EXISTS record_dealer_cost(UUID, NUMERIC, DATE);

CREATE OR REPLACE FUNCTION record_dealer_cost(
    d_id UUID,
    amount NUMERIC,
    period DATE
)
RETURNS TABLE (out_cost_usd NUMERIC, out_cap_usd NUMERIC, out_over_cap BOOLEAN)
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO dealer_costs AS dc (dealer_id, period_start, cost_usd)
    VALUES (d_id, period, amount)
    ON CONFLICT (dealer_id) DO UPDATE SET
        -- A new billing period resets the meter and releases any pause.
        cost_usd = CASE WHEN dc.period_start <> period THEN amount ELSE dc.cost_usd + amount END,
        period_start = period,
        capped_at = CASE WHEN dc.period_start <> period THEN NULL ELSE dc.capped_at END,
        notified_at = CASE WHEN dc.period_start <> period THEN NULL ELSE dc.notified_at END,
        updated_at = NOW();

    -- Stamp the moment the ceiling is crossed (cap 0 means unlimited).
    UPDATE dealer_costs
       SET capped_at = NOW()
     WHERE dealer_id = d_id
       AND capped_at IS NULL
       AND cap_usd > 0
       AND cost_usd >= cap_usd;

    RETURN QUERY
    SELECT dc2.cost_usd, dc2.cap_usd, (dc2.cap_usd > 0 AND dc2.cost_usd >= dc2.cap_usd)
      FROM dealer_costs dc2 WHERE dc2.dealer_id = d_id;
END;
$$;

-- The published allowance lives alongside the dollar meter: dealers buy a
-- number of conversations, and the dollar cap is the backstop behind it.
ALTER TABLE dealer_costs
    ADD COLUMN IF NOT EXISTS conversations_used INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS conversations_included INTEGER NOT NULL DEFAULT 100;

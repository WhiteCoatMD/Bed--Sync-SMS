import { getServiceClient } from './supabase';

/**
 * What a dealer costs us to run, and the ceiling before the agent stops.
 *
 * Rates are measured, not guessed:
 *  - Telnyx: averaged from real message detail records (rate + carrier fee).
 *    SMS bills per 160-char segment; MMS is flat per message.
 *  - Anthropic Haiku 4.5: $1.00 / MTok input, $5.00 / MTok output; cache reads
 *    ~0.1x input, cache writes ~1.25x input.
 *
 * Any rate can be overridden by env var, so a carrier or provider price change
 * does not need a deploy.
 *
 * STORAGE NOTE: the meter lives in dealers.settings.cost rather than its own
 * table, because this project's database is reachable only through PostgREST —
 * there is no DDL credential. supabase/migrations/006_dealer_costs.sql holds the
 * proper schema for when there is; see readCost() for the trade-off that costs.
 */
const num = (v: string | undefined, fallback: number) => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const RATES = {
  smsSegment: num(process.env.COST_SMS_SEGMENT_USD, 0.0125),
  mmsMessage: num(process.env.COST_MMS_MESSAGE_USD, 0.034),
  llmInputPerMTok: num(process.env.COST_LLM_INPUT_PER_MTOK, 1.0),
  llmOutputPerMTok: num(process.env.COST_LLM_OUTPUT_PER_MTOK, 5.0),
  llmCacheReadPerMTok: num(process.env.COST_LLM_CACHE_READ_PER_MTOK, 0.1),
  llmCacheWritePerMTok: num(process.env.COST_LLM_CACHE_WRITE_PER_MTOK, 1.25),
};

export const DEFAULT_CAP_USD = num(process.env.DEALER_COST_CAP_USD, 25);

/**
 * The number we publish. Measured cost is ~$0.25 a conversation (roughly 15 SMS
 * segments, a handful of model turns, a photo message or two), so 100 lands on
 * the $25 ceiling — the figure on the price sheet and the figure that protects
 * the margin are deliberately the same number.
 */
export const DEFAULT_CONVERSATIONS_INCLUDED = num(process.env.DEALER_CONVERSATIONS_INCLUDED, 100);

export type CostKind = 'sms_out' | 'sms_in' | 'mms_out' | 'llm';

/** SMS bills per segment: 160 chars alone, 153 each when concatenated. */
export function segmentsFor(body: string): number {
  const len = (body || '').length;
  return len <= 160 ? 1 : Math.ceil(len / 153);
}

export function messageCost(body: string, mediaCount = 0): number {
  return mediaCount > 0 ? RATES.mmsMessage : segmentsFor(body) * RATES.smsSegment;
}

export interface LlmUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function llmCost(usage: LlmUsage | undefined | null): number {
  if (!usage) return 0;
  const per = (tokens: number, rate: number) => (tokens / 1_000_000) * rate;
  return (
    per(usage.input_tokens || 0, RATES.llmInputPerMTok) +
    per(usage.output_tokens || 0, RATES.llmOutputPerMTok) +
    per(usage.cache_read_input_tokens || 0, RATES.llmCacheReadPerMTok) +
    per(usage.cache_creation_input_tokens || 0, RATES.llmCacheWritePerMTok)
  );
}

function currentPeriod(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

interface StoredCost {
  period_start: string;
  cost_usd: number;
  cap_usd: number;
  /** The published allowance. Dealers buy conversations, not SMS segments. */
  conversations_used: number;
  conversations_included: number;
  capped_at: string | null;
  notified_at: string | null;
  breakdown: Partial<Record<CostKind, { count: number; cost_usd: number }>>;
}

function emptyCost(capUsd = DEFAULT_CAP_USD, included = DEFAULT_CONVERSATIONS_INCLUDED): StoredCost {
  return {
    period_start: currentPeriod(),
    cost_usd: 0,
    cap_usd: capUsd,
    conversations_used: 0,
    conversations_included: included,
    capped_at: null,
    notified_at: null,
    breakdown: {},
  };
}

async function readRaw(dealerId: string): Promise<{ settings: Record<string, unknown>; cost: StoredCost }> {
  const db = getServiceClient();
  const { data } = await db.from('dealers').select('settings').eq('id', dealerId).maybeSingle();
  const settings = ((data?.settings || {}) as unknown) as Record<string, unknown>;
  const stored = settings.cost as StoredCost | undefined;

  // A new billing period resets the meter and releases any pause.
  if (!stored || stored.period_start !== currentPeriod()) {
    return {
      settings,
      cost: emptyCost(
        stored ? Number(stored.cap_usd) : DEFAULT_CAP_USD,
        stored ? Number(stored.conversations_included) : DEFAULT_CONVERSATIONS_INCLUDED
      ),
    };
  }
  return { settings, cost: { ...emptyCost(), ...stored } };
}

export interface CostState {
  costUsd: number;
  capUsd: number;
  overCap: boolean;
  conversationsUsed: number;
  conversationsIncluded: number;
  /**
   * Whether a NEW conversation may begin. Deliberately separate from overCap:
   * a conversation already under way always finishes, whatever the meter says.
   * Cutting someone off halfway through booking a visit would cost the dealer
   * the sale and make the product look broken — the few conversations in flight
   * when the limit lands are worth pennies.
   */
  canStartConversation: boolean;
  cappedAt: string | null;
  notifiedAt: string | null;
  periodStart: string;
  breakdown: StoredCost['breakdown'];
}

export async function getCostState(dealerId: string): Promise<CostState> {
  const { cost } = await readRaw(dealerId);
  const capUsd = Number(cost.cap_usd);
  const costUsd = Number(cost.cost_usd);
  const used = Number(cost.conversations_used || 0);
  const included = Number(cost.conversations_included || DEFAULT_CONVERSATIONS_INCLUDED);

  // A cap of 0 means unlimited — for a dealer on a different arrangement.
  const overCap = capUsd > 0 && costUsd >= capUsd;
  const overAllowance = included > 0 && used >= included;

  return {
    costUsd,
    capUsd,
    overCap,
    conversationsUsed: used,
    conversationsIncluded: included,
    canStartConversation: !overCap && !overAllowance,
    cappedAt: cost.capped_at,
    notifiedAt: cost.notified_at,
    periodStart: cost.period_start,
    breakdown: cost.breakdown || {},
  };
}

async function writeCost(dealerId: string, settings: Record<string, unknown>, cost: StoredCost): Promise<void> {
  await getServiceClient().from('dealers').update({ settings: { ...settings, cost } }).eq('id', dealerId);
}

/**
 * Record what something cost. Never throws — a billing meter must not be able
 * to take down a customer conversation.
 *
 * This is a read-modify-write on a JSON column, so two messages landing in the
 * same instant can lose one increment. That undercounts slightly; it does not
 * lose the cap, and the next message re-reads the true stored total. Moving to
 * dealer_costs (migration 006) makes it atomic.
 */
export async function recordCost(
  dealerId: string,
  kind: CostKind,
  costUsd: number,
  details: Record<string, unknown> = {}
): Promise<void> {
  if (!dealerId || !(costUsd > 0)) return;
  try {
    const { settings, cost } = await readRaw(dealerId);
    const next: StoredCost = {
      ...cost,
      cost_usd: Number((Number(cost.cost_usd) + costUsd).toFixed(6)),
      breakdown: {
        ...cost.breakdown,
        [kind]: {
          count: (cost.breakdown?.[kind]?.count || 0) + 1,
          cost_usd: Number(((cost.breakdown?.[kind]?.cost_usd || 0) + costUsd).toFixed(6)),
        },
      },
    };
    if (next.cap_usd > 0 && next.cost_usd >= next.cap_usd && !next.capped_at) {
      next.capped_at = new Date().toISOString();
      console.warn(`[Cost] Dealer ${dealerId} reached the $${next.cap_usd} cap at $${next.cost_usd.toFixed(4)}`, details);
    }
    await writeCost(dealerId, settings, next);
  } catch (err) {
    console.error('[Cost] Could not record cost:', err);
  }
}

/** Count a conversation as it begins. The allowance is spent up front. */
export async function countConversationStarted(dealerId: string): Promise<void> {
  try {
    const { settings, cost } = await readRaw(dealerId);
    await writeCost(dealerId, settings, {
      ...cost,
      conversations_used: Number(cost.conversations_used || 0) + 1,
    });
  } catch (err) {
    console.error('[Cost] Could not count conversation:', err);
  }
}

/** Set the published allowance. 0 means unlimited. */
export async function setConversationsIncluded(dealerId: string, included: number): Promise<CostState> {
  const { settings, cost } = await readRaw(dealerId);
  const release = included === 0 || included > Number(cost.conversations_used || 0);
  await writeCost(dealerId, settings, {
    ...cost,
    conversations_included: included,
    ...(release ? { capped_at: null, notified_at: null } : {}),
  });
  return getCostState(dealerId);
}

/** Say it once, not on every blocked message. */
export async function markCapNotified(dealerId: string): Promise<void> {
  try {
    const { settings, cost } = await readRaw(dealerId);
    await writeCost(dealerId, settings, { ...cost, notified_at: new Date().toISOString() });
  } catch (err) {
    console.error('[Cost] Could not mark cap notification:', err);
  }
}

/** Set a dealer's ceiling. 0 means unlimited. Raising it releases a pause. */
export async function setCap(dealerId: string, capUsd: number): Promise<CostState> {
  const { settings, cost } = await readRaw(dealerId);
  const release = capUsd === 0 || capUsd > Number(cost.cost_usd);
  await writeCost(dealerId, settings, {
    ...cost,
    cap_usd: capUsd,
    ...(release ? { capped_at: null, notified_at: null } : {}),
  });
  return getCostState(dealerId);
}

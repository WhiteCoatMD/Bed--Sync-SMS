import { getServiceClient } from './supabase';

/**
 * What a dealer costs to run, and the limits that stop it running away.
 *
 * Rates are measured, not guessed:
 *  - Telnyx: averaged from real message detail records (rate + carrier fee).
 *    SMS bills per 160-char segment; MMS is flat per message.
 *  - Anthropic Haiku 4.5: $1.00 / MTok input, $5.00 / MTok output; cache reads
 *    ~0.1x input, cache writes ~1.25x input.
 *
 * Any rate can be overridden by env var, so a carrier or provider price change
 * needs no deploy.
 *
 * Two limits, deliberately separate: conversations_included is the number the
 * dealer was sold; cap_usd is the margin backstop behind it.
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
 * The number we publish. Measured cost is ~$0.25 a conversation, so 100 lands
 * on the $25 ceiling — the figure on the price sheet and the figure protecting
 * the margin are deliberately the same.
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
   * the sale and make the product look broken — the few in flight when the
   * limit lands are worth pennies.
   */
  canStartConversation: boolean;
  cappedAt: string | null;
  notifiedAt: string | null;
  periodStart: string;
}

/** Read the meter. A row from a previous month reads as a fresh one. */
export async function getCostState(dealerId: string): Promise<CostState> {
  const db = getServiceClient();
  const period = currentPeriod();

  const { data } = await db
    .from('dealer_costs')
    .select('period_start, cost_usd, cap_usd, conversations_used, conversations_included, capped_at, notified_at')
    .eq('dealer_id', dealerId)
    .maybeSingle();

  if (!data) {
    return {
      costUsd: 0,
      capUsd: DEFAULT_CAP_USD,
      overCap: false,
      conversationsUsed: 0,
      conversationsIncluded: DEFAULT_CONVERSATIONS_INCLUDED,
      canStartConversation: true,
      cappedAt: null,
      notifiedAt: null,
      periodStart: period,
    };
  }

  // The stored row still belongs to last month until the next write rolls it
  // over (record_dealer_cost does that atomically), so treat it as empty here.
  const rolled = String(data.period_start).slice(0, 10) !== period;
  const capUsd = Number(data.cap_usd);
  const included = Number(data.conversations_included);
  const costUsd = rolled ? 0 : Number(data.cost_usd);
  const used = rolled ? 0 : Number(data.conversations_used);

  // A cap or allowance of 0 means unlimited — for a dealer on another deal.
  const overCap = capUsd > 0 && costUsd >= capUsd;
  const overAllowance = included > 0 && used >= included;

  return {
    costUsd,
    capUsd,
    overCap,
    conversationsUsed: used,
    conversationsIncluded: included,
    canStartConversation: !overCap && !overAllowance,
    cappedAt: rolled ? null : data.capped_at,
    notifiedAt: rolled ? null : data.notified_at,
    periodStart: period,
  };
}

/**
 * Record what something cost. Never throws — a billing meter must not be able
 * to take down a customer conversation.
 *
 * The accrual is one statement (record_dealer_cost), so two messages landing in
 * the same instant can no longer lose an increment.
 */
export async function recordCost(
  dealerId: string,
  kind: CostKind,
  costUsd: number,
  details: Record<string, unknown> = {}
): Promise<void> {
  if (!dealerId || !(costUsd > 0)) return;
  const db = getServiceClient();
  try {
    // Itemised, so a bill can be explained and the rate model checked against
    // the real Telnyx and Anthropic invoices.
    await db.from('cost_events').insert({ dealer_id: dealerId, kind, cost_usd: costUsd, details });
    const { error } = await db.rpc('record_dealer_cost', {
      d_id: dealerId,
      amount: costUsd,
      period: currentPeriod(),
    });
    if (error) console.error('[Cost] record_dealer_cost failed:', error);
  } catch (err) {
    console.error('[Cost] Could not record cost:', err);
  }
}

/** Write the limit columns, preserving whatever is not being changed. */
async function updateLimits(dealerId: string, patch: Record<string, unknown>): Promise<CostState> {
  const db = getServiceClient();
  const state = await getCostState(dealerId);
  await db.from('dealer_costs').upsert(
    {
      dealer_id: dealerId,
      period_start: state.periodStart,
      cost_usd: state.costUsd,
      conversations_used: state.conversationsUsed,
      cap_usd: state.capUsd,
      conversations_included: state.conversationsIncluded,
      ...patch,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'dealer_id' }
  );
  return getCostState(dealerId);
}

/** Count a conversation as it begins. The allowance is spent up front. */
export async function countConversationStarted(dealerId: string): Promise<void> {
  try {
    const state = await getCostState(dealerId);
    await updateLimits(dealerId, { conversations_used: state.conversationsUsed + 1 });
  } catch (err) {
    console.error('[Cost] Could not count conversation:', err);
  }
}

/** Set the dollar backstop. 0 means unlimited. Raising it releases a pause. */
export async function setCap(dealerId: string, capUsd: number): Promise<CostState> {
  const state = await getCostState(dealerId);
  const release = capUsd === 0 || capUsd > state.costUsd;
  return updateLimits(dealerId, {
    cap_usd: capUsd,
    ...(release ? { capped_at: null, notified_at: null } : {}),
  });
}

/** Set the published allowance. 0 means unlimited. */
export async function setConversationsIncluded(dealerId: string, included: number): Promise<CostState> {
  const state = await getCostState(dealerId);
  const release = included === 0 || included > state.conversationsUsed;
  return updateLimits(dealerId, {
    conversations_included: included,
    ...(release ? { capped_at: null, notified_at: null } : {}),
  });
}

/** Say it once, not on every blocked message. */
export async function markCapNotified(dealerId: string): Promise<void> {
  try {
    await updateLimits(dealerId, { notified_at: new Date().toISOString() });
  } catch (err) {
    console.error('[Cost] Could not mark cap notification:', err);
  }
}

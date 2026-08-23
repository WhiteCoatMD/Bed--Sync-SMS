import type { SupabaseClient } from '@supabase/supabase-js';
import type { ConversationContext } from '../types';

/**
 * What we already know about someone who has talked to us before.
 *
 * A returning customer is common — they text back weeks later, or fill in the
 * website form a second time. Starting them from a blank conversation makes
 * the agent introduce itself and re-ask their size and sleep position as if
 * they were a stranger, which reads badly to someone who just told us all of
 * that. So carry the useful parts of the last conversation forward.
 */
export interface PriorHistory {
  seed: Partial<ConversationContext>;
  lastContactAt: string | null;
}

const CARRY_FORWARD: (keyof ConversationContext)[] = [
  'customer_name',
  'mattress_size',
  'firmness',
  'sleeping_position',
  'mattress_type',
  'delivery_zip',
];

export async function getPriorHistory(
  db: SupabaseClient,
  leadId: string,
  excludeConversationId?: string
): Promise<PriorHistory | null> {
  const { data: prior } = await db
    .from('conversations')
    .select('id, context, updated_at, created_at')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false })
    .limit(5);

  if (!prior || prior.length === 0) return null;

  const previous = prior.filter((c) => c.id !== excludeConversationId);
  if (previous.length === 0) return null;

  // Merge oldest-first so the most recent conversation wins on conflicts.
  const seed: Partial<ConversationContext> = {};
  for (const conv of [...previous].reverse()) {
    const ctx = (conv.context || {}) as ConversationContext;
    for (const key of CARRY_FORWARD) {
      const value = ctx[key];
      if (value !== null && value !== undefined && value !== '') {
        (seed as Record<string, unknown>)[key] = value;
      }
    }
  }

  if (Object.keys(seed).length === 0) return null;

  return {
    seed,
    lastContactAt: previous[0].updated_at || previous[0].created_at || null,
  };
}

/** One line for the prompt describing what we already know. */
export function describePriorHistory(seed: Partial<ConversationContext>, lastContactAt: string | null): string {
  const known: string[] = [];
  if (seed.mattress_size) known.push(`${String(seed.mattress_size).replace(/_/g, ' ')} size`);
  if (seed.firmness) known.push(`${String(seed.firmness).replace(/_/g, ' ')} feel`);
  if (seed.sleeping_position) known.push(`${seed.sleeping_position} sleeper`);
  if (seed.mattress_type) known.push(String(seed.mattress_type).replace(/_/g, ' '));

  let when = '';
  if (lastContactAt) {
    const days = Math.floor((Date.now() - new Date(lastContactAt).getTime()) / 86400000);
    if (days <= 0) when = ' earlier today';
    else if (days === 1) when = ' yesterday';
    else if (days < 30) when = ` about ${days} days ago`;
    else when = ' a while back';
  }

  const name = seed.customer_name ? ` with ${seed.customer_name}` : '';
  const details = known.length > 0 ? ` They were looking at a ${known.join(', ')}.` : '';
  return `RETURNING CUSTOMER: you already spoke${name}${when}.${details} Do NOT introduce the store as if this is first contact and do NOT re-ask what you already know above — greet them like someone you remember, confirm briefly that it is still what they are after, and pick up from there.`;
}

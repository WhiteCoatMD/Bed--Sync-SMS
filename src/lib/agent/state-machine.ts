import type { AgentState, ConversationContext } from '../types';

/**
 * Valid state transitions for the agent.
 * From each state, lists which states the agent can move to.
 */
const TRANSITIONS: Record<AgentState, AgentState[]> = {
  greeting: ['qualifying', 'handed_off'],
  qualifying: ['qualifying', 'recommending', 'objection_handling', 'handed_off', 'follow_up', 'lost'],
  recommending: ['recommending', 'objection_handling', 'closing', 'qualifying', 'handed_off', 'follow_up'],
  objection_handling: ['recommending', 'qualifying', 'closing', 'handed_off', 'follow_up', 'lost'],
  closing: ['closing', 'converted', 'objection_handling', 'recommending', 'handed_off', 'follow_up', 'lost'],
  follow_up: ['qualifying', 'recommending', 'closing', 'handed_off', 'lost'],
  handed_off: ['qualifying', 'recommending', 'closing'], // only when human resumes AI
  converted: [], // terminal
  lost: [], // terminal
};

export function canTransition(from: AgentState, to: AgentState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function getValidTransitions(from: AgentState): AgentState[] {
  return TRANSITIONS[from] || [];
}

/**
 * Determine the appropriate next state based on context completeness.
 */
export function suggestNextState(
  current: AgentState,
  context: ConversationContext
): AgentState {
  // If we have enough qualification data, move to recommending
  const hasSize = !!context.mattress_size;
  const hasBudget = context.budget_min !== null || context.budget_max !== null;
  const hasFirmness = !!context.firmness;
  const hasNeedSignal = !!(context.sleeping_position || context.mattress_type);

  if (current === 'greeting') {
    return 'qualifying';
  }

  if (current === 'qualifying') {
    // Need at least size + (budget or firmness) to recommend
    if (hasSize && (hasBudget || hasFirmness || hasNeedSignal)) {
      return 'recommending';
    }
    return 'qualifying';
  }

  if (current === 'recommending') {
    // If recommendations have been shown, try closing
    if (context.recommendations_shown.length > 0) {
      return 'closing';
    }
    return 'recommending';
  }

  return current;
}

/**
 * Calculate qualification completeness as a percentage.
 */
export function qualificationCompleteness(context: ConversationContext): number {
  const fields = [
    context.customer_name,
    context.mattress_size,
    context.budget_min || context.budget_max,
    context.firmness,
    context.urgency,
  ];
  const filled = fields.filter(Boolean).length;
  return Math.round((filled / fields.length) * 100);
}

/**
 * Check if a handoff should be triggered based on context signals.
 */
export function shouldAutoHandoff(
  context: ConversationContext,
  leadScore: number,
  messageText: string
): { handoff: boolean; reason: string | null } {
  const lower = messageText.toLowerCase();

  // Manager/human request
  if (/\b(manager|supervisor|human|real person|speak to someone|talk to someone)\b/.test(lower)) {
    return { handoff: true, reason: 'Customer requested human contact' };
  }

  // Angry/frustrated signals
  if (/\b(terrible|worst|scam|rip.?off|lawsuit|attorney|bbb|report|awful)\b/.test(lower)) {
    return { handoff: true, reason: 'Customer appears frustrated/angry' };
  }

  // Ready to buy now (explicit purchase intent)
  if (/\b(buy now|purchase|take it|i.?ll take|ready to buy|want to buy|credit card|pay now)\b/.test(lower)) {
    return { handoff: true, reason: 'Customer ready to purchase - hot lead' };
  }

  // High score + active buying/visit intent (score alone is not enough)
  const hasBuyingIntent =
    context.urgency === 'immediate' ||
    /\b(come in|come by|stop by|visit|want to see it|want to try|want to come|on my way|heading over|can i come)\b/.test(lower);

  if (leadScore >= 80 && hasBuyingIntent) {
    return { handoff: true, reason: 'High lead score with buying intent - hot lead' };
  }

  // Very high score alone (90+) — strong signal even without explicit message
  if (leadScore >= 90) {
    return { handoff: true, reason: 'Very high lead score - hot lead' };
  }

  return { handoff: false, reason: null };
}

/**
 * Check if a hot lead alert should be sent to the dealer.
 * Triggers when score crosses 60 threshold (but below 80 handoff).
 * Returns the alert message, or null if no alert needed.
 */
export function checkHotLeadAlert(
  previousScore: number,
  newScore: number,
  context: ConversationContext
): string | null {
  const HOT_LEAD_THRESHOLD = 60;

  // Only alert when crossing the threshold upward, and not already at handoff level
  if (previousScore < HOT_LEAD_THRESHOLD && newScore >= HOT_LEAD_THRESHOLD && newScore < 80) {
    const name = context.customer_name || 'A customer';
    const details: string[] = [];

    if (context.mattress_size) details.push(context.mattress_size);
    if (context.budget_max) details.push(`~$${context.budget_max} budget`);
    if (context.firmness) details.push(context.firmness);

    const detailStr = details.length > 0 ? ` Looking for: ${details.join(', ')}.` : '';

    return `[BedSync AI] Hot prospect! ${name} is showing strong interest. Score: ${newScore}.${detailStr}`;
  }

  return null;
}

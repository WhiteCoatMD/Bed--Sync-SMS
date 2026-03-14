import type { ConversationContext, QualificationData, MattressSize, Firmness, MattressType } from '../../types';

/**
 * Extract qualification data from a customer message.
 * This provides structured extraction as a supplement to the LLM.
 */
export function extractQualificationSignals(
  message: string
): Partial<QualificationData> {
  const lower = message.toLowerCase();
  const updates: Partial<QualificationData> = {};

  // Size detection
  const sizeMap: Record<string, MattressSize> = {
    'twin xl': 'twin_xl',
    'twin': 'twin',
    'full': 'full',
    'double': 'full',
    'queen': 'queen',
    'king': 'king',
    'cal king': 'cal_king',
    'california king': 'cal_king',
    'split king': 'split_king',
  };
  for (const [keyword, size] of Object.entries(sizeMap)) {
    if (lower.includes(keyword)) {
      updates.mattress_size = size;
      break;
    }
  }

  // Budget detection
  const budgetMatch = lower.match(/\$\s*(\d{2,4})/g);
  if (budgetMatch) {
    const amounts = budgetMatch.map((m) => parseInt(m.replace(/\D/g, '')));
    if (amounts.length === 1) {
      updates.budget_max = amounts[0];
    } else if (amounts.length >= 2) {
      updates.budget_min = Math.min(...amounts);
      updates.budget_max = Math.max(...amounts);
    }
  }
  // "under X" or "around X"
  const underMatch = lower.match(/(?:under|below|less than|max|at most|around|about)\s*\$?\s*(\d{3,4})/);
  if (underMatch) {
    updates.budget_max = parseInt(underMatch[1]);
  }

  // Firmness detection
  const firmnessMap: Record<string, Firmness> = {
    'extra firm': 'extra_firm',
    'very firm': 'extra_firm',
    'medium firm': 'medium_firm',
    'medium-firm': 'medium_firm',
    'medium soft': 'medium_soft',
    'medium-soft': 'medium_soft',
    'firm': 'firm',
    'soft': 'soft',
    'medium': 'medium',
    'plush': 'soft',
  };
  for (const [keyword, firmness] of Object.entries(firmnessMap)) {
    if (lower.includes(keyword)) {
      updates.firmness = firmness;
      break;
    }
  }

  // Mattress type detection
  const typeMap: Record<string, MattressType> = {
    'memory foam': 'memory_foam',
    'hybrid': 'hybrid',
    'innerspring': 'innerspring',
    'spring': 'innerspring',
    'latex': 'latex',
    'adjustable': 'adjustable',
    'pillow top': 'pillow_top',
    'gel': 'gel_foam',
    'gel foam': 'gel_foam',
  };
  for (const [keyword, type] of Object.entries(typeMap)) {
    if (lower.includes(keyword)) {
      updates.mattress_type = type;
      break;
    }
  }

  // Sleep position
  if (/\b(side sleeper|sleep on.* side|side)\b/.test(lower)) {
    updates.sleeping_position = 'side';
  } else if (/\b(back sleeper|sleep on.* back|back)\b/.test(lower) && lower.includes('sleep')) {
    updates.sleeping_position = 'back';
  } else if (/\b(stomach sleeper|sleep on.* stomach|stomach)\b/.test(lower)) {
    updates.sleeping_position = 'stomach';
  } else if (/\b(combo|all positions|every position)\b/.test(lower)) {
    updates.sleeping_position = 'combo';
  }

  // Financing interest
  if (/\b(financ|payment plan|monthly payment|pay over time|layaway|credit)\b/.test(lower)) {
    updates.financing_interest = true;
  }

  // Urgency
  if (/\b(today|tonight|asap|urgent|right now|immediately|this week)\b/.test(lower)) {
    updates.urgency = 'immediate';
  } else if (/\b(this month|soon|next week|couple weeks)\b/.test(lower)) {
    updates.urgency = 'soon';
  } else if (/\b(just looking|browsing|no rush|not in a hurry|few months)\b/.test(lower)) {
    updates.urgency = 'browsing';
  }

  // Delivery
  const zipMatch = lower.match(/\b(\d{5})\b/);
  if (zipMatch && !budgetMatch) {
    updates.delivery_zip = zipMatch[1];
  }

  // Trade-in
  if (/\b(trade.?in|old mattress|swap|exchange|take.* old)\b/.test(lower)) {
    updates.trade_in = true;
  }

  return updates;
}

/**
 * Merge new qualification signals into existing context.
 * Only overwrites null/undefined fields unless force=true.
 */
export function mergeContext(
  existing: ConversationContext,
  updates: Partial<ConversationContext>
): ConversationContext {
  const merged = { ...existing };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined && value !== null) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }

  return merged;
}

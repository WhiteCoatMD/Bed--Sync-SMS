import type {
  InventoryItem,
  ConversationContext,
  ProductRecommendation,
} from '../../types';

/**
 * Score and rank inventory items against customer needs.
 * Returns top 3 recommendations with explanations.
 */
export function generateRecommendations(
  items: InventoryItem[],
  context: ConversationContext,
  maxResults: number = 3
): ProductRecommendation[] {
  if (items.length === 0) return [];

  const scored = items.map((item) => ({
    item,
    score: scoreItem(item, context),
  }));

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, maxResults).map((s, i) => ({
    inventory_id: s.item.id,
    product_name: `${s.item.brand} ${s.item.model}${s.item.series ? ' ' + s.item.series : ''}`,
    size: formatSize(s.item.size),
    price: s.item.sale_price || s.item.price,
    sale_price: s.item.sale_price || undefined,
    firmness: s.item.firmness || 'varies',
    type: s.item.type || 'mattress',
    why_it_fits: buildReason(s.item, context),
    call_to_action: buildCta(s.item, context, i),
    promotion: s.item.promotion || undefined,
    financing_eligible: s.item.financing_eligible,
  }));
}

function scoreItem(item: InventoryItem, ctx: ConversationContext): number {
  let score = 50; // base

  const effectivePrice = item.sale_price || item.price;

  // Size match (critical)
  if (ctx.mattress_size && item.size === ctx.mattress_size) {
    score += 30;
  }

  // Budget match
  if (ctx.budget_max && effectivePrice <= ctx.budget_max) {
    score += 20;
    // Bonus for being well within budget
    if (effectivePrice <= ctx.budget_max * 0.8) score += 5;
  }
  if (ctx.budget_min && effectivePrice >= ctx.budget_min) {
    score += 5;
  }
  // Penalty for over budget
  if (ctx.budget_max && effectivePrice > ctx.budget_max) {
    score -= 15;
  }

  // Firmness match
  if (ctx.firmness && item.firmness === ctx.firmness) {
    score += 15;
  }
  // Adjacent firmness (medium_soft for soft, etc.)
  if (ctx.firmness && item.firmness && isAdjacentFirmness(ctx.firmness, item.firmness)) {
    score += 8;
  }

  // Type match
  if (ctx.mattress_type && item.type === ctx.mattress_type) {
    score += 10;
  }

  // On sale bonus
  if (item.sale_price) {
    score += 10;
  }

  // Promotion bonus
  if (item.promotion) {
    score += 5;
  }

  // Financing eligible bonus (if customer interested)
  if (ctx.financing_interest && item.financing_eligible) {
    score += 10;
  }

  // Sleep position → firmness alignment bonus
  if (ctx.sleeping_position && item.firmness) {
    const positionFirmnessMap: Record<string, string[]> = {
      side: ['soft', 'medium_soft', 'medium'],
      back: ['medium', 'medium_firm'],
      stomach: ['firm', 'medium_firm', 'extra_firm'],
      combo: ['medium', 'medium_firm', 'hybrid'],
    };
    const idealFirmness = positionFirmnessMap[ctx.sleeping_position];
    if (idealFirmness?.includes(item.firmness)) {
      score += 12;
    }
  }

  // Sleep position → type alignment bonus
  if (ctx.sleeping_position && item.type) {
    const positionTypeMap: Record<string, string[]> = {
      side: ['memory_foam', 'hybrid', 'pillow_top'],
      back: ['hybrid', 'latex', 'innerspring'],
      stomach: ['innerspring', 'hybrid', 'latex'],
      combo: ['hybrid', 'latex'],
    };
    const idealTypes = positionTypeMap[ctx.sleeping_position];
    if (idealTypes?.includes(item.type)) {
      score += 8;
    }
  }

  // In stock with good quantity
  if (item.quantity > 1) score += 3;

  return score;
}

function isAdjacentFirmness(a: string, b: string): boolean {
  const scale = ['soft', 'medium_soft', 'medium', 'medium_firm', 'firm', 'extra_firm'];
  const ai = scale.indexOf(a);
  const bi = scale.indexOf(b);
  return ai >= 0 && bi >= 0 && Math.abs(ai - bi) === 1;
}

function formatSize(size: string): string {
  const map: Record<string, string> = {
    twin: 'Twin',
    twin_xl: 'Twin XL',
    full: 'Full',
    queen: 'Queen',
    king: 'King',
    cal_king: 'Cal King',
    split_king: 'Split King',
  };
  return map[size] || size;
}

function buildReason(item: InventoryItem, ctx: ConversationContext): string {
  const reasons: string[] = [];
  const effectivePrice = item.sale_price || item.price;

  if (ctx.mattress_size && item.size === ctx.mattress_size) {
    reasons.push(`right size (${formatSize(item.size)})`);
  }

  if (ctx.budget_max && effectivePrice <= ctx.budget_max) {
    reasons.push('within your budget');
  }

  if (ctx.firmness && item.firmness === ctx.firmness) {
    reasons.push(`${item.firmness.replace('_', '-')} firmness you wanted`);
  }

  if (item.sale_price) {
    const savings = item.price - item.sale_price;
    reasons.push(`$${savings.toFixed(0)} off right now`);
  }

  if (ctx.sleeping_position && item.firmness) {
    const positionFirmnessMap: Record<string, string[]> = {
      side: ['soft', 'medium_soft', 'medium'],
      back: ['medium', 'medium_firm'],
      stomach: ['firm', 'medium_firm', 'extra_firm'],
      combo: ['medium', 'medium_firm'],
    };
    const ideal = positionFirmnessMap[ctx.sleeping_position];
    if (ideal?.includes(item.firmness)) {
      reasons.push(`great for ${ctx.sleeping_position} sleepers`);
    }
  } else if (ctx.sleeping_position) {
    reasons.push(`good for ${ctx.sleeping_position} sleepers`);
  }

  if (reasons.length === 0) {
    reasons.push('great value and quality');
  }

  return reasons.slice(0, 3).join(', ');
}

function buildCta(
  item: InventoryItem,
  ctx: ConversationContext,
  rank: number
): string {
  if (item.sale_price) {
    return `This one's on sale - want me to hold it for you?`;
  }
  if (ctx.financing_interest && item.financing_eligible) {
    return `Financing available on this one. Want to see monthly payment options?`;
  }
  if (rank === 0) {
    return `This is my top pick for you. Want to come see it in person?`;
  }
  return `Interested in this one? I can tell you more or set up a time to try it.`;
}

/**
 * Format recommendations as an SMS-friendly message.
 */
export function formatRecommendationsForSms(
  recs: ProductRecommendation[]
): string {
  if (recs.length === 0) {
    return "I couldn't find an exact match in our current stock. Let me connect you with someone who can help find what you need.";
  }

  const lines = recs.map((r, i) => {
    const priceStr = r.sale_price
      ? `$${r.sale_price} (was $${r.price})`
      : `$${r.price}`;
    return `${i + 1}. ${r.product_name}\n   ${r.size} | ${r.firmness} | ${priceStr}\n   ${r.why_it_fits}`;
  });

  return `Here are my top picks for you:\n\n${lines.join('\n\n')}\n\nWhich one catches your eye?`;
}

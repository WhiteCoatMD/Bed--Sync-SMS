import { getServiceClient } from '../../supabase';
import type { InventoryItem, InventorySearchParams } from '../../types';

/**
 * Search dealer inventory with filters.
 * Returns matching items sorted by relevance (sale items first, then by price).
 */
export async function searchInventory(
  params: InventorySearchParams
): Promise<InventoryItem[]> {
  const db = getServiceClient();

  let query = db
    .from('inventory')
    .select('*')
    .eq('dealer_id', params.dealer_id)
    .eq('in_stock', params.in_stock_only !== false); // default to in-stock only

  if (params.size) {
    query = query.eq('size', params.size);
  }

  if (params.firmness) {
    // Match neighbouring firmnesses too. A stomach sleeper derives "firm" and a
    // side sleeper "medium_soft", but plenty of catalogs only stock
    // soft/medium/firm — an exact match there returns nothing and the agent is
    // left with no products to show.
    query = query.in('firmness', nearbyFirmness(params.firmness));
  }

  if (params.type) {
    // The column is constrained to snake_case values ('memory_foam'), but the
    // model emits natural language ('Memory Foam'). Normalise before matching.
    query = query.ilike('type', params.type.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  }

  if (params.brand) {
    query = query.ilike('brand', `%${params.brand}%`);
  }

  if (params.min_price !== undefined) {
    // Use sale_price if available, otherwise price
    query = query.or(
      `price.gte.${params.min_price},sale_price.gte.${params.min_price}`
    );
  }

  if (params.max_price !== undefined) {
    // Match on the effective price (sale_price takes precedence)
    query = query.or(
      `and(sale_price.is.null,price.lte.${params.max_price}),sale_price.lte.${params.max_price}`
    );
  }

  query = query
    .order('sale_price', { ascending: true, nullsFirst: false })
    .order('price', { ascending: true })
    .limit(20);

  const { data, error } = await query;

  if (error) {
    console.error('[Inventory] Search error:', error);
    return [];
  }

  const items = (data as InventoryItem[]) || [];

  // Firmness and type are usually inferred rather than asked for. If they
  // filtered everything out, fall back to size alone rather than handing the
  // agent an empty catalog — with nothing to show it stalls on "let me pull
  // those up" instead of recommending.
  if (items.length === 0 && (params.firmness || params.type)) {
    console.log('[Inventory] No match with inferred filters — retrying on size only');
    return searchInventory({
      dealer_id: params.dealer_id,
      size: params.size,
      min_price: params.min_price,
      max_price: params.max_price,
      in_stock_only: params.in_stock_only,
    });
  }

  return items;
}

/** Firmness values close enough to still be worth showing. */
function nearbyFirmness(firmness: string): string[] {
  const neighbours: Record<string, string[]> = {
    soft: ['soft', 'medium_soft'],
    medium_soft: ['medium_soft', 'soft', 'medium'],
    medium: ['medium', 'medium_soft', 'medium_firm'],
    medium_firm: ['medium_firm', 'medium', 'firm'],
    firm: ['firm', 'medium_firm', 'extra_firm'],
    extra_firm: ['extra_firm', 'firm'],
  };
  return neighbours[firmness] || [firmness];
}

/**
 * Get a single inventory item by ID.
 */
export async function getInventoryItem(
  itemId: string
): Promise<InventoryItem | null> {
  const db = getServiceClient();
  const { data, error } = await db
    .from('inventory')
    .select('*')
    .eq('id', itemId)
    .single();

  if (error) return null;
  return data as InventoryItem;
}

/**
 * Format inventory for the LLM context.
 */
export function formatInventoryForAgent(items: InventoryItem[]): string {
  if (items.length === 0) {
    return 'No matching products found in inventory.';
  }

  return items
    .map((item, i) => {
      const effectivePrice = item.sale_price || item.price;
      const priceStr = !effectivePrice || effectivePrice === 0
        ? 'Price: Contact us'
        : item.sale_price
          ? `$${item.sale_price} (was $${item.price})`
          : `$${item.price}`;

      return [
        `[${i + 1}] ${item.brand} ${item.model}${item.series ? ' ' + item.series : ''}`,
        `   Size: ${item.size} | Firmness: ${item.firmness || 'N/A'} | Type: ${item.type || 'N/A'}`,
        `   Price: ${priceStr}`,
        item.promotion ? `   Promo: ${item.promotion}` : null,
        item.financing_eligible ? `   Financing available` : null,
        item.features?.length ? `   Features: ${item.features.join(', ')}` : null,
        `   In stock: ${item.quantity} available`,
        `   ID: ${item.id}`,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');
}

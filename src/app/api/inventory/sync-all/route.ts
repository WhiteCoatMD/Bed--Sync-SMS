import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';

/**
 * GET /api/inventory/sync-all
 * Cron job: syncs inventory from BedSync for all active dealers.
 * Runs every 6 hours.
 */
export async function GET(req: NextRequest) {
  // Verify cron secret
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getServiceClient();
  const bedsyncUrl = process.env.BEDSYNC_API_URL || 'https://admin.bed-sync.com';
  const apiKey = process.env.BEDSYNC_API_KEY;

  if (!apiKey) {
    return NextResponse.json({ error: 'BEDSYNC_API_KEY not set' }, { status: 500 });
  }

  // Get all active dealers with a bedsync_user_id
  const { data: dealers, error: dealerError } = await db
    .from('dealers')
    .select('id, bedsync_user_id, business_name')
    .eq('active', true)
    .not('bedsync_user_id', 'is', null);

  if (dealerError || !dealers) {
    return NextResponse.json({ error: 'Failed to fetch dealers' }, { status: 500 });
  }

  const results: { dealer: string; synced: number; error?: string }[] = [];

  for (const dealer of dealers) {
    try {
      const res = await fetch(
        `${bedsyncUrl}/api/admin/sms-inventory?user_id=${dealer.bedsync_user_id}`,
        { headers: { 'x-api-key': apiKey } }
      );

      if (!res.ok) {
        results.push({ dealer: dealer.business_name, synced: 0, error: `HTTP ${res.status}` });
        continue;
      }

      const data = await res.json();
      if (!data.success) {
        results.push({ dealer: dealer.business_name, synced: 0, error: 'API error' });
        continue;
      }

      const items = data.inventory || [];

      // Clear existing inventory
      await db.from('inventory').delete().eq('dealer_id', dealer.id);

      if (items.length > 0) {
        const mapped = items.map((item: Record<string, unknown>) => ({
          dealer_id: dealer.id,
          brand: item.brand || (item.title as string || '').split(' ')[0] || 'Unknown',
          model: item.title || item.serial_number || 'Unknown',
          series: item.series || null,
          size: mapSize(item.size_display as string),
          firmness: mapFirmness(item.feel as string),
          type: null,
          price: parseFloat(String(item.price || 0)),
          sale_price: null,
          msrp: null,
          in_stock: item.auto_status !== 'sold',
          quantity: 1,
          features: [],
          description: null,
          financing_eligible: true,
          promotion: null,
          sku: item.serial_number || null,
          building_serial: item.serial_number || null,
        }));

        await db.from('inventory').insert(mapped);
      }

      results.push({ dealer: dealer.business_name, synced: items.length });
    } catch (err: any) {
      results.push({ dealer: dealer.business_name, synced: 0, error: err.message });
    }
  }

  console.log('[Inventory Sync-All]', JSON.stringify(results));

  return NextResponse.json({
    success: true,
    dealers_synced: results.length,
    results,
  });
}

function mapSize(size: string | null | undefined): string {
  if (!size) return 'queen';
  const s = size.toLowerCase().replace(/[^a-z]/g, '');
  if (s.includes('twin') && s.includes('xl')) return 'twin_xl';
  if (s.includes('twin')) return 'twin';
  if (s.includes('full') || s.includes('double')) return 'full';
  if (s.includes('cal') && s.includes('king')) return 'cal_king';
  if (s.includes('split') && s.includes('king')) return 'split_king';
  if (s.includes('king')) return 'king';
  if (s.includes('queen')) return 'queen';
  return 'queen';
}

function mapFirmness(firmness: string | null | undefined): string | null {
  if (!firmness) return null;
  const f = firmness.toLowerCase();
  if (f.includes('extra') && f.includes('firm')) return 'extra_firm';
  if (f.includes('medium') && f.includes('firm')) return 'medium_firm';
  if (f.includes('medium') && f.includes('soft')) return 'medium_soft';
  if (f.includes('firm')) return 'firm';
  if (f.includes('medium')) return 'medium';
  if (f.includes('soft') || f.includes('plush')) return 'soft';
  return null;
}

import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';

/**
 * POST /api/inventory/sync
 * Pulls inventory from main Bed Sync and syncs to Supabase.
 * Called by: cron, admin dashboard, or on-demand.
 * Secured by BEDSYNC_API_KEY or dealer auth.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { dealer_id } = body;

    // Auth: accept either API key or dealer auth token
    const apiKey = req.headers.get('x-api-key');
    const authToken = req.headers.get('authorization')?.replace('Bearer ', '');
    let authorized = false;

    if (apiKey && apiKey === process.env.BEDSYNC_API_KEY) {
      authorized = true;
    } else if (authToken && dealer_id) {
      // Verify dealer auth token against main BedSync
      try {
        const bedsyncUrl = process.env.BEDSYNC_API_URL || 'https://www.bed-sync.com';
        const verifyRes = await fetch(`${bedsyncUrl}/api/auth/me`, {
          headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (verifyRes.ok) {
          const verifyData = await verifyRes.json();
          if (verifyData.user) authorized = true;
        }
      } catch { /* auth failed */ }
    }

    if (!authorized) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!dealer_id) {
      return NextResponse.json({ error: 'dealer_id required' }, { status: 400 });
    }

    const db = getServiceClient();

    // Get dealer to find bedsync_user_id
    const { data: dealer, error: dealerError } = await db
      .from('dealers')
      .select('id, bedsync_user_id, business_name')
      .eq('id', dealer_id)
      .single();

    if (dealerError || !dealer || !dealer.bedsync_user_id) {
      return NextResponse.json({ error: 'Dealer not found or not linked to Bed Sync' }, { status: 404 });
    }

    // Fetch inventory from main Bed Sync
    const bedsyncUrl = process.env.BEDSYNC_API_URL || 'https://www.bed-sync.com';

    // Fetch dealer info from quiz config to keep address, phone, website up to date
    try {
      const profileRes = await fetch(
        `${bedsyncUrl}/api/quiz/config?dealer=${dealer.bedsync_user_id}`,
        { headers: { 'x-api-key': process.env.BEDSYNC_API_KEY! } }
      );
      if (profileRes.ok) {
        const profileData = await profileRes.json();
        const branding = profileData.branding || {};
        const settingsUpdate: Record<string, unknown> = {};
        if (branding.address) {
          settingsUpdate.store_address = branding.address;
        }
        if (branding.phone) {
          settingsUpdate.store_phone = branding.phone;
        }
        if (branding.website) {
          settingsUpdate.store_website = branding.website;
        }
        if (Object.keys(settingsUpdate).length > 0) {
          const { data: currentDealer } = await db
            .from('dealers')
            .select('settings')
            .eq('id', dealer_id)
            .single();
          await db
            .from('dealers')
            .update({ settings: { ...(currentDealer?.settings || {}), ...settingsUpdate } })
            .eq('id', dealer_id);
          console.log('[Inventory Sync] Updated dealer info from quiz config:', Object.keys(settingsUpdate));
        }
      }
    } catch (profileErr) {
      // Non-fatal — inventory sync continues regardless
      console.warn('[Inventory Sync] Could not fetch dealer profile:', profileErr);
    }

    const inventoryRes = await fetch(
      `${bedsyncUrl}/api/admin/sms-inventory?user_id=${dealer.bedsync_user_id}`,
      { headers: { 'x-api-key': process.env.BEDSYNC_API_KEY! } }
    );

    if (!inventoryRes.ok) {
      return NextResponse.json({ error: 'Failed to fetch inventory from Bed Sync' }, { status: 502 });
    }

    const inventoryData = await inventoryRes.json();
    if (!inventoryData.success) {
      return NextResponse.json({ error: 'Bed Sync inventory error' }, { status: 502 });
    }

    const items = inventoryData.inventory || [];

    // Keep the dealer's lead-alert number in step with the main app. Leads the
    // agent creates itself (someone texting in cold) have no main-app request to
    // carry it, so it has to live on the dealer record.
    if (inventoryData.notify_phone) {
      try {
        const { data: current } = await db.from('dealers').select('settings').eq('id', dealer_id).single();
        const settings = (current?.settings || {}) as Record<string, unknown>;
        if (settings.lead_notify_phone !== inventoryData.notify_phone) {
          await db.from('dealers')
            .update({ settings: { ...settings, lead_notify_phone: inventoryData.notify_phone } })
            .eq('id', dealer_id);
          console.log('[Inventory Sync] Updated lead alert number for dealer', dealer_id);
        }
      } catch (notifyErr) {
        console.warn('[Inventory Sync] Could not store lead alert number:', notifyErr);
      }
    }

    // Clear existing inventory for this dealer
    await db.from('inventory').delete().eq('dealer_id', dealer_id);

    // Map Bed Sync buildings to SMS inventory format and insert
    if (items.length > 0) {
      const mapped = items.map((item: Record<string, unknown>) => ({
        dealer_id,
        brand: item.brand || 'Unknown',
        model: item.title || item.serial_number || 'Unknown',
        series: item.series || null,
        size: mapSize(item.size_display as string),
        firmness: mapFirmness(item.feel as string),
        type: mapType(item.type_name as string),
        price: parseFloat(String(item.price || 0)),
        sale_price: null,
        msrp: null,
        in_stock: item.auto_status !== 'sold',
        quantity: 1,
        features: [],
        description: (item.notes as string) || null,
        image_url: (item.image_url as string) || null,
        financing_eligible: true,
        promotion: null,
        sku: item.serial_number || null,
        building_serial: item.serial_number || null,
      }));

      const { error: insertError } = await db.from('inventory').insert(mapped);
      if (insertError) {
        console.error('[Inventory Sync] Insert error:', insertError);
        return NextResponse.json({ error: 'Failed to insert inventory', details: insertError.message }, { status: 500 });
      }
    }

    return NextResponse.json({
      success: true,
      synced: items.length,
      dealer: dealer.business_name,
    });

  } catch (err) {
    console.error('[Inventory Sync] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
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

function mapType(type: string | null | undefined): string | null {
  if (!type) return null;
  const t = type.toLowerCase();
  if (t.includes('hybrid')) return 'hybrid';
  // Euro top is a pillow-top construction, and it is common in real catalogs —
  // without this it fell through to null.
  if (t.includes('euro') || t.includes('pillow')) return 'pillow_top';
  // Check gel before the generic "foam" test, or "Gel Foam" lands on memory_foam.
  if (t.includes('gel')) return 'gel_foam';
  if (t.includes('memory') || t.includes('foam')) return 'memory_foam';
  if (t.includes('latex')) return 'latex';
  if (t.includes('innerspring') || t.includes('coil')) return 'innerspring';
  if (t.includes('pillow')) return 'pillow_top';
  if (t.includes('gel')) return 'gel_foam';
  if (t.includes('adjust')) return 'adjustable';
  return null;
}

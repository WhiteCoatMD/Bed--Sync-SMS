import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';

/**
 * POST /api/auth/verify
 * Validates a Bed Sync JWT token and returns the linked dealer_id.
 * Called by the SMS admin frontend to authenticate.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { token } = body;

    if (!token) {
      return NextResponse.json({ error: 'Token required' }, { status: 400 });
    }

    // Validate token against the main Bed Sync API
    const bedsyncUrl = process.env.BEDSYNC_API_URL || 'https://www.bed-sync.com';
    const verifyRes = await fetch(`${bedsyncUrl}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!verifyRes.ok) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    }

    const userData = await verifyRes.json();
    if (!userData.success || !userData.user) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    }

    const bedsyncUserId = userData.user.id;
    const bedsyncUser = userData.user;

    // Look up linked dealer
    const db = getServiceClient();
    const { data: dealer } = await db
      .from('dealers')
      .select('id, business_name, active, settings')
      .eq('bedsync_user_id', bedsyncUserId)
      .eq('active', true)
      .single();

    if (!dealer) {
      return NextResponse.json({ error: 'No SMS account linked', bedsync_user_id: bedsyncUserId }, { status: 404 });
    }

    // Sync store info from main BedSync dashboard into dealer settings
    const currentSettings = (dealer.settings || {}) as Record<string, unknown>;
    const settingsUpdate: Record<string, unknown> = {};
    if (bedsyncUser.address && bedsyncUser.address !== currentSettings.store_address) {
      settingsUpdate.store_address = bedsyncUser.address;
    }
    if (bedsyncUser.phone && bedsyncUser.phone !== currentSettings.store_phone) {
      settingsUpdate.store_phone = bedsyncUser.phone;
    }

    if (Object.keys(settingsUpdate).length > 0) {
      const merged = { ...currentSettings, ...settingsUpdate };
      await db.from('dealers').update({ settings: merged }).eq('id', dealer.id);
      console.log('[Auth Verify] Synced store info from BedSync:', settingsUpdate);
    }

    return NextResponse.json({
      success: true,
      dealer_id: dealer.id,
      business_name: dealer.business_name,
      bedsync_user_id: bedsyncUserId,
    });

  } catch (err) {
    console.error('[Auth Verify] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

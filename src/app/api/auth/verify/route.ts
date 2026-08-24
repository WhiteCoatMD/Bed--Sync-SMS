import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';

/**
 * POST /api/auth/verify
 * Validates a Bed Sync JWT token and returns the linked dealer_id.
 * Called by the SMS admin frontend to authenticate.
 *
 * Super-admin dealer switcher: if the caller is a Bed Sync super-admin
 * (is_admin) and passes a `dealer_id`, we return THAT dealer instead of the
 * one linked to their own account — this lets a super-admin open any dealer's
 * SMS dashboard (regular, MBA demo, etc.). Store-info sync is skipped in that
 * case so the admin's own profile never overwrites the viewed dealer's info.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { token, dealer_id: requestedDealerId } = body;

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
    const isAdmin = !!bedsyncUser.is_admin;

    const db = getServiceClient();

    // Super-admins can view any active dealer by id (the dealer switcher).
    // Everyone else resolves to the dealer linked to their own account.
    const viewingAsAdmin = Boolean(isAdmin && requestedDealerId);
    let dealer: { id: string; business_name: string; active: boolean; settings: unknown } | null = null;

    if (viewingAsAdmin) {
      const { data } = await db
        .from('dealers')
        .select('id, business_name, active, settings')
        .eq('id', requestedDealerId)
        .eq('active', true)
        .single();
      dealer = data;
    } else {
      const { data } = await db
        .from('dealers')
        .select('id, business_name, active, settings')
        .eq('bedsync_user_id', bedsyncUserId)
        .eq('active', true)
        .single();
      dealer = data;
    }

    if (!dealer) {
      return NextResponse.json(
        {
          error: viewingAsAdmin ? 'Dealer not found' : 'No SMS account linked',
          bedsync_user_id: bedsyncUserId,
        },
        { status: 404 }
      );
    }

    // Sync store info from the logged-in user's BedSync dashboard into dealer
    // settings — ONLY when viewing your OWN dealer. Never when a super-admin is
    // viewing another dealer (would clobber that dealer's real store info).
    if (!viewingAsAdmin) {
      try {
        const currentSettings = (dealer.settings || {}) as Record<string, unknown>;
        const settingsUpdate: Record<string, unknown> = {};
        if (typeof bedsyncUser.address === 'string' && bedsyncUser.address && bedsyncUser.address !== currentSettings.store_address) {
          settingsUpdate.store_address = bedsyncUser.address;
        }
        if (typeof bedsyncUser.phone === 'string' && bedsyncUser.phone && bedsyncUser.phone !== currentSettings.store_phone) {
          settingsUpdate.store_phone = bedsyncUser.phone;
        }

        if (Object.keys(settingsUpdate).length > 0) {
          const merged = { ...currentSettings, ...settingsUpdate };
          await db.from('dealers').update({ settings: merged }).eq('id', dealer.id);
          console.log('[Auth Verify] Synced store info from BedSync:', settingsUpdate);
        }
      } catch (syncErr) {
        console.error('[Auth Verify] Store info sync error:', syncErr);
      }
    }

    // Usage rides along on the call the dashboard already makes, so the strip
    // needs no second request and inherits this route's authentication rather
    // than exposing a dealer's numbers on a bare dealer_id.
    let usage = null;
    try {
      const { getCostState } = await import('@/lib/cost');
      const state = await getCostState(dealer.id);
      usage = {
        conversations_used: state.conversationsUsed,
        conversations_included: state.conversationsIncluded,
        accepting_new: state.canStartConversation,
        period_start: state.periodStart,
      };
    } catch (usageErr) {
      console.error('[Auth Verify] Usage lookup failed:', usageErr);
    }

    return NextResponse.json({
      success: true,
      dealer_id: dealer.id,
      business_name: dealer.business_name,
      bedsync_user_id: bedsyncUserId,
      viewing_as_admin: viewingAsAdmin,
      usage,
      // The store's own timezone. Appointment times must be shown in it —
      // that is when the customer walks in, and what the agent told them.
      timezone: (dealer.settings as { timezone?: string } | null)?.timezone || 'America/Chicago',
    });

  } catch (err) {
    console.error('[Auth Verify] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

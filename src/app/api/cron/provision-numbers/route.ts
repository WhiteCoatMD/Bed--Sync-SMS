/**
 * Give dealers their own local number once the 10DLC campaign is approved.
 *
 * A dealer who signs up while registration is still pending starts on the
 * shared toll-free line — sendAndTrack falls back to TELNYX_PHONE_NUMBER when a
 * dealer has no number of their own, so they can text customers from day one
 * instead of waiting on a carrier review.
 *
 * This job closes that gap afterwards: when the campaign goes live it buys each
 * of those dealers a local number in their own area code, registers it to the
 * campaign, and stores it. From then on their messages come from their number
 * rather than the shared one. Nothing about the dealer's experience changes
 * except the caller ID improving.
 *
 * It spends money ($1 per number), so it is deliberately conservative: it does
 * nothing at all until the campaign is actually approved, skips demo records,
 * and provisions at most a few per run.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';
import { telnyxRequest } from '@/lib/telnyx';
import { provisionLocalNumber } from '@/lib/telnyx-provisioning';

/** Bought per run, so a bad state cannot drain the Telnyx balance in one go. */
const MAX_PER_RUN = 5;

/** Fall back to the shared line's own area code if a dealer has no location. */
const DEFAULT_AREA_CODE = '833';

function areaCodeFor(dealer: any): string | null {
  // Prefer the store's own phone: a local number matching the store the
  // customer is being connected to is the whole point.
  const candidates = [dealer.settings?.store_phone, dealer.owner_phone];
  for (const c of candidates) {
    const digits = String(c || '').replace(/\D/g, '');
    const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
    if (national.length === 10) return national.slice(0, 3);
  }
  return null;
}

export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const campaignId = process.env.TELNYX_10DLC_CAMPAIGN_ID;
  if (!campaignId) {
    return NextResponse.json({ ok: true, skipped: 'TELNYX_10DLC_CAMPAIGN_ID not set' });
  }

  // Do nothing until the campaign can actually accept numbers. Buying them
  // first would leave dealers holding numbers that cannot send, which is the
  // exact failure this whole area already suffered once.
  let campaignReady = false;
  try {
    const c = await telnyxRequest(`/10dlc/campaign/${campaignId}`);
    const failures = Array.isArray(c?.failureReasons) ? c.failureReasons.length : 0;
    campaignReady = c?.status === 'ACTIVE' && failures === 0;
    if (!campaignReady) {
      return NextResponse.json({
        ok: true,
        waiting: true,
        campaignStatus: c?.status ?? 'unknown',
        openFindings: failures,
      });
    }
  } catch (err: any) {
    console.error('[Provision] campaign check failed:', err.message);
    return NextResponse.json({ ok: false, error: 'campaign check failed' }, { status: 200 });
  }

  const db = getServiceClient();
  const { data: dealers } = await db
    .from('dealers')
    .select('id, business_name, owner_phone, settings, twilio_phone, active')
    .eq('active', true)
    .is('twilio_phone', null);

  const pending = (dealers || []).filter((d: any) => d.settings?.demo !== true);
  const results: any[] = [];

  for (const dealer of pending.slice(0, MAX_PER_RUN)) {
    const areaCode = areaCodeFor(dealer) || DEFAULT_AREA_CODE;
    try {
      const r = await provisionLocalNumber(
        dealer.id,
        areaCode,
        process.env.NEXT_PUBLIC_APP_URL || 'https://sms.bed-sync.com'
      );
      results.push({
        dealer: dealer.business_name,
        areaCode,
        ...r,
      });
      console.log(
        `[Provision] ${dealer.business_name}: ${r.success ? r.phoneNumber : 'FAILED ' + r.error}` +
          (r.success && !r.campaignAssigned ? ' (NOT campaign-registered)' : '')
      );
    } catch (err: any) {
      results.push({ dealer: dealer.business_name, success: false, error: err.message });
      console.error(`[Provision] ${dealer.business_name} threw:`, err.message);
    }
  }

  return NextResponse.json({
    ok: true,
    campaignReady,
    pending: pending.length,
    provisioned: results.filter((r) => r.success).length,
    remaining: Math.max(0, pending.length - results.length),
    results,
  });
}

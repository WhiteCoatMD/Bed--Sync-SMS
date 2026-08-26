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
import { provisionLocalNumber } from '@/lib/telnyx-provisioning';
import { resolveUsableCampaign } from '@/lib/10dlc';

/** Bought per run, so a bad state cannot drain the Telnyx balance in one go. */
const MAX_PER_RUN = 5;

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

  // Do nothing until a campaign can actually accept numbers. Buying them first
  // would leave dealers holding numbers that cannot send, which is the exact
  // failure this whole area already suffered once.
  const resolution = await resolveUsableCampaign();
  if (!resolution.ok) {
    console.log('[Provision] waiting:', resolution.reason);
    return NextResponse.json({ ok: true, waiting: true, reason: resolution.reason });
  }
  const campaignReady = true;

  const db = getServiceClient();
  const { data: dealers } = await db
    .from('dealers')
    .select('id, business_name, owner_phone, settings, twilio_phone, active')
    .eq('active', true)
    .is('twilio_phone', null);

  const pending = (dealers || []).filter((d: any) => d.settings?.demo !== true);
  const results: any[] = [];

  for (const dealer of pending.slice(0, MAX_PER_RUN)) {
    // 833 is a toll-free prefix, so the old fallback searched for a local
    // number in an area code that cannot have one. A dealer with no phone on
    // file is reported instead, so somebody can go and fill it in.
    const areaCode = areaCodeFor(dealer);
    if (!areaCode) {
      results.push({
        dealer: dealer.business_name,
        success: false,
        error: 'no store or owner phone on file, so no area code to buy in',
      });
      continue;
    }
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

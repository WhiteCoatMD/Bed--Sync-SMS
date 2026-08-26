import { telnyxRequest, TelnyxApiError } from './telnyx';
import { getServiceClient } from './supabase';
import { resolveUsableCampaign } from './10dlc';

interface ProvisionResult {
  success: boolean;
  phoneNumber?: string;
  id?: string;
  error?: string;
  /**
   * Whether the number was registered to the 10DLC campaign. A number without
   * this cannot send to US mobiles: carriers drop unregistered long-code
   * traffic. Reported separately from success so a number that was bought but
   * is not yet able to send cannot be mistaken for a working one -- which is
   * exactly how a batch of unusable numbers went unnoticed before.
   */
  campaignAssigned?: boolean;
  campaignError?: string;
}

/**
 * Register a purchased long code to the 10DLC campaign.
 *
 * Retried: the number order settles asynchronously, so an assignment attempted
 * the instant the order returns can arrive before the number exists.
 *
 * campaignId is optional so the cron's gate decision can be threaded through:
 * when the cron already resolved a usable campaign to decide whether to spend
 * at all, this must use that exact id rather than resolving a second time. Two
 * independent resolves of the same in-flight campaigns can disagree on a blip
 * (a lookup failure skips a campaign), silently landing the number assignment
 * on a different campaign than the one the gate approved. When no campaignId
 * is supplied (other callers), this resolves on its own as before.
 */
async function assignToCampaign(
  phoneNumber: string,
  campaignId?: string
): Promise<{ ok: boolean; error?: string }> {
  if (!campaignId) {
    // Not the env var directly: with two filings pending, the usable one is
    // whichever the carriers cleared, and that is only knowable by asking.
    const resolution = await resolveUsableCampaign();
    if (!resolution.ok) return { ok: false, error: resolution.reason };
    campaignId = resolution.campaignId;
  }

  let last = '';
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await telnyxRequest('/10dlc/phone_number_campaigns', 'POST', {
        phoneNumber,
        campaignId,
      });
      return { ok: true };
    } catch (err: any) {
      last = err?.message || String(err);
      // 10036 means the campaign is still in carrier review -- that will not
      // resolve itself in the next few seconds, and retrying just burns all 5
      // attempts' worth of backoff (minutes) on a serverless cron run for
      // nothing. Stop immediately instead of pattern-matching the message.
      if (err instanceof TelnyxApiError && err.hasCode('10036')) break;
      // Nothing to wait for if the campaign itself is unusable.
      if (/expired|unusable|not found/i.test(last)) break;
      await new Promise((r) => setTimeout(r, attempt * 4000));
    }
  }
  return { ok: false, error: last };
}

/** Wait for an ordered number to actually exist on the account. */
async function waitForNumber(phoneNumber: string): Promise<boolean> {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await telnyxRequest(
        `/phone_numbers?filter[phone_number]=${encodeURIComponent(phoneNumber)}`
      );
      if ((res.data || []).some((n: any) => n.phone_number === phoneNumber)) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 5000));
  }
  return false;
}

/**
 * Search for and purchase a local Telnyx number matching the dealer's area code.
 * Falls back to any US number if no local match.
 */
export async function provisionLocalNumber(
  dealerId: string,
  areaCode: string,
  webhookBaseUrl: string,
  campaignId?: string
): Promise<ProvisionResult> {
  const webhookUrl = `${webhookBaseUrl}/api/telnyx/inbound`;

  try {
    // 1. Search for available numbers with the requested area code
    let searchResult = await telnyxRequest(
      `/available_phone_numbers?filter[country_code]=US&filter[national_destination_code]=${areaCode}&filter[features][]=sms&filter[limit]=5`
    );

    let available = searchResult.data || [];

    // 2. Fallback: if no numbers in that area code, try any US number
    if (available.length === 0) {
      searchResult = await telnyxRequest(
        `/available_phone_numbers?filter[country_code]=US&filter[features][]=sms&filter[limit]=5`
      );
      available = searchResult.data || [];
    }

    if (available.length === 0) {
      return { success: false, error: 'No SMS-capable numbers available' };
    }

    // 3. Purchase the first available number
    const chosen = available[0];
    const orderResult = await telnyxRequest('/number_orders', 'POST', {
      phone_numbers: [{ phone_number: chosen.phone_number }],
      messaging_profile_id: process.env.TELNYX_MESSAGING_PROFILE_ID || undefined,
      connection_id: process.env.TELNYX_CONNECTION_ID || undefined,
    });

    const purchasedNumber = chosen.phone_number;

    // 4. The order settles asynchronously; wait for the number to be real
    //    before doing anything that depends on it existing.
    await waitForNumber(purchasedNumber);

    // 5. Register it to the 10DLC campaign. Without this the number is bought
    //    and configured but silently cannot deliver to US mobiles.
    const campaign = await assignToCampaign(purchasedNumber, campaignId);
    if (!campaign.ok) {
      console.error(
        `[Telnyx] ${purchasedNumber} is NOT registered to a 10DLC campaign and cannot send: ${campaign.error}`
      );
    }

    // 6. Save to dealer record -- ONLY when the campaign assignment actually
    //    succeeded. sendAndTrack resolves the sending number as
    //    dealer.twilio_phone || TELNYX_PHONE_NUMBER, so writing twilio_phone
    //    here unconditionally would move a dealer OFF the shared toll-free
    //    line (which works today) and ONTO a freshly bought long code that
    //    carriers silently drop because it isn't campaign-registered. The
    //    shared line is the safe fallback and must not be given up for a
    //    number that cannot send. On failure we still hand back the purchased
    //    number (campaignAssigned: false) so it can be assigned later, but we
    //    leave the dealer row untouched.
    if (campaign.ok) {
      const db = getServiceClient();
      await db
        .from('dealers')
        .update({ twilio_phone: purchasedNumber })
        .eq('id', dealerId);
    }

    console.log(
      `[Telnyx] Provisioned ${purchasedNumber} for dealer ${dealerId}` +
        (campaign.ok
          ? ' (registered to campaign)'
          : ' (NOT campaign-registered - cannot send; dealer left on shared line)')
    );

    return {
      success: true,
      phoneNumber: purchasedNumber,
      id: orderResult.data?.id,
      campaignAssigned: campaign.ok,
      campaignError: campaign.ok ? undefined : campaign.error,
    };
  } catch (err: any) {
    console.error('[Telnyx] Provisioning error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Release a Telnyx number when a dealer cancels.
 */
export async function releaseNumber(phoneNumber: string): Promise<boolean> {
  try {
    // Find the number in Telnyx
    const result = await telnyxRequest(
      `/phone_numbers?filter[phone_number]=${encodeURIComponent(phoneNumber)}`
    );

    const numbers = result.data || [];
    if (numbers.length > 0) {
      await telnyxRequest(`/phone_numbers/${numbers[0].id}`, 'DELETE');
      console.log(`[Telnyx] Released ${phoneNumber}`);
      return true;
    }

    return false;
  } catch (err) {
    console.error('[Telnyx] Release error:', err);
    return false;
  }
}

/**
 * Update the messaging profile for an existing number.
 */
export async function updateWebhook(
  phoneNumber: string,
  _webhookBaseUrl: string
): Promise<boolean> {
  try {
    // In Telnyx, webhooks are configured at the messaging profile level,
    // not per-number. If needed, update the messaging profile instead.
    const result = await telnyxRequest(
      `/phone_numbers?filter[phone_number]=${encodeURIComponent(phoneNumber)}`
    );

    const numbers = result.data || [];
    if (numbers.length > 0 && process.env.TELNYX_MESSAGING_PROFILE_ID) {
      await telnyxRequest(`/phone_numbers/${numbers[0].id}`, 'PATCH', {
        messaging_profile_id: process.env.TELNYX_MESSAGING_PROFILE_ID,
      });
      return true;
    }

    return false;
  } catch (err) {
    console.error('[Telnyx] Webhook update error:', err);
    return false;
  }
}

import { telnyxRequest } from './telnyx';
import { getServiceClient } from './supabase';

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
 */
async function assignToCampaign(phoneNumber: string): Promise<{ ok: boolean; error?: string }> {
  const campaignId = process.env.TELNYX_10DLC_CAMPAIGN_ID;
  if (!campaignId) return { ok: false, error: 'TELNYX_10DLC_CAMPAIGN_ID is not set' };

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
  webhookBaseUrl: string
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
    const campaign = await assignToCampaign(purchasedNumber);
    if (!campaign.ok) {
      console.error(
        `[Telnyx] ${purchasedNumber} is NOT registered to a 10DLC campaign and cannot send: ${campaign.error}`
      );
    }

    // 6. Save to dealer record
    const db = getServiceClient();
    await db
      .from('dealers')
      .update({ twilio_phone: purchasedNumber })
      .eq('id', dealerId);

    console.log(
      `[Telnyx] Provisioned ${purchasedNumber} for dealer ${dealerId}` +
        (campaign.ok ? ' (registered to campaign)' : ' (NOT campaign-registered - cannot send)')
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

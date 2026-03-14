import { getTwilioClient } from './twilio';
import { getServiceClient } from './supabase';

interface ProvisionResult {
  success: boolean;
  phoneNumber?: string;
  sid?: string;
  error?: string;
}

/**
 * Search for and purchase a local Twilio number matching the dealer's area code.
 * Falls back to same state, then any US number if no local match.
 */
export async function provisionLocalNumber(
  dealerId: string,
  areaCode: string,
  webhookBaseUrl: string
): Promise<ProvisionResult> {
  const client = getTwilioClient();
  const webhookUrl = `${webhookBaseUrl}/api/twilio/inbound`;

  try {
    // 1. Search for available local numbers with the requested area code
    let available = await client.availablePhoneNumbers('US')
      .local.list({
        areaCode: parseInt(areaCode),
        smsEnabled: true,
        limit: 5,
      });

    // 2. Fallback: if no numbers in that area code, try nearby
    if (available.length === 0) {
      // Try the state by using the area code's first digit pattern
      available = await client.availablePhoneNumbers('US')
        .local.list({
          smsEnabled: true,
          limit: 5,
        });
    }

    if (available.length === 0) {
      return { success: false, error: 'No SMS-capable numbers available' };
    }

    // 3. Purchase the first available number
    const chosen = available[0];
    const purchased = await client.incomingPhoneNumbers.create({
      phoneNumber: chosen.phoneNumber,
      smsUrl: webhookUrl,
      smsMethod: 'POST',
      friendlyName: `BedSync AI - ${dealerId.slice(0, 8)}`,
    });

    // 4. Save to dealer record
    const db = getServiceClient();
    await db
      .from('dealers')
      .update({ twilio_phone: purchased.phoneNumber })
      .eq('id', dealerId);

    console.log(`[Twilio] Provisioned ${purchased.phoneNumber} for dealer ${dealerId}`);

    return {
      success: true,
      phoneNumber: purchased.phoneNumber,
      sid: purchased.sid,
    };
  } catch (err: any) {
    console.error('[Twilio] Provisioning error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Release a Twilio number when a dealer cancels.
 */
export async function releaseNumber(phoneNumber: string): Promise<boolean> {
  const client = getTwilioClient();

  try {
    const numbers = await client.incomingPhoneNumbers.list({
      phoneNumber,
      limit: 1,
    });

    if (numbers.length > 0) {
      await client.incomingPhoneNumbers(numbers[0].sid).remove();
      console.log(`[Twilio] Released ${phoneNumber}`);
      return true;
    }

    return false;
  } catch (err) {
    console.error('[Twilio] Release error:', err);
    return false;
  }
}

/**
 * Update the webhook URL for an existing number.
 * Useful when the app URL changes (e.g., new Vercel deployment).
 */
export async function updateWebhook(
  phoneNumber: string,
  webhookBaseUrl: string
): Promise<boolean> {
  const client = getTwilioClient();
  const webhookUrl = `${webhookBaseUrl}/api/twilio/inbound`;

  try {
    const numbers = await client.incomingPhoneNumbers.list({
      phoneNumber,
      limit: 1,
    });

    if (numbers.length > 0) {
      await client.incomingPhoneNumbers(numbers[0].sid).update({
        smsUrl: webhookUrl,
        smsMethod: 'POST',
      });
      return true;
    }

    return false;
  } catch (err) {
    console.error('[Twilio] Webhook update error:', err);
    return false;
  }
}

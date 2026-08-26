import { telnyxRequest, TelnyxApiError } from './telnyx';
import { getServiceClient } from './supabase';
import { messageCost, recordCost } from './cost';

const TELNYX_MESSAGING_PROFILE_ID = process.env.TELNYX_MESSAGING_PROFILE_ID;

/**
 * Telnyx codes that mean the destination will never accept a message. Retrying
 * one of these is pointless and re-charging for it is wrong. Kept deliberately
 * short: mis-classifying a temporary failure as permanent would mark a real
 * customer's working number as bad, which is worse than trying again.
 */
const PERMANENT_DESTINATION_CODES = ['10002'];

export interface SendFailure {
  /** True when the number itself is the problem, not the attempt. */
  permanent: boolean;
  code: string | null;
  detail: string;
}

export interface SendResult {
  id: string | null;
  failure?: SendFailure;
}

export async function sendSms(
  to: string,
  body: string,
  from?: string,
  mediaUrls?: string[]
): Promise<SendResult> {
  // Sanitize the source number: env vars can carry a stray newline/space when
  // pasted (TELNYX_PHONE_NUMBER has had a trailing "\n"), which Telnyx rejects
  // as an invalid source number (error 10004). Keep only digits and a leading +.
  const fromNumber = (from || process.env.TELNYX_PHONE_NUMBER || '').replace(/[^\d+]/g, '');

  try {
    const isMms = mediaUrls && mediaUrls.length > 0;
    console.log(`[${isMms ? 'MMS' : 'SMS'}] Sending from ${fromNumber} to ${formatPhone(to)}: ${body.substring(0, 50)}...`);
    const payload: Record<string, unknown> = {
      from: fromNumber,
      to: formatPhone(to),
      text: body,
      ...(TELNYX_MESSAGING_PROFILE_ID ? { messaging_profile_id: TELNYX_MESSAGING_PROFILE_ID } : {}),
    };
    if (isMms) {
      payload.media_urls = mediaUrls;
      payload.type = 'MMS';
    }
    const data = await telnyxRequest('/messages', 'POST', payload);
    console.log(`[${isMms ? 'MMS' : 'SMS'}] Sent successfully: ${data.data?.id}`);
    return { id: data.data?.id || null };
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error('[SMS] Send error:', detail);

    // A failure used to be swallowed and reported as `null`, indistinguishable
    // from "nothing to send" — so callers billed for it and recorded it as
    // delivered. The reason now comes back with it.
    if (err instanceof TelnyxApiError) {
      const code = err.codes[0] || null;
      return {
        id: null,
        failure: {
          permanent: err.codes.some((c) => PERMANENT_DESTINATION_CODES.includes(c)),
          code,
          detail,
        },
      };
    }
    return { id: null, failure: { permanent: false, code: null, detail } };
  }
}

/**
 * Mark the lead behind a conversation as unreachable by text.
 *
 * Carriers reject a number that does not exist every single time, so the flag
 * is what stops the schedulers from queueing follow-ups and reminders into a
 * void, and it is what the dashboard reads to tell the dealer to pick up the
 * phone instead. Best-effort: a failure to record this must never turn into a
 * failure of the send path that called it.
 */
async function flagLeadPhoneInvalid(conversationId: string, failure: SendFailure): Promise<void> {
  const db = getServiceClient();
  try {
    const { data: conv } = await db
      .from('conversations')
      .select('lead_id')
      .eq('id', conversationId)
      .maybeSingle();
    if (!conv?.lead_id) return;

    await db
      .from('leads')
      .update({
        phone_invalid: true,
        phone_invalid_reason: failure.detail.slice(0, 500),
        phone_invalid_at: new Date().toISOString(),
      })
      .eq('id', conv.lead_id);

    console.warn(`[SMS] lead ${conv.lead_id} marked phone_invalid: ${failure.code}`);
  } catch (e) {
    console.error('[SMS] could not flag invalid phone:', (e as Error).message);
  }
}

/**
 * Send SMS using the dealer's own provisioned number,
 * record the message, and track usage.
 */
export async function sendAndTrack(
  dealerId: string,
  conversationId: string,
  to: string,
  body: string,
  sender: 'agent' | 'human' = 'agent',
  mediaUrls?: string[]
): Promise<string | null> {
  // Nothing goes to a number that has texted STOP. Enforced here rather than at
  // each call site because every agent reply, follow-up and reminder funnels
  // through this one function — a guard anywhere else would eventually be
  // bypassed by a new code path. sendSms() stays unguarded on purpose so the
  // opt-out confirmation itself can still be delivered.
  const { isOptedOut } = await import('@/lib/compliance');
  if (await isOptedOut(to)) {
    console.log('[Compliance] suppressed send to opted-out number ' + to);
    return null;
  }

  const db = getServiceClient();

  // Look up the dealer's provisioned phone number
  const { data: dealer } = await db
    .from('dealers')
    .select('twilio_phone')
    .eq('id', dealerId)
    .single();

  // The first message of a conversation carries the opt-out notice. Carriers
  // expect it on the opening message, and a toll-free verification is granted
  // on the promise that it is there. Appended here rather than asked of the
  // model: an LLM drops a standing instruction eventually, and this one is not
  // allowed to be dropped.
  let outboundBody = body;
  try {
    const { count } = await db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', conversationId)
      .eq('direction', 'outbound');
    const isFirstOutbound = (count || 0) === 0;
    if (isFirstOutbound && !/reply stop/i.test(outboundBody)) {
      outboundBody = outboundBody.trimEnd() + ' Reply STOP to opt out.';
    }
  } catch (e) {
    console.error('[Compliance] first-message check failed:', (e as Error).message);
  }

  const fromNumber = dealer?.twilio_phone || process.env.TELNYX_PHONE_NUMBER;
  const { id: messageId, failure } = await sendSms(to, outboundBody, fromNumber || undefined, mediaUrls);

  // Record the attempt either way — an undelivered message is still part of the
  // conversation's history — but say plainly which it was. This row used to be
  // written identically whether the send succeeded or not, so a message that
  // never left looked exactly like one the customer had read.
  await db.from('messages').insert({
    conversation_id: conversationId,
    direction: 'outbound',
    sender,
    // the text actually sent, opt-out notice included, so the record is evidence
    body: outboundBody,
    twilio_sid: messageId,
    metadata: {
      ...(mediaUrls?.length ? { media_urls: mediaUrls } : {}),
      ...(failure
        ? { send_failed: true, failure_code: failure.code, failure_permanent: failure.permanent }
        : {}),
    },
  });

  if (failure) {
    // Never charge for a message that did not go out. recordCost and the usage
    // counters below ran unconditionally before, so a dead number quietly ate a
    // dealer's conversation allowance.
    if (failure.permanent) {
      await flagLeadPhoneInvalid(conversationId, failure);
    }
    console.error(
      `[SMS] not billing ${dealerId} for a failed send to ${to}` +
        (failure.permanent ? ' (number marked invalid)' : ' (transient, will be retried by the caller)')
    );
    return null;
  }

  // Meter what this send actually costs (MMS and multi-segment replies cost
  // several times a short SMS, so counting messages would understate it).
  await recordCost(
    dealerId,
    mediaUrls?.length ? 'mms_out' : 'sms_out',
    messageCost(body, mediaUrls?.length || 0),
    { segments: body.length, media: mediaUrls?.length || 0 }
  );

  // Update conversation message count
  await db.rpc('increment_message_count', { conv_id: conversationId });

  // Track usage
  await db.from('usage_events').insert({
    dealer_id: dealerId,
    event_type: 'sms_sent',
    billing_period: new Date().toISOString().split('T')[0],
  });

  // Atomic increment dealer messages_used
  await db.rpc('increment_messages_used', { d_id: dealerId });

  return messageId;
}

function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (phone.startsWith('+')) return phone;
  return `+${digits}`;
}

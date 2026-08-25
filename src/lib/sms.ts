import { telnyxRequest } from './telnyx';
import { getServiceClient } from './supabase';
import { messageCost, recordCost } from './cost';

const TELNYX_MESSAGING_PROFILE_ID = process.env.TELNYX_MESSAGING_PROFILE_ID;

export async function sendSms(
  to: string,
  body: string,
  from?: string,
  mediaUrls?: string[]
): Promise<string | null> {
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
    return data.data?.id || null;
  } catch (err: any) {
    console.error('[SMS] Send error:', err?.message || err);
    return null;
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

  const fromNumber = dealer?.twilio_phone || process.env.TELNYX_PHONE_NUMBER;
  const messageId = await sendSms(to, body, fromNumber || undefined, mediaUrls);

  // Record message
  await db.from('messages').insert({
    conversation_id: conversationId,
    direction: 'outbound',
    sender,
    body,
    twilio_sid: messageId,
    metadata: mediaUrls?.length ? { media_urls: mediaUrls } : {},
  });

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

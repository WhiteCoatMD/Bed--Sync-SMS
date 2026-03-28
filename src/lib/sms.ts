import { telnyxRequest } from './telnyx';
import { getServiceClient } from './supabase';

const TELNYX_MESSAGING_PROFILE_ID = process.env.TELNYX_MESSAGING_PROFILE_ID;

export async function sendSms(
  to: string,
  body: string,
  from?: string
): Promise<string | null> {
  const fromNumber = from || process.env.TELNYX_PHONE_NUMBER!;

  try {
    console.log(`[SMS] Sending from ${fromNumber} to ${formatPhone(to)}: ${body.substring(0, 50)}...`);
    const data = await telnyxRequest('/messages', 'POST', {
      from: fromNumber,
      to: formatPhone(to),
      text: body,
      ...(TELNYX_MESSAGING_PROFILE_ID ? { messaging_profile_id: TELNYX_MESSAGING_PROFILE_ID } : {}),
    });
    console.log(`[SMS] Sent successfully: ${data.data?.id}`);
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
  sender: 'agent' | 'human' = 'agent'
): Promise<string | null> {
  const db = getServiceClient();

  // Look up the dealer's provisioned phone number
  const { data: dealer } = await db
    .from('dealers')
    .select('twilio_phone')
    .eq('id', dealerId)
    .single();

  const fromNumber = dealer?.twilio_phone || process.env.TELNYX_PHONE_NUMBER;
  const messageId = await sendSms(to, body, fromNumber || undefined);

  // Record message
  await db.from('messages').insert({
    conversation_id: conversationId,
    direction: 'outbound',
    sender,
    body,
    twilio_sid: messageId, // Keep field name for backward compat
  });

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

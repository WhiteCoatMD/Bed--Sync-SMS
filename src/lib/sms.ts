import { getTwilioClient } from './twilio';
import { getServiceClient } from './supabase';

export async function sendSms(
  to: string,
  body: string,
  from?: string
): Promise<string | null> {
  const client = getTwilioClient();
  const fromNumber = from || process.env.TWILIO_PHONE_NUMBER!;

  try {
    const message = await client.messages.create({
      to: formatPhone(to),
      from: fromNumber,
      body,
    });
    return message.sid;
  } catch (err) {
    console.error('[SMS] Send error:', err);
    return null;
  }
}

/**
 * Send SMS using the dealer's own provisioned Twilio number,
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

  const fromNumber = dealer?.twilio_phone || process.env.TWILIO_PHONE_NUMBER;
  const sid = await sendSms(to, body, fromNumber || undefined);

  // Record message
  await db.from('messages').insert({
    conversation_id: conversationId,
    direction: 'outbound',
    sender,
    body,
    twilio_sid: sid,
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

  return sid;
}

function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (phone.startsWith('+')) return phone;
  return `+${digits}`;
}

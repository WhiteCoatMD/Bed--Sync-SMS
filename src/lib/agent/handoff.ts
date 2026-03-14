import { getServiceClient } from '../supabase';
import type { Conversation, Dealer } from '../types';

/**
 * Trigger a human handoff for a conversation.
 * Updates conversation status and notifies the dealer.
 */
export async function triggerHandoff(
  conversation: Conversation,
  dealer: Dealer,
  reason: string
): Promise<void> {
  const db = getServiceClient();

  // Update conversation
  await db
    .from('conversations')
    .update({
      status: 'handed_off',
      agent_state: 'handed_off',
      handed_off_at: new Date().toISOString(),
      handed_off_reason: reason,
      next_follow_up_at: null, // cancel any pending follow-ups
    })
    .eq('id', conversation.id);

  // Update lead status
  await db
    .from('leads')
    .update({ status: 'handed_off' })
    .eq('id', conversation.lead_id);

  // Cancel pending follow-ups
  await db
    .from('follow_ups')
    .update({ status: 'cancelled' })
    .eq('conversation_id', conversation.id)
    .eq('status', 'pending');

  // Log handoff
  await db.from('agent_logs').insert({
    conversation_id: conversation.id,
    action: 'handoff',
    details: { reason, dealer_notified: !!dealer.owner_phone },
  });

  // Notify dealer owner via SMS if configured
  if (dealer.settings.handoff_phone || dealer.owner_phone) {
    const notifyPhone = dealer.settings.handoff_phone || dealer.owner_phone;
    try {
      const { sendSms } = await import('../sms');
      const lead = await db
        .from('leads')
        .select('phone, customer_name')
        .eq('id', conversation.lead_id)
        .single();

      const leadName = lead.data?.customer_name || 'A customer';
      const leadPhone = lead.data?.phone || 'unknown';

      await sendSms(
        notifyPhone!,
        `[BedSync AI] Handoff needed!\n${leadName} (${leadPhone})\nReason: ${reason}\nView in dashboard to respond.`,
        dealer.twilio_phone || undefined
      );
    } catch (err) {
      console.error('[Handoff] Notification error:', err);
    }
  }
}

/**
 * Resume AI control of a handed-off conversation.
 */
export async function resumeAi(
  conversationId: string,
  resumeState: string = 'qualifying'
): Promise<void> {
  const db = getServiceClient();

  await db
    .from('conversations')
    .update({
      status: 'active',
      agent_state: resumeState,
      handed_off_at: null,
      handed_off_reason: null,
    })
    .eq('id', conversationId);

  await db.from('agent_logs').insert({
    conversation_id: conversationId,
    action: 'resume',
    details: { resumed_to_state: resumeState },
  });
}

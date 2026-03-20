import { getServiceClient } from '../supabase';
import type { Conversation, Dealer, ConversationContext, Lead } from '../types';

/**
 * Build a detailed conversation summary for the dealer on handoff.
 */
function buildHandoffSummary(
  lead: { customer_name: string | null; phone: string; lead_score: number },
  context: ConversationContext,
  reason: string
): string {
  const lines: string[] = [
    `[BedSync AI] Handoff Summary`,
    `---`,
    `Customer: ${lead.customer_name || 'Unknown'}`,
    `Phone: ${lead.phone}`,
    `Lead Score: ${lead.lead_score}/100`,
    `Handoff Reason: ${reason}`,
  ];

  // What they're looking for
  const lookingFor: string[] = [];
  if (context.mattress_size) lookingFor.push(context.mattress_size);
  if (context.mattress_type) lookingFor.push(context.mattress_type);
  if (context.firmness) lookingFor.push(context.firmness);
  if (lookingFor.length > 0) {
    lines.push(`Looking for: ${lookingFor.join(', ')}`);
  }

  if (context.budget_min || context.budget_max) {
    const min = context.budget_min ? `$${context.budget_min}` : '?';
    const max = context.budget_max ? `$${context.budget_max}` : '?';
    lines.push(`Budget: ${min} - ${max}`);
  }

  if (context.sleeping_position) {
    lines.push(`Sleep position: ${context.sleeping_position}`);
  }

  if (context.urgency) {
    lines.push(`Timeline: ${context.urgency}`);
  }

  if (context.financing_interest) {
    lines.push(`Interested in financing: Yes`);
  }

  if (context.recommendations_shown.length > 0) {
    lines.push(`Products shown: ${context.recommendations_shown.length} items`);
  }

  if (context.objections.length > 0) {
    lines.push(`Objections raised: ${context.objections.join(', ')}`);
  }

  if (context.preferred_next_step) {
    lines.push(`Preferred next step: ${context.preferred_next_step}`);
  }

  lines.push(`---`);
  lines.push(`View full conversation in your BedSync dashboard.`);

  return lines.join('\n');
}

/**
 * Trigger a human handoff for a conversation.
 * Updates conversation status and notifies the dealer with a full summary.
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

  // Notify dealer owner via SMS with full summary
  if (dealer.settings.handoff_phone || dealer.owner_phone) {
    const notifyPhone = dealer.settings.handoff_phone || dealer.owner_phone;
    try {
      const { sendSms } = await import('../sms');
      const lead = await db
        .from('leads')
        .select('phone, customer_name, lead_score')
        .eq('id', conversation.lead_id)
        .single();

      const context = conversation.context as ConversationContext;
      const leadData = {
        customer_name: lead.data?.customer_name || null,
        phone: lead.data?.phone || 'unknown',
        lead_score: lead.data?.lead_score || 0,
      };

      const summary = buildHandoffSummary(leadData, context, reason);

      await sendSms(
        notifyPhone!,
        summary,
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

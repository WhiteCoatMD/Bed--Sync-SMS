import { getServiceClient } from '../supabase';
import { sendEmail, buildHandoffEmailHtml } from '../email';
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

  // Mark handoff request — but keep status active so AI continues answering.
  // Status flips to handed_off only when a human acknowledges in the dashboard.
  await db
    .from('conversations')
    .update({
      handed_off_at: new Date().toISOString(),
      handed_off_reason: reason,
      handoff_acknowledged_at: null,
      next_follow_up_at: null,
    })
    .eq('id', conversation.id);

  // Don't update lead status yet — AI keeps going until human takes over

  // Cancel pending follow-ups (dealer is being notified)
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

  // Load lead data for notifications
  const { data: leadData } = await db
    .from('leads')
    .select('phone, customer_name, lead_score')
    .eq('id', conversation.lead_id)
    .single();

  const context = conversation.context as ConversationContext;
  const lead = {
    customer_name: leadData?.customer_name || null,
    phone: leadData?.phone || 'unknown',
    lead_score: leadData?.lead_score || 0,
  };

  const summary = buildHandoffSummary(lead, context, reason);

  // SMS notification
  if (dealer.settings.handoff_phone || dealer.owner_phone) {
    const notifyPhone = dealer.settings.handoff_phone || dealer.owner_phone;
    try {
      const { sendSms } = await import('../sms');
      await sendSms(notifyPhone!, summary, dealer.twilio_phone || undefined);
    } catch (err) {
      console.error('[Handoff] SMS notification error:', err);
    }
  }

  // Email notification
  const notifyEmail = dealer.owner_email;
  if (notifyEmail) {
    try {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://sms.bed-sync.com';
      const dashboardUrl = `${appUrl}/admin/conversations/${conversation.id}`;

      const lookingFor = [context.mattress_size, context.mattress_type, context.firmness]
        .filter(Boolean).join(', ');
      const budget = context.budget_min || context.budget_max
        ? `$${context.budget_min || '?'} - $${context.budget_max || '?'}`
        : '';

      await sendEmail({
        to: notifyEmail,
        subject: `[BedSync] Handoff needed — ${lead.customer_name || lead.phone} (Score: ${lead.lead_score})`,
        html: buildHandoffEmailHtml({
          businessName: dealer.business_name,
          customerName: lead.customer_name,
          customerPhone: lead.phone,
          leadScore: lead.lead_score,
          reason,
          lookingFor,
          budget,
          sleepPosition: context.sleeping_position || '',
          urgency: context.urgency || '',
          financingInterest: !!context.financing_interest,
          productsShown: context.recommendations_shown?.length || 0,
          objections: context.objections?.join(', ') || '',
          dashboardUrl,
        }),
        text: summary,
      });
    } catch (err) {
      console.error('[Handoff] Email notification error:', err);
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

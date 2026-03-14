import { getServiceClient } from '../supabase';
import { sendAndTrack } from '../sms';
import type { Conversation, DealerSettings, ConversationContext } from '../types';

/**
 * Schedule the next follow-up for a conversation.
 * Uses the dealer's configured delays: e.g. [30, 1440, 4320] minutes.
 */
export async function scheduleFollowUp(
  conversation: Conversation,
  settings: DealerSettings
): Promise<void> {
  if (!settings.follow_up_enabled) return;

  const nextNumber = conversation.follow_up_count + 1;
  if (nextNumber > settings.max_follow_ups) return;

  const delays = settings.follow_up_delays || [30, 1440, 4320];
  const delayMinutes = delays[nextNumber - 1] || delays[delays.length - 1];

  const scheduledAt = new Date(Date.now() + delayMinutes * 60 * 1000);
  const message = getFollowUpMessage(nextNumber, conversation.context as ConversationContext);

  const db = getServiceClient();

  await db.from('follow_ups').insert({
    conversation_id: conversation.id,
    scheduled_at: scheduledAt.toISOString(),
    follow_up_number: nextNumber,
    message,
    status: 'pending',
  });

  await db
    .from('conversations')
    .update({
      status: 'follow_up',
      agent_state: 'follow_up',
      follow_up_count: nextNumber,
      next_follow_up_at: scheduledAt.toISOString(),
    })
    .eq('id', conversation.id);

  await db.from('agent_logs').insert({
    conversation_id: conversation.id,
    action: 'follow_up_scheduled',
    details: { follow_up_number: nextNumber, scheduled_at: scheduledAt.toISOString(), delay_minutes: delayMinutes },
  });
}

/**
 * Process all pending follow-ups that are due.
 * Called by a cron job / scheduled function.
 */
export async function processPendingFollowUps(): Promise<number> {
  const db = getServiceClient();
  let processed = 0;

  const { data: pendingFollowUps } = await db
    .from('follow_ups')
    .select(`
      *,
      conversation:conversations!inner(
        id, lead_id, dealer_id, status, context, follow_up_count,
        lead:leads!inner(phone, customer_name),
        dealer:dealers!inner(id, business_name, twilio_phone, settings)
      )
    `)
    .eq('status', 'pending')
    .lte('scheduled_at', new Date().toISOString())
    .limit(50);

  if (!pendingFollowUps || pendingFollowUps.length === 0) return 0;

  for (const followUp of pendingFollowUps) {
    const conv = followUp.conversation as any;
    if (!conv || conv.status === 'handed_off' || conv.status === 'closed') {
      // Cancel follow-up if conversation is no longer active
      await db.from('follow_ups').update({ status: 'cancelled' }).eq('id', followUp.id);
      continue;
    }

    try {
      const message = followUp.message || getFollowUpMessage(
        followUp.follow_up_number,
        conv.context as ConversationContext
      );

      await sendAndTrack(
        conv.dealer_id,
        conv.id,
        conv.lead.phone,
        message,
        'agent'
      );

      await db.from('follow_ups').update({
        status: 'sent',
        sent_at: new Date().toISOString(),
      }).eq('id', followUp.id);

      await db.from('agent_logs').insert({
        conversation_id: conv.id,
        action: 'follow_up_sent',
        details: { follow_up_number: followUp.follow_up_number },
      });

      // Schedule next follow-up if not at max
      const settings = conv.dealer.settings as DealerSettings;
      if (followUp.follow_up_number < settings.max_follow_ups) {
        const delays = settings.follow_up_delays || [30, 1440, 4320];
        const nextDelay = delays[followUp.follow_up_number] || delays[delays.length - 1];
        const nextScheduled = new Date(Date.now() + nextDelay * 60 * 1000);

        await db.from('follow_ups').insert({
          conversation_id: conv.id,
          scheduled_at: nextScheduled.toISOString(),
          follow_up_number: followUp.follow_up_number + 1,
          message: getFollowUpMessage(followUp.follow_up_number + 1, conv.context),
          status: 'pending',
        });

        await db.from('conversations').update({
          next_follow_up_at: nextScheduled.toISOString(),
          follow_up_count: followUp.follow_up_number + 1,
        }).eq('id', conv.id);
      } else {
        // Max follow-ups reached - mark as lost
        await db.from('conversations').update({
          status: 'closed',
          agent_state: 'lost',
          next_follow_up_at: null,
          closed_at: new Date().toISOString(),
        }).eq('id', conv.id);

        await db.from('leads').update({ status: 'lost' }).eq('id', conv.lead_id);
      }

      processed++;
    } catch (err) {
      console.error('[FollowUp] Error processing:', err);
      await db.from('follow_ups').update({ status: 'failed' }).eq('id', followUp.id);
    }
  }

  return processed;
}

function getFollowUpMessage(
  number: number,
  context: ConversationContext
): string {
  const name = context.customer_name ? ` ${context.customer_name}` : '';

  switch (number) {
    case 1:
      if (context.mattress_size) {
        return `Hey${name}! Just checking in - still looking for that ${context.mattress_size} mattress? Happy to help if you have any questions.`;
      }
      return `Hey${name}! Just wanted to follow up - still looking for a new mattress? I'm here if you need any help.`;

    case 2:
      if (context.recommendations_shown.length > 0) {
        return `Hi${name}, wanted to circle back one more time. Those mattresses I mentioned are still available if you're interested. Any questions I can answer?`;
      }
      return `Hi${name}, just one more check-in. If you're still mattress shopping, I'd love to help you find the right one. No pressure at all!`;

    case 3:
      return `Last follow-up from us${name}! If you need mattress help in the future, just text back anytime. We're always here. Have a great day!`;

    default:
      return `Hey${name}! Still here if you need any mattress help. Just text back anytime!`;
  }
}

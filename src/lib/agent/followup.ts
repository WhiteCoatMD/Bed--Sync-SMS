import { getServiceClient } from '../supabase';
import { sendAndTrack } from '../sms';
import type { Conversation, DealerSettings, ConversationContext } from '../types';

/**
 * Check if the given date falls within the dealer's business hours.
 * Returns the date adjusted to the next business hours window if outside hours.
 */
function adjustToBusinessHours(
  date: Date,
  settings: DealerSettings
): Date {
  const tz = settings.timezone || 'America/Chicago';
  const startHour = parseHour(settings.business_hours_start || '09:00');
  const endHour = parseHour(settings.business_hours_end || '18:00');

  // Convert to dealer's local time
  const localTimeStr = date.toLocaleString('en-US', { timeZone: tz });
  const localDate = new Date(localTimeStr);
  const currentHour = localDate.getHours() + localDate.getMinutes() / 60;

  if (currentHour >= startHour && currentHour < endHour) {
    // Within business hours, no adjustment needed
    return date;
  }

  // Outside business hours - schedule for next business hours window
  const adjusted = new Date(date);
  if (currentHour >= endHour) {
    // Past closing - schedule for tomorrow morning
    adjusted.setDate(adjusted.getDate() + 1);
  }
  // Set to business hours start + 15 min buffer
  const adjustedLocal = new Date(adjusted.toLocaleString('en-US', { timeZone: tz }));
  adjustedLocal.setHours(Math.floor(startHour), (startHour % 1) * 60 + 15, 0, 0);

  // Convert back - calculate the offset
  const offset = adjusted.getTime() - new Date(adjusted.toLocaleString('en-US', { timeZone: tz })).getTime();
  return new Date(adjustedLocal.getTime() + offset);
}

function parseHour(timeStr: string): number {
  const [h, m] = timeStr.split(':').map(Number);
  return h + (m || 0) / 60;
}

/**
 * Schedule the next follow-up for a conversation.
 * Uses the dealer's configured delays: e.g. [30, 1440, 4320] minutes.
 * Respects business hours - delays to next open window if outside hours.
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

  let scheduledAt = new Date(Date.now() + delayMinutes * 60 * 1000);

  // Adjust to business hours if scheduled outside
  scheduledAt = adjustToBusinessHours(scheduledAt, settings);

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

    // Check business hours before sending
    const settings = conv.dealer.settings as DealerSettings;
    const now = new Date();
    const adjustedNow = adjustToBusinessHours(now, settings);
    if (adjustedNow.getTime() - now.getTime() > 60000) {
      // Outside business hours by more than a minute - reschedule
      await db.from('follow_ups').update({
        scheduled_at: adjustedNow.toISOString(),
      }).eq('id', followUp.id);
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
      if (followUp.follow_up_number < settings.max_follow_ups) {
        const delays = settings.follow_up_delays || [30, 1440, 4320];
        const nextDelay = delays[followUp.follow_up_number] || delays[delays.length - 1];
        let nextScheduled = new Date(Date.now() + nextDelay * 60 * 1000);
        nextScheduled = adjustToBusinessHours(nextScheduled, settings);

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

/**
 * Generate contextual follow-up messages based on conversation history.
 * References specific details the customer mentioned for a personal touch.
 */
function getFollowUpMessage(
  number: number,
  context: ConversationContext
): string {
  const name = context.customer_name ? ` ${context.customer_name}` : '';
  const hasSize = !!context.mattress_size;
  const hasBudget = context.budget_max !== null;
  const hasFirmness = !!context.firmness;
  const hasRecommendations = context.recommendations_shown.length > 0;
  const hasUrgency = !!context.urgency;
  const hasFinancing = context.financing_interest === true;

  switch (number) {
    case 1: {
      // First follow-up: reference what they were looking for
      if (hasSize && hasBudget) {
        return `Hey${name}! Still thinking about that ${context.mattress_size} mattress? They had some great options in your ${formatBudget(context.budget_max!)} budget range. Happy to answer any questions!`;
      }
      if (hasSize && hasFirmness) {
        return `Hey${name}! Just checking in on your ${context.mattress_size} mattress search. The ${context.firmness} options I found looked like a great fit for you. Any questions?`;
      }
      if (hasSize) {
        return `Hey${name}! Still on the hunt for that ${context.mattress_size} mattress? I'm here if you have any questions or want to explore more options.`;
      }
      return `Hey${name}! Just checking in - still thinking about a new mattress? I'm here if you need any help narrowing things down.`;
    }

    case 2: {
      // Second follow-up: reference recommendations or specific details
      if (hasRecommendations && hasFinancing) {
        return `Hi${name}, those mattresses I showed you are still available! And just a reminder, they do offer financing options if that helps. Want me to send over more details?`;
      }
      if (hasRecommendations && hasBudget) {
        return `Hi${name}, circling back one more time. The options I recommended in your price range are still in stock. Would you like to come check them out in person?`;
      }
      if (hasRecommendations) {
        return `Hi${name}, wanted to follow up - those mattresses I mentioned are still available. Any questions about them, or would you like to explore different options?`;
      }
      if (hasUrgency) {
        return `Hi${name}, I know you mentioned needing a mattress ${context.urgency}. I'd love to help you find the right one before then. Want to pick up where we left off?`;
      }
      return `Hi${name}, just one more check-in on your mattress search. If you're still looking, I can help you find the perfect fit. No pressure at all!`;
    }

    case 3: {
      // Final follow-up: warm close with specifics
      if (hasSize) {
        return `Last note from us${name}! Whenever you're ready for that ${context.mattress_size} mattress, just text back. We're always here to help. Have a great day!`;
      }
      return `Last follow-up from us${name}! Whenever you need mattress help, just text back anytime. We're always here. Have a great day!`;
    }

    default:
      return `Hey${name}! Still here if you need any mattress help. Just text back anytime!`;
  }
}

function formatBudget(amount: number): string {
  if (amount >= 1000) {
    return `$${(amount / 1000).toFixed(amount % 1000 === 0 ? 0 : 1)}k`;
  }
  return `$${amount}`;
}

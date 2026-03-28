import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';
import { processMessage } from '@/lib/agent/orchestrator';
import { sendAndTrack } from '@/lib/sms';
import { scheduleFollowUp } from '@/lib/agent/followup';
import { triggerHandoff } from '@/lib/agent/handoff';
import { isWithinBusinessHours } from '@/lib/business-hours';
import type { Conversation, Lead, Dealer, Message, DealerSettings } from '@/lib/types';

/**
 * Telnyx inbound SMS webhook.
 * Receives customer messages and routes them through the AI agent.
 */
export async function POST(req: NextRequest) {
  try {
    const payload = await req.json();

    // Telnyx sends events in data.payload format
    const event = payload.data;
    if (!event || event.event_type !== 'message.received') {
      return NextResponse.json({ ok: true });
    }

    const msgPayload = event.payload;
    const from = msgPayload.from?.phone_number;
    const to = msgPayload.to?.[0]?.phone_number;
    const body = msgPayload.text;
    const messageId = msgPayload.id;

    if (!from || !body) {
      return NextResponse.json({ ok: true });
    }

    const db = getServiceClient();

    // Find the dealer by their phone number
    const { data: dealer } = await db
      .from('dealers')
      .select('*')
      .eq('twilio_phone', to)
      .eq('active', true)
      .single();

    if (!dealer) {
      console.error('[Telnyx] No dealer found for number:', to);
      return NextResponse.json({ ok: true });
    }

    // Find or create lead
    const cleanPhone = from.replace(/^\+1/, '').replace(/\D/g, '');
    let { data: lead } = await db
      .from('leads')
      .select('*')
      .eq('dealer_id', dealer.id)
      .or(`phone.eq.${from},phone.eq.${cleanPhone},phone.eq.+1${cleanPhone}`)
      .single();

    if (!lead) {
      const { data: newLead } = await db
        .from('leads')
        .insert({
          dealer_id: dealer.id,
          phone: from,
          source: 'other',
          status: 'new',
        })
        .select()
        .single();
      lead = newLead;
    }

    if (!lead) {
      return NextResponse.json({ ok: true });
    }

    // Find or create conversation
    let { data: conversation } = await db
      .from('conversations')
      .select('*')
      .eq('lead_id', lead.id)
      .in('status', ['active', 'follow_up', 'paused', 'handed_off'])
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (!conversation) {
      const { data: newConv } = await db
        .from('conversations')
        .insert({
          lead_id: lead.id,
          dealer_id: dealer.id,
          status: 'active',
          agent_state: 'greeting',
        })
        .select()
        .single();
      conversation = newConv;
    }

    if (!conversation) {
      return NextResponse.json({ ok: true });
    }

    // Record inbound message
    await db.from('messages').insert({
      conversation_id: conversation.id,
      direction: 'inbound',
      sender: 'customer',
      body,
      twilio_sid: messageId, // Keep field name for backward compat
    });

    // Track usage
    await db.from('usage_events').insert({
      dealer_id: dealer.id,
      event_type: 'sms_received',
      billing_period: new Date().toISOString().split('T')[0],
    });

    // Update message count
    await db
      .from('conversations')
      .update({ message_count: (conversation as Conversation).message_count + 1 })
      .eq('id', conversation.id);

    await db.from('agent_logs').insert({
      conversation_id: conversation.id,
      action: 'message_received',
      details: { from, telnyx_id: messageId },
    });

    // If conversation was in follow_up, reactivate it
    if ((conversation as Conversation).status === 'follow_up') {
      await db
        .from('conversations')
        .update({
          status: 'active',
          next_follow_up_at: null,
        })
        .eq('id', conversation.id);

      await db
        .from('follow_ups')
        .update({ status: 'cancelled' })
        .eq('conversation_id', conversation.id)
        .eq('status', 'pending');

      const { data: refreshed } = await db
        .from('conversations')
        .select('*')
        .eq('id', conversation.id)
        .single();
      if (refreshed) conversation = refreshed;
    }

    // If handed off, just record the message - don't auto-reply
    if ((conversation as Conversation).status === 'handed_off') {
      return NextResponse.json({ ok: true });
    }

    // Check auto-reply setting
    if (!(dealer as Dealer).settings.auto_reply) {
      return NextResponse.json({ ok: true });
    }

    const settings = (dealer as Dealer).settings;
    const isNewConversation = (conversation as Conversation).message_count <= 1;

    // After-hours auto-reply
    if (settings.after_hours_reply !== false && !isWithinBusinessHours(settings)) {
      const afterHoursMsg = settings.after_hours_message ||
        `Thanks for texting ${(dealer as Dealer).business_name}! We're closed right now but we'll get back to you first thing in the morning. In the meantime, feel free to browse our inventory at our website!`;

      if (isNewConversation) {
        await sendAndTrack(
          dealer.id,
          conversation.id,
          from,
          afterHoursMsg,
          'agent'
        );

        await db.from('agent_logs').insert({
          conversation_id: conversation.id,
          action: 'after_hours_reply',
          details: { message: afterHoursMsg },
        });
      }

      return NextResponse.json({ ok: true });
    }

    // Get conversation history
    const { data: messages } = await db
      .from('messages')
      .select('*')
      .eq('conversation_id', conversation.id)
      .order('created_at', { ascending: true })
      .limit(20);

    // Process through agent
    const decision = await processMessage({
      conversation: conversation as Conversation,
      lead: lead as Lead,
      dealer: dealer as Dealer,
      inboundMessage: body,
      recentMessages: (messages || []) as Message[],
    });

    // Send reply
    await sendAndTrack(
      dealer.id,
      conversation.id,
      from,
      decision.reply,
      'agent'
    );

    // Update conversation
    const convUpdate: Record<string, unknown> = {};
    if (decision.new_state) convUpdate.agent_state = decision.new_state;
    if (decision.context_updates) {
      convUpdate.context = {
        ...((conversation as Conversation).context as object),
        ...decision.context_updates,
      };
    }
    if (decision.should_handoff) {
      convUpdate.status = 'handed_off';
    }
    if (Object.keys(convUpdate).length > 0) {
      await db.from('conversations').update(convUpdate).eq('id', conversation.id);
    }

    // Update lead
    const leadUpdate: Record<string, unknown> = {};
    if (decision.qualification_updates) {
      leadUpdate.qualification = {
        ...((lead as Lead).qualification as object),
        ...decision.qualification_updates,
      };
    }
    if (decision.lead_score_delta) {
      leadUpdate.lead_score = Math.max(0, (lead as Lead).lead_score + decision.lead_score_delta);
    }
    if ((lead as Lead).status === 'new') {
      leadUpdate.status = 'qualifying';
    }
    if (Object.keys(leadUpdate).length > 0) {
      await db.from('leads').update(leadUpdate).eq('id', lead.id);
    }

    // Handle handoff
    if (decision.should_handoff) {
      await triggerHandoff(
        conversation as Conversation,
        dealer as Dealer,
        decision.handoff_reason || 'Agent triggered handoff'
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[Telnyx Inbound] Error:', err);
    return NextResponse.json({ ok: true });
  }
}

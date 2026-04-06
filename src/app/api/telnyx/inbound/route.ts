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

    // Check if this customer has an existing conversation (any dealer)
    const cleanFromPhone = from.replace(/^\+1/, '').replace(/\D/g, '');
    const { data: existingLead } = await db
      .from('leads')
      .select('id, dealer_id')
      .or(`phone.eq.${from},phone.eq.${cleanFromPhone},phone.eq.+1${cleanFromPhone}`)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    let dealer: Dealer | null = null;

    if (existingLead) {
      // Route to the dealer from their existing conversation
      const { data: existingDealer } = await db
        .from('dealers')
        .select('*')
        .eq('id', existingLead.dealer_id)
        .eq('active', true)
        .maybeSingle();
      dealer = existingDealer;
    }

    if (!dealer) {
      const { data: allDealers } = await db
        .from('dealers')
        .select('*')
        .eq('active', true);

      if (allDealers) {
        // Check keyword routing
        const keyword = body.trim().split(/\s+/)[0].toUpperCase();
        const keywordDealer = allDealers.find((d: any) => {
          const keywords: string[] = d.settings?.routing_keywords || [];
          return keywords.map((k: string) => k.toUpperCase()).includes(keyword);
        });
        if (keywordDealer) {
          dealer = keywordDealer as Dealer;
        }

        // Check if message contains a dealer name
        if (!dealer) {
          const msgLower = body.toLowerCase().trim();
          const nameMatch = allDealers.find((d: any) => {
            const name = d.business_name.toLowerCase();
            return msgLower.includes(name) || name.includes(msgLower);
          });
          if (nameMatch) {
            dealer = nameMatch as Dealer;
          }
        }
      }
    }

    if (!dealer) {
      // Fall back to matching by dealer's own dedicated number (not shared)
      const sharedNumber = process.env.TELNYX_PHONE_NUMBER?.replace(/\\n/g, '').trim();
      if (to !== sharedNumber) {
        const { data: phoneDealer } = await db
          .from('dealers')
          .select('*')
          .eq('twilio_phone', to)
          .eq('active', true)
          .limit(1)
          .maybeSingle();
        if (phoneDealer) dealer = phoneDealer;
      }
    }

    if (!dealer) {
      // Check if this is an outreach prospect (MBA dealer, etc.) replying
      const { data: prospect } = await db
        .from('outreach_prospects')
        .select('*')
        .or(`phone.eq.${from},phone.eq.${cleanFromPhone},phone.eq.+1${cleanFromPhone}`)
        .maybeSingle();

      if (prospect) {
        // Log the reply on the prospect record
        await db
          .from('outreach_prospects')
          .update({
            status: prospect.status === 'opted_out' ? 'opted_out' : 'replied',
            last_reply: body,
            last_reply_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', prospect.id);

        // Handle STOP opt-out
        if (body.trim().toUpperCase() === 'STOP') {
          await db
            .from('outreach_prospects')
            .update({ status: 'opted_out', updated_at: new Date().toISOString() })
            .eq('id', prospect.id);
          const { sendSms } = await import('@/lib/sms');
          await sendSms(from, 'You have been unsubscribed and will not receive further messages.');
          console.log('[Outreach] Prospect opted out:', prospect.business_name, from);
          return NextResponse.json({ ok: true });
        }

        // Notify Mitch via email about the reply
        try {
          const notifyRes = await fetch(`${process.env.BEDSYNC_API_URL || 'https://bed-sync.com'}/api/super-admin/outreach-reply-notify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prospect_id: prospect.id,
              prospect_name: prospect.name,
              business_name: prospect.business_name,
              phone: from,
              reply: body,
              secret: process.env.INTERNAL_API_SECRET,
            }),
          });
          console.log('[Outreach] Notified BedSync of prospect reply:', notifyRes.status);
        } catch (notifyErr) {
          console.error('[Outreach] Failed to notify BedSync:', notifyErr);
        }

        console.log('[Outreach] Prospect replied:', prospect.business_name, from, body.substring(0, 100));
        return NextResponse.json({ ok: true });
      }

      const { sendSms } = await import('@/lib/sms');
      await sendSms(from, `Hey! Thanks for texting. What mattress store are you trying to reach? Just reply with the store name and I'll connect you.`);
      console.log('[Telnyx] Unknown sender, asked for store name. From:', from, 'Body:', body.substring(0, 50));
      return NextResponse.json({ ok: true });
    }

    // Find or create lead
    const cleanPhone = from.replace(/^\+1/, '').replace(/\D/g, '');
    let { data: lead } = await db
      .from('leads')
      .select('*')
      .eq('dealer_id', dealer.id)
      .or(`phone.eq.${from},phone.eq.${cleanPhone},phone.eq.+1${cleanPhone}`)
      .maybeSingle();

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
        .maybeSingle();
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
      .maybeSingle();

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
        .maybeSingle();
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
        .maybeSingle();
      if (refreshed) conversation = refreshed;
    }

    // Only stop AI replies once a human has actually acknowledged the handoff
    if (
      (conversation as Conversation).status === 'handed_off' &&
      (conversation as Conversation).handoff_acknowledged_at
    ) {
      return NextResponse.json({ ok: true });
    }

    // Check auto-reply setting
    if (!(dealer as Dealer).settings.auto_reply) {
      return NextResponse.json({ ok: true });
    }

    // AI always responds — business hours only affect handoff urgency, not availability

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

    // Send reply (MMS if images available)
    await sendAndTrack(
      dealer.id,
      conversation.id,
      from,
      decision.reply,
      'agent',
      decision.media_urls
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
    // Don't set status to handed_off yet — AI keeps answering until a human acknowledges.
    // The handoff notification (SMS + email) still fires below to alert the dealer.
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

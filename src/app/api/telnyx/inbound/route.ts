import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';
import { processMessage } from '@/lib/agent/orchestrator';
import { verifyTelnyxSignature } from '@/lib/webhook-verify';
import { classifyKeyword, recordOptOut, recordOptIn, complianceReply } from '@/lib/compliance';
import { sendAndTrack } from '@/lib/sms';
import { scheduleFollowUp } from '@/lib/agent/followup';
import { triggerHandoff } from '@/lib/agent/handoff';
import { isWithinBusinessHours } from '@/lib/business-hours';
import { extractZip, geocodeZip, nearestDealer } from '@/lib/geocode';
import type { Conversation, Lead, Dealer, Message, DealerSettings } from '@/lib/types';

/**
 * Telnyx inbound SMS webhook.
 * Receives customer messages and routes them through the AI agent.
 */
export async function POST(req: NextRequest) {
  try {
    // Read the body as text and verify BEFORE parsing: Telnyx signs the raw
    // bytes, and re-serialising parsed JSON will not reproduce them.
    const rawBody = await req.text();
    const verdict = verifyTelnyxSignature(
      rawBody,
      req.headers.get('telnyx-signature-ed25519'),
      req.headers.get('telnyx-timestamp')
    );
    if (!verdict.ok) {
      console.warn(`[Telnyx Inbound] Rejected unverified webhook: ${verdict.reason}`);
      return NextResponse.json({ error: 'Invalid signature' }, { status: 403 });
    }

    const payload = JSON.parse(rawBody);

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

    // Carrier keywords come first — before routing, before the AI.
    //
    // Every dealer's lead form promises "Reply STOP to opt out, HELP for help",
    // and a toll-free verification is granted on that promise. Handling it here
    // means a STOP works even when routing cannot tell which dealer the sender
    // belongs to, and can never be swallowed by the agent treating it as chat.
    let keywordAction = classifyKeyword(body);
    // START from someone who never opted out is just conversation; let it through
    // rather than answering a resubscribe confirmation they did not ask for.
    if (keywordAction === 'opt_in') {
      const { isOptedOut } = await import('@/lib/compliance');
      if (!(await isOptedOut(from))) keywordAction = null;
    }
    if (keywordAction) {
      const { sendSms } = await import('@/lib/sms');

      // Name the dealer they were actually talking to, when we can tell.
      let businessName: string | undefined;
      try {
        const { data: kwLead } = await db
          .from('leads')
          .select('dealer_id')
          .eq('phone', from.replace(/^\+1/, '').replace(/\D/g, ''))
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (kwLead?.dealer_id) {
          const { data: kwDealer } = await db
            .from('dealers')
            .select('business_name, twilio_phone')
            .eq('id', kwLead.dealer_id)
            .maybeSingle();
          businessName = kwDealer?.business_name;
        }
      } catch (e) {
        console.error('[Compliance] dealer lookup failed:', (e as Error).message);
      }

      if (keywordAction === 'opt_out') {
        await recordOptOut(from, body.trim().toUpperCase());
        // Cold-outreach prospects are tracked separately; honour it there too.
        try {
          await db
            .from('outreach_prospects')
            .update({ status: 'opted_out', updated_at: new Date().toISOString() })
            .eq('phone', from);
        } catch {}
      } else if (keywordAction === 'opt_in') {
        await recordOptIn(from);
      }

      // Sent directly, bypassing the opt-out guard in sendAndTrack: the
      // confirmation of a STOP is the one message a just-unsubscribed number
      // must still receive, and carriers require it.
      await sendSms(from, complianceReply(keywordAction, businessName), to);
      console.log('[Compliance] ' + keywordAction + ' handled for ' + from);
      return NextResponse.json({ ok: true, compliance: keywordAction });
    }

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

      // Cold text to the shared number (no existing lead, no keyword, no
      // matching prospect): route to the nearest store by ZIP code. If we
      // don't have a ZIP yet, ask for one; once we do, geocode it and pick
      // the closest active dealer.
      const sharedNumber = process.env.TELNYX_PHONE_NUMBER?.replace(/\\n/g, '').trim();
      if (to === sharedNumber && sharedNumber) {
        const zip = extractZip(body);

        if (!zip) {
          // No ZIP yet — ask for it so we can route to the nearest store.
          const { sendSms } = await import('@/lib/sms');
          await sendSms(from, `Hey! This is Bed Sync — I help people find their nearest mattress store. What's your ZIP code and I'll connect you with the closest one. Reply STOP to opt out.`);
          console.log('[Telnyx] Cold text, asked for ZIP. From:', from);
          return NextResponse.json({ ok: true });
        }

        const { data: activeDealers } = await db
          .from('dealers')
          .select('*')
          .eq('active', true);

        const origin = await geocodeZip(zip);
        if (origin && activeDealers) {
          const nearest = nearestDealer(origin, activeDealers as any[]);
          if (nearest) dealer = nearest as Dealer;
        }

        // Geocoded fine, but no real store within range: say so rather than
        // connecting them to whichever pin happened to be nearest. The old
        // fallback handed them to whoever owns the shared number, which on this
        // account is a demo storefront — a real shopper would have been put
        // through to a store that does not exist.
        if (!dealer && origin) {
          const { sendSms } = await import('@/lib/sms');
          await sendSms(
            from,
            `Thanks for reaching out! We don't have a store near ${zip} just yet. If you leave your name I'll pass it along, and we'll reach out as soon as one opens up nearby.`
          );
          console.log('[Telnyx] Cold text, no store within range of', zip, 'From:', from);
          return NextResponse.json({ ok: true, routed: 'no store within range' });
        }

        // Couldn't geocode the ZIP at all — ask them to re-check it.
        if (!dealer && !origin) {
          const { sendSms } = await import('@/lib/sms');
          await sendSms(from, `Hmm, I couldn't find that ZIP code — could you double-check it? Reply with your 5-digit ZIP and I'll connect you with the nearest store.`);
          console.log('[Telnyx] Cold text, bad ZIP:', zip, 'From:', from);
          return NextResponse.json({ ok: true });
        }
      }

      if (!dealer) {
        const { sendSms } = await import('@/lib/sms');
        await sendSms(from, `Hey! Thanks for texting. What mattress store are you trying to reach? Just reply with the store name and I'll connect you.`);
        console.log('[Telnyx] Unknown sender, asked for store name. From:', from, 'Body:', body.substring(0, 50));
        return NextResponse.json({ ok: true });
      }
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

    // A conversation is done after 30 days of silence. Without this a customer
    // who comes back months later lands in the old thread forever, so they are
    // never counted again and the agent answers as if no time passed.
    const CONVERSATION_IDLE_DAYS = 30;
    let startedNewConversation = false;
    if (conversation) {
      const { data: lastMsg } = await db
        .from('messages')
        .select('created_at')
        .eq('conversation_id', conversation.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const lastAt = new Date(lastMsg?.created_at || conversation.created_at).getTime();
      const idleDays = (Date.now() - lastAt) / 86400000;
      if (idleDays > CONVERSATION_IDLE_DAYS) {
        await db.from('conversations').update({ status: 'closed' }).eq('id', conversation.id);
        console.log(`[Telnyx Inbound] Conversation ${conversation.id} idle ${Math.round(idleDays)}d — starting a fresh one`);
        conversation = null;
      }
    }

    if (!conversation) {
      // Someone texting back after their last conversation closed. Carry what
      // we learned forward so the agent doesn't greet a familiar customer as a
      // stranger and re-ask their size and sleep position.
      const { getPriorHistory, describePriorHistory } = await import('@/lib/agent/returning');
      const prior = await getPriorHistory(db, lead.id);
      const seededContext = prior
        ? { ...prior.seed, returning_summary: describePriorHistory(prior.seed, prior.lastContactAt) }
        : {};

      const { data: newConv } = await db
        .from('conversations')
        .insert({
          lead_id: lead.id,
          dealer_id: dealer.id,
          status: 'active',
          agent_state: 'greeting',
          context: seededContext,
        })
        .select()
        .maybeSingle();
      conversation = newConv;
      startedNewConversation = !!newConv;
    }

    if (!conversation) {
      return NextResponse.json({ ok: true });
    }

    // Record inbound message
    const { data: inboundRow } = await db.from('messages').insert({
      conversation_id: conversation.id,
      direction: 'inbound',
      sender: 'customer',
      body,
      twilio_sid: messageId, // Keep field name for backward compat
    }).select('id, created_at').single();

    // Customers double-text constantly ("I'd like a former mattress" / "Oops,
    // firmer"). Each text is its own webhook, so two invocations run at once
    // and both reply — the first one answering a message that has already been
    // corrected. If a newer inbound has landed, this reply is stale: drop it
    // and let the newer invocation answer, since it reads the full history and
    // sees both messages. The newest message can never be superseded, so
    // someone always replies.
    const supersededBy = async () => {
      if (!inboundRow?.created_at) return false;
      const { data: newer } = await db
        .from('messages')
        .select('id')
        .eq('conversation_id', conversation.id)
        .eq('direction', 'inbound')
        .gt('created_at', inboundRow.created_at)
        .limit(1);
      return !!(newer && newer.length > 0);
    };

    // Telnyx bills inbound as well as outbound, so a cap that ignored it
    // would understate a dealer by roughly half.
    {
      const { recordCost, messageCost } = await import('@/lib/cost');
      await recordCost(dealer.id, 'sms_in', messageCost(body), { length: (body || '').length });
    }

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

    // Spending limit. This gate refuses to START a conversation; it never
    // interrupts one. Someone halfway through booking a visit always gets
    // finished — cutting them off would cost the dealer the sale and make the
    // product look broken, and the handful in flight when the limit lands are
    // worth pennies against the ceiling.
    if (startedNewConversation) {
      const { getCostState, markCapNotified, countConversationStarted } = await import('@/lib/cost');
      const limit = await getCostState(dealer.id);

      if (!limit.canStartConversation) {
        console.warn(
          `[Cost] New conversation refused for dealer ${dealer.id}: ` +
          `${limit.conversationsUsed}/${limit.conversationsIncluded} conversations, $${limit.costUsd.toFixed(2)} of $${limit.capUsd}`
        );
        await db.from('conversations').update({ status: 'paused' }).eq('id', conversation.id);
        await db.from('agent_logs').insert({
          conversation_id: conversation.id,
          action: 'tool_call',
          details: {
            tool: 'monthly_limit_reached',
            conversations_used: limit.conversationsUsed,
            conversations_included: limit.conversationsIncluded,
            cost_usd: limit.costUsd,
            cap_usd: limit.capUsd,
          },
        });

        if (!limit.notifiedAt) {
          const notify = (dealer.settings as unknown as Record<string, unknown> | null)?.lead_notify_phone as string | undefined
            || dealer.owner_phone || undefined;
          if (notify) {
            const { sendSms } = await import('@/lib/sms');
            await sendSms(
              String(notify),
              `You have used all ${limit.conversationsIncluded} AI conversations included this month. New leads are still captured in your dashboard — they just are not being answered automatically. Reply to them there, or contact Bed Sync to add more.`,
              dealer.twilio_phone || undefined
            );
          }
          await markCapNotified(dealer.id);
        }

        return NextResponse.json({ ok: true, paused: 'monthly_limit' });
      }

      await countConversationStarted(dealer.id);
    }
    // Cheap check before spending a model call on a message already corrected.
    if (await supersededBy()) {
      console.log('[Telnyx Inbound] Newer message arrived — skipping stale reply');
      return NextResponse.json({ ok: true, superseded: true });
    }

    // Process through agent
    const decision = await processMessage({
      conversation: conversation as Conversation,
      lead: lead as Lead,
      dealer: dealer as Dealer,
      inboundMessage: body,
      recentMessages: (messages || []) as Message[],
    });

    // Check again — the correction usually lands while the model is thinking.
    if (await supersededBy()) {
      console.log('[Telnyx Inbound] Newer message arrived while replying — dropping stale reply');
      await db.from('agent_logs').insert({
        conversation_id: conversation.id,
        action: 'tool_call',
        details: { tool: 'reply_superseded', body },
      });
      return NextResponse.json({ ok: true, superseded: true });
    }

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

import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';
import { processMessage } from '@/lib/agent/orchestrator';
import { sendAndTrack, sendSms } from '@/lib/sms';
import { z } from 'zod';
import type { Conversation, Lead, Dealer, Message } from '@/lib/types';

const CreateLeadSchema = z.object({
  dealer_id: z.string().uuid(),
  phone: z.string().min(10),
  customer_name: z.string().optional(),
  email: z.string().email().optional(),
  source: z.enum(['website', 'facebook', 'google', 'manual', 'referral', 'walk_in', 'other']).default('website'),
  initial_message: z.string().optional(),
  // Dealer lead-alert target + internal secret. notify_phone is honored ONLY
  // when notify_secret matches INTERNAL_API_SECRET (server-to-server), so this
  // public endpoint can't be used to text arbitrary numbers.
  notify_phone: z.string().optional(),
  notify_secret: z.string().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = CreateLeadSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const { dealer_id, phone, customer_name, email, source, initial_message } = parsed.data;
    const db = getServiceClient();

    // Verify dealer exists and is active
    const { data: dealer } = await db
      .from('dealers')
      .select('*')
      .eq('id', dealer_id)
      .eq('active', true)
      .single();

    if (!dealer) {
      return NextResponse.json({ error: 'Dealer not found or inactive' }, { status: 404 });
    }

    // Check for existing lead with this phone
    const { data: existingLead } = await db
      .from('leads')
      .select('*')
      .eq('dealer_id', dealer_id)
      .eq('phone', phone)
      .single();

    let lead: Lead;
    let conversation: Conversation;
    let isNew = false;

    if (existingLead) {
      lead = existingLead as Lead;

      // Check for existing active conversation
      const { data: existingConv } = await db
        .from('conversations')
        .select('*')
        .eq('lead_id', lead.id)
        .in('status', ['active', 'follow_up', 'paused'])
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (existingConv) {
        conversation = existingConv as Conversation;
      } else {
        // Create new conversation for returning lead
        const { data: newConv } = await db
          .from('conversations')
          .insert({
            lead_id: lead.id,
            dealer_id: dealer_id,
            status: 'active',
            agent_state: 'greeting',
          })
          .select()
          .single();
        conversation = newConv as Conversation;
        isNew = true;
      }
    } else {
      // Create new lead
      const { data: newLead } = await db
        .from('leads')
        .insert({
          dealer_id,
          phone,
          customer_name: customer_name || null,
          email: email || null,
          source,
          status: 'new',
        })
        .select()
        .single();
      lead = newLead as Lead;

      // Create conversation
      const { data: newConv } = await db
        .from('conversations')
        .insert({
          lead_id: lead.id,
          dealer_id,
          status: 'active',
          agent_state: 'greeting',
        })
        .select()
        .single();
      conversation = newConv as Conversation;
      isNew = true;
    }

    // Log lead creation
    await db.from('agent_logs').insert({
      conversation_id: conversation.id,
      action: 'message_received',
      details: { source, is_new: isNew, initial_message },
    });

    // Alert the dealer about the new lead, sent from the dealer's own SMS line
    // (the 833 toll-free is approved; the main app's default number is
    // 10DLC-rejected). Target resolution: a caller-supplied notify_phone is used
    // ONLY with a valid internal secret (server-to-server from the main app);
    // otherwise fall back to the number stored on the dealer record. This keeps
    // the public endpoint safe from being used to text arbitrary numbers.
    const secretOk = !!parsed.data.notify_secret && !!process.env.INTERNAL_API_SECRET
      && parsed.data.notify_secret === process.env.INTERNAL_API_SECRET;
    const notifyPhone = (secretOk && parsed.data.notify_phone)
      ? parsed.data.notify_phone
      : (((dealer as Dealer).settings as unknown as Record<string, unknown> | null)?.lead_notify_phone as string | undefined);
    if (notifyPhone) {
      try {
        const who = customer_name || phone;
        const alert = `New website lead for ${(dealer as Dealer).business_name}: ${who} (${phone}) asked for more info on your mattresses. The AI is already texting them — check your dashboard to follow up.`;
        await sendSms(String(notifyPhone), alert, (dealer as Dealer).twilio_phone || undefined);
      } catch (notifyErr) {
        console.error('[Lead Create] dealer notify error:', notifyErr);
      }
    }

    // If auto-reply is enabled, process and respond immediately
    if ((dealer as Dealer).settings.auto_reply) {
      const messageText = initial_message || `Hi, I'm interested in mattresses`;

      // Record the inbound message
      await db.from('messages').insert({
        conversation_id: conversation.id,
        direction: 'inbound',
        sender: 'customer',
        body: messageText,
      });

      // Get recent messages for context
      const { data: messages } = await db
        .from('messages')
        .select('*')
        .eq('conversation_id', conversation.id)
        .order('created_at', { ascending: true })
        .limit(20);

      // Run agent
      const decision = await processMessage({
        conversation,
        lead,
        dealer: dealer as Dealer,
        inboundMessage: messageText,
        recentMessages: (messages || []) as Message[],
      });

      // Send reply (MMS when the agent has product photos to show)
      await sendAndTrack(
        dealer_id,
        conversation.id,
        phone,
        decision.reply,
        'agent',
        decision.media_urls
      );

      // Update conversation state
      const convUpdate: Record<string, unknown> = {};
      if (decision.new_state) convUpdate.agent_state = decision.new_state;
      if (decision.context_updates) {
        convUpdate.context = {
          ...(conversation.context as object),
          ...decision.context_updates,
        };
      }
      if (Object.keys(convUpdate).length > 0) {
        await db.from('conversations').update(convUpdate).eq('id', conversation.id);
      }

      // Update lead
      const leadUpdate: Record<string, unknown> = { status: 'qualifying' };
      if (decision.qualification_updates) {
        leadUpdate.qualification = {
          ...(lead.qualification as object),
          ...decision.qualification_updates,
        };
      }
      if (decision.lead_score_delta) {
        leadUpdate.lead_score = Math.max(0, lead.lead_score + decision.lead_score_delta);
      }
      await db.from('leads').update(leadUpdate).eq('id', lead.id);

      // Handle handoff
      if (decision.should_handoff) {
        const { triggerHandoff } = await import('@/lib/agent/handoff');
        await triggerHandoff(conversation, dealer as Dealer, decision.handoff_reason || 'Agent triggered');
      }

      return NextResponse.json({
        success: true,
        lead_id: lead.id,
        conversation_id: conversation.id,
        agent_reply: decision.reply,
        is_new: isNew,
      });
    }

    return NextResponse.json({
      success: true,
      lead_id: lead.id,
      conversation_id: conversation.id,
      is_new: isNew,
    });
  } catch (err) {
    console.error('[Lead Create] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

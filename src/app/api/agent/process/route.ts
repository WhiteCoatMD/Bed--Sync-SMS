import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';
import { processMessage } from '@/lib/agent/orchestrator';
import { sendAndTrack } from '@/lib/sms';
import { scheduleFollowUp } from '@/lib/agent/followup';
import { triggerHandoff } from '@/lib/agent/handoff';
import type { Conversation, Lead, Dealer, Message, DealerSettings } from '@/lib/types';
import { z } from 'zod';

const ProcessSchema = z.object({
  conversation_id: z.string().uuid(),
  message: z.string().min(1),
  direction: z.enum(['inbound', 'outbound']).default('inbound'),
});

/**
 * POST /api/agent/process
 * Manually trigger agent processing for a conversation.
 * Useful for testing or re-processing.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = ProcessSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const { conversation_id, message } = parsed.data;
    const db = getServiceClient();

    // Load conversation with relations
    const { data: conv } = await db
      .from('conversations')
      .select('*')
      .eq('id', conversation_id)
      .single();

    if (!conv) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    const conversation = conv as Conversation;

    // Skip if handed off
    if (conversation.status === 'handed_off') {
      return NextResponse.json({
        success: false,
        error: 'Conversation is handed off. Resume AI first.',
      });
    }

    const { data: lead } = await db
      .from('leads')
      .select('*')
      .eq('id', conversation.lead_id)
      .single();

    const { data: dealer } = await db
      .from('dealers')
      .select('*')
      .eq('id', conversation.dealer_id)
      .single();

    if (!lead || !dealer) {
      return NextResponse.json({ error: 'Lead or dealer not found' }, { status: 404 });
    }

    // Get recent messages
    const { data: messages } = await db
      .from('messages')
      .select('*')
      .eq('conversation_id', conversation_id)
      .order('created_at', { ascending: true })
      .limit(20);

    // Record inbound message
    await db.from('messages').insert({
      conversation_id,
      direction: 'inbound',
      sender: 'customer',
      body: message,
    });

    // Process
    const decision = await processMessage({
      conversation,
      lead: lead as Lead,
      dealer: dealer as Dealer,
      inboundMessage: message,
      recentMessages: (messages || []) as Message[],
    });

    // Send reply
    await sendAndTrack(
      dealer.id,
      conversation_id,
      (lead as Lead).phone,
      decision.reply,
      'agent'
    );

    // Update conversation
    const convUpdate: Record<string, unknown> = {};
    if (decision.new_state) convUpdate.agent_state = decision.new_state;
    if (decision.context_updates) {
      convUpdate.context = {
        ...(conversation.context as object),
        ...decision.context_updates,
      };
    }
    if (Object.keys(convUpdate).length > 0) {
      await db.from('conversations').update(convUpdate).eq('id', conversation_id);
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
    if (Object.keys(leadUpdate).length > 0) {
      await db.from('leads').update(leadUpdate).eq('id', lead.id);
    }

    // Handle handoff
    if (decision.should_handoff) {
      await triggerHandoff(conversation, dealer as Dealer, decision.handoff_reason || 'Agent triggered');
    }

    return NextResponse.json({
      success: true,
      reply: decision.reply,
      new_state: decision.new_state,
      should_handoff: decision.should_handoff,
      handoff_reason: decision.handoff_reason,
      lead_score_delta: decision.lead_score_delta,
      agent_note: decision.agent_note,
    });
  } catch (err) {
    console.error('[Agent Process] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

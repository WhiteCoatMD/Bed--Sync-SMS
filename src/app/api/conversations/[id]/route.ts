import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';
import { canAccessDealer, dealerIdForConversation } from '@/lib/api-auth';
import { sendAndTrack } from '@/lib/sms';

/**
 * GET /api/conversations/[id]
 * Get full conversation detail including messages, recommendations, logs.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const scopeDealer = await dealerIdForConversation(id);
    if (!scopeDealer || !(await canAccessDealer(req, scopeDealer))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const db = getServiceClient();

    const { data: conversation } = await db
      .from('conversations')
      .select(`
        *,
        lead:leads!inner(*),
        dealer:dealers!inner(id, business_name, settings)
      `)
      .eq('id', id)
      .single();

    if (!conversation) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    // Fetch messages
    const { data: messages } = await db
      .from('messages')
      .select('*')
      .eq('conversation_id', id)
      .order('created_at', { ascending: true });

    // Fetch recommendations with inventory items
    const { data: recommendations } = await db
      .from('recommendations')
      .select('*, item:inventory!inner(*)')
      .eq('conversation_id', id)
      .order('presented_at', { ascending: false });

    // Fetch recent logs
    const { data: logs } = await db
      .from('agent_logs')
      .select('*')
      .eq('conversation_id', id)
      .order('created_at', { ascending: false })
      .limit(50);

    return NextResponse.json({
      success: true,
      conversation: {
        ...conversation,
        messages: messages || [],
        recommendations: recommendations || [],
        logs: logs || [],
      },
    });
  } catch (err) {
    console.error('[Conversation Detail] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * PATCH /api/conversations/[id]
 * Update conversation outcome (win/loss tracking).
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const scopeDealer = await dealerIdForConversation(id);
    if (!scopeDealer || !(await canAccessDealer(req, scopeDealer))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const body = await req.json();
    const db = getServiceClient();

    const update: Record<string, unknown> = {};

    if (body.outcome !== undefined) {
      update.outcome = body.outcome; // 'won' | 'lost' | null
      update.outcome_at = body.outcome ? new Date().toISOString() : null;
    }
    if (body.outcome_details !== undefined) update.outcome_details = body.outcome_details;
    if (body.outcome_product !== undefined) update.outcome_product = body.outcome_product;
    if (body.status !== undefined) update.status = body.status;

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    const { error } = await db.from('conversations').update(update).eq('id', id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    await db.from('agent_logs').insert({
      conversation_id: id,
      action: 'state_change',
      details: { event: 'outcome_updated', ...update },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[Conversation Update] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/conversations/[id]
 * Send a manual SMS from the admin (human sender).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const scopeDealer = await dealerIdForConversation(id);
    if (!scopeDealer || !(await canAccessDealer(req, scopeDealer))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { message } = await req.json();

    if (!message) {
      return NextResponse.json({ error: 'message required' }, { status: 400 });
    }

    const db = getServiceClient();

    const { data: conversation } = await db
      .from('conversations')
      .select(`
        *,
        lead:leads!inner(phone),
        dealer:dealers!inner(id)
      `)
      .eq('id', id)
      .single();

    if (!conversation) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const conv = conversation as any;
    await sendAndTrack(
      conv.dealer.id,
      id,
      conv.lead.phone,
      message,
      'human'
    );

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[Manual SMS] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';
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
 * POST /api/conversations/[id]
 * Send a manual SMS from the admin (human sender).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
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

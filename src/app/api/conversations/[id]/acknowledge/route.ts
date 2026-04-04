import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';

/**
 * POST /api/conversations/[id]/acknowledge
 * Dealer acknowledges a handoff alert, dismissing it from the dashboard.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getServiceClient();

    const { error } = await db
      .from('conversations')
      .update({ handoff_acknowledged_at: new Date().toISOString() })
      .eq('id', id)
      .eq('status', 'handed_off'); // safety: only ack handed-off conversations

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    await db.from('agent_logs').insert({
      conversation_id: id,
      action: 'state_change',
      details: { event: 'handoff_acknowledged' },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[Acknowledge] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

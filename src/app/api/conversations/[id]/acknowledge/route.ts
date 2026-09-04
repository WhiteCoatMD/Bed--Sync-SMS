import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';
import { canAccessDealer, dealerIdForConversation } from '@/lib/api-auth';

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
    const scopeDealer = await dealerIdForConversation(id);
    if (!scopeDealer || !(await canAccessDealer(req, scopeDealer))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const db = getServiceClient();

    // Dealer is taking over — stop AI replies and mark acknowledged
    const { error } = await db
      .from('conversations')
      .update({
        status: 'handed_off',
        agent_state: 'handed_off',
        handoff_acknowledged_at: new Date().toISOString(),
      })
      .eq('id', id)
      .not('handed_off_at', 'is', null); // safety: only ack conversations with a pending handoff

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

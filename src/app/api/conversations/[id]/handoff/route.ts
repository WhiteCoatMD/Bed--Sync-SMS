import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';
import { canAccessDealer, dealerIdForConversation } from '@/lib/api-auth';
import { triggerHandoff } from '@/lib/agent/handoff';
import type { Conversation, Dealer } from '@/lib/types';

/**
 * POST /api/conversations/[id]/handoff
 * Manually trigger human takeover.
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
    const { reason } = await req.json();

    const db = getServiceClient();

    const { data: conversation } = await db
      .from('conversations')
      .select('*')
      .eq('id', id)
      .single();

    if (!conversation) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const { data: dealer } = await db
      .from('dealers')
      .select('*')
      .eq('id', (conversation as Conversation).dealer_id)
      .single();

    if (!dealer) {
      return NextResponse.json({ error: 'Dealer not found' }, { status: 404 });
    }

    await triggerHandoff(
      conversation as Conversation,
      dealer as Dealer,
      reason || 'Manual handoff from admin'
    );

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[Handoff] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

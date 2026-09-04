import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';
import { canAccessDealer } from '@/lib/api-auth';

/**
 * GET /api/dealers/billing-alert?dealer_id=X
 * Checks if dealer is approaching or over their message limit.
 * Returns alert level: none, warning (80%), critical (95%), over (100%+)
 */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const dealerId = url.searchParams.get('dealer_id');
    if (!dealerId || !(await canAccessDealer(req, dealerId))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!dealerId) {
      return NextResponse.json({ error: 'dealer_id required' }, { status: 400 });
    }

    const db = getServiceClient();

    const { data: dealer } = await db
      .from('dealers')
      .select('messages_used, messages_included, overage_rate, business_name')
      .eq('id', dealerId)
      .single();

    if (!dealer) {
      return NextResponse.json({ error: 'Dealer not found' }, { status: 404 });
    }

    const percent = dealer.messages_included > 0
      ? (dealer.messages_used / dealer.messages_included) * 100
      : 0;

    let level: 'none' | 'warning' | 'critical' | 'over' = 'none';
    let message = '';

    if (percent >= 100) {
      level = 'over';
      const overage = dealer.messages_used - dealer.messages_included;
      message = `You've used all ${dealer.messages_included} included messages. ${overage} overage messages at $${dealer.overage_rate}/each.`;
    } else if (percent >= 95) {
      level = 'critical';
      const remaining = dealer.messages_included - dealer.messages_used;
      message = `Only ${remaining} messages remaining this billing period. Consider upgrading your plan.`;
    } else if (percent >= 80) {
      level = 'warning';
      const remaining = dealer.messages_included - dealer.messages_used;
      message = `${remaining} messages remaining (${Math.round(percent)}% used). You're on track.`;
    }

    return NextResponse.json({
      success: true,
      alert: { level, message, percent: Math.round(percent) },
      usage: {
        used: dealer.messages_used,
        included: dealer.messages_included,
        remaining: Math.max(0, dealer.messages_included - dealer.messages_used),
      }
    });
  } catch (err) {
    console.error('[Billing Alert] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

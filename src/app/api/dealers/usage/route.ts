import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';

/**
 * GET /api/dealers/usage?dealer_id=X
 * Returns usage stats for the dealer's SMS agent.
 * Accepts x-api-key or bearer token auth.
 */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const dealerId = url.searchParams.get('dealer_id');

    if (!dealerId) {
      return NextResponse.json({ error: 'dealer_id required' }, { status: 400 });
    }

    // Auth: accept API key or verify via BedSync
    const apiKey = req.headers.get('x-api-key');
    const authToken = req.headers.get('authorization')?.replace('Bearer ', '');
    let authorized = false;

    if (apiKey && apiKey === process.env.BEDSYNC_API_KEY) {
      authorized = true;
    } else if (authToken) {
      try {
        const bedsyncUrl = process.env.BEDSYNC_API_URL || 'https://www.bed-sync.com';
        const verifyRes = await fetch(`${bedsyncUrl}/api/auth/me`, {
          headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (verifyRes.ok) {
          const verifyData = await verifyRes.json();
          if (verifyData.user) authorized = true;
        }
      } catch { /* auth failed */ }
    }

    if (!authorized) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const db = getServiceClient();

    // Get dealer info
    const { data: dealer } = await db
      .from('dealers')
      .select('id, business_name, plan, messages_used, messages_included, overage_rate, monthly_cost, billing_cycle_start, twilio_phone, active')
      .eq('id', dealerId)
      .single();

    if (!dealer) {
      return NextResponse.json({ error: 'Dealer not found' }, { status: 404 });
    }

    // Get conversation stats
    const { data: conversations } = await db
      .from('conversations')
      .select('id, status, agent_state')
      .eq('dealer_id', dealerId);

    const convStats = {
      total: conversations?.length || 0,
      active: conversations?.filter(c => c.status === 'active').length || 0,
      handed_off: conversations?.filter(c => c.status === 'handed_off').length || 0,
      converted: conversations?.filter(c => c.agent_state === 'converted').length || 0,
      lost: conversations?.filter(c => c.agent_state === 'lost').length || 0,
    };

    // Get lead stats
    const { data: leads } = await db
      .from('leads')
      .select('id, status, lead_score')
      .eq('dealer_id', dealerId);

    const leadStats = {
      total: leads?.length || 0,
      hot: leads?.filter(l => l.lead_score >= 70).length || 0,
      qualified: leads?.filter(l => l.status === 'qualified' || l.status === 'hot').length || 0,
    };

    // Get messages sent this billing period
    const billingStart = dealer.billing_cycle_start || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    const { count: messagesSentThisPeriod } = await db
      .from('usage_events')
      .select('id', { count: 'exact', head: true })
      .eq('dealer_id', dealerId)
      .eq('event_type', 'sms_sent')
      .gte('created_at', billingStart);

    // Get recent daily usage (last 14 days)
    const fourteenDaysAgo = new Date(Date.now() - 14 * 86400000).toISOString();
    const { data: recentUsage } = await db
      .from('usage_events')
      .select('created_at')
      .eq('dealer_id', dealerId)
      .in('event_type', ['sms_sent', 'sms_received'])
      .gte('created_at', fourteenDaysAgo);

    // Group by day
    const dailyUsage: Record<string, number> = {};
    (recentUsage || []).forEach(event => {
      const day = new Date(event.created_at).toISOString().split('T')[0];
      dailyUsage[day] = (dailyUsage[day] || 0) + 1;
    });

    const usagePercent = dealer.messages_included > 0
      ? Math.round((dealer.messages_used / dealer.messages_included) * 100)
      : 0;

    return NextResponse.json({
      success: true,
      dealer: {
        business_name: dealer.business_name,
        plan: dealer.plan,
        twilio_phone: dealer.twilio_phone,
        active: dealer.active,
      },
      usage: {
        messages_used: dealer.messages_used,
        messages_included: dealer.messages_included,
        messages_this_period: messagesSentThisPeriod || 0,
        overage_rate: dealer.overage_rate,
        usage_percent: usagePercent,
        billing_cycle_start: billingStart,
      },
      conversations: convStats,
      leads: leadStats,
      daily_usage: dailyUsage,
    });
  } catch (err) {
    console.error('[Dealer Usage] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

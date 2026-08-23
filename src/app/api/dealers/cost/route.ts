import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';
import { getCostState, setCap, DEFAULT_CAP_USD, RATES } from '@/lib/cost';

/**
 * GET  /api/dealers/cost                 every dealer, most expensive first
 * GET  /api/dealers/cost?dealer_id=…     one dealer, with a breakdown
 * POST /api/dealers/cost                 { dealer_id, cap_usd }
 *
 * API-key authenticated (server to server from the main app's admin side): a
 * dealer must never be able to raise their own ceiling.
 */
function authorized(req: NextRequest): boolean {
  const key = req.headers.get('x-api-key');
  return !!key && key === process.env.BEDSYNC_API_KEY;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const dealerId = req.nextUrl.searchParams.get('dealer_id');
  if (dealerId) {
    const state = await getCostState(dealerId);
    return NextResponse.json({ success: true, dealer_id: dealerId, rates: RATES, ...state });
  }

  const { data: dealers } = await getServiceClient()
    .from('dealers')
    .select('id, business_name, active')
    .eq('active', true);

  const rows = [];
  for (const d of dealers || []) {
    const state = await getCostState(d.id);
    rows.push({
      dealer_id: d.id,
      business_name: d.business_name,
      cost_usd: Number(state.costUsd.toFixed(4)),
      cap_usd: state.capUsd,
      percent_used: state.capUsd > 0 ? Math.round((state.costUsd / state.capUsd) * 100) : null,
      paused: !!state.cappedAt,
      period_start: state.periodStart,
    });
  }
  rows.sort((a, b) => b.cost_usd - a.cost_usd);

  return NextResponse.json({ success: true, default_cap_usd: DEFAULT_CAP_USD, dealers: rows });
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { dealer_id, cap_usd } = body || {};
  if (!dealer_id || typeof cap_usd !== 'number' || cap_usd < 0) {
    return NextResponse.json({ error: 'dealer_id and a non-negative cap_usd are required' }, { status: 400 });
  }

  const before = await getCostState(dealer_id);
  const state = await setCap(dealer_id, cap_usd);
  return NextResponse.json({
    success: true,
    dealer_id,
    cap_usd: state.capUsd,
    cost_usd: Number(state.costUsd.toFixed(4)),
    unlimited: cap_usd === 0,
    resumed: !!before.cappedAt && !state.cappedAt,
  });
}

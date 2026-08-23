import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';
import { getCostState, setCap, setConversationsIncluded, DEFAULT_CAP_USD, DEFAULT_CONVERSATIONS_INCLUDED, RATES } from '@/lib/cost';

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
      conversations_used: state.conversationsUsed,
      conversations_included: state.conversationsIncluded,
      conversations_percent: state.conversationsIncluded > 0
        ? Math.round((state.conversationsUsed / state.conversationsIncluded) * 100)
        : null,
      cost_usd: Number(state.costUsd.toFixed(4)),
      cap_usd: state.capUsd,
      cost_percent: state.capUsd > 0 ? Math.round((state.costUsd / state.capUsd) * 100) : null,
      accepting_new: state.canStartConversation,
      period_start: state.periodStart,
    });
  }
  rows.sort((a, b) => b.cost_usd - a.cost_usd);

  return NextResponse.json({
    success: true,
    default_cap_usd: DEFAULT_CAP_USD,
    default_conversations_included: DEFAULT_CONVERSATIONS_INCLUDED,
    dealers: rows,
  });
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { dealer_id, cap_usd, conversations_included } = body || {};
  if (!dealer_id) {
    return NextResponse.json({ error: 'dealer_id is required' }, { status: 400 });
  }
  const wantsCap = typeof cap_usd === 'number';
  const wantsAllowance = typeof conversations_included === 'number';
  if (!wantsCap && !wantsAllowance) {
    return NextResponse.json({ error: 'pass cap_usd and/or conversations_included' }, { status: 400 });
  }
  if ((wantsCap && cap_usd < 0) || (wantsAllowance && conversations_included < 0)) {
    return NextResponse.json({ error: 'values must be non-negative (0 means unlimited)' }, { status: 400 });
  }

  const before = await getCostState(dealer_id);
  let state = before;
  // The allowance is the number the dealer was sold; the dollar cap is the
  // backstop behind it. Either can be raised on its own.
  if (wantsAllowance) state = await setConversationsIncluded(dealer_id, conversations_included);
  if (wantsCap) state = await setCap(dealer_id, cap_usd);

  return NextResponse.json({
    success: true,
    dealer_id,
    conversations_used: state.conversationsUsed,
    conversations_included: state.conversationsIncluded,
    cap_usd: state.capUsd,
    cost_usd: Number(state.costUsd.toFixed(4)),
    accepting_new: state.canStartConversation,
    resumed: !before.canStartConversation && state.canStartConversation,
  });
}

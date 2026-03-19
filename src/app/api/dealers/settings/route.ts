import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';

/**
 * GET /api/dealers/settings?dealer_id=X - Get dealer settings
 * PUT /api/dealers/settings - Update dealer settings
 */
export async function GET(req: NextRequest) {
  try {
    const dealerId = req.nextUrl.searchParams.get('dealer_id');
    if (!dealerId) return NextResponse.json({ error: 'dealer_id required' }, { status: 400 });

    const db = getServiceClient();
    const { data, error } = await db
      .from('dealers')
      .select('id, business_name, settings, twilio_phone, plan, messages_used, messages_included')
      .eq('id', dealerId)
      .single();

    if (error || !data) return NextResponse.json({ error: 'Dealer not found' }, { status: 404 });

    return NextResponse.json({ success: true, dealer: data });
  } catch (err) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const { dealer_id, settings } = body;

    if (!dealer_id || !settings) {
      return NextResponse.json({ error: 'dealer_id and settings required' }, { status: 400 });
    }

    const db = getServiceClient();

    // Merge with existing settings (don't overwrite unset fields)
    const { data: existing } = await db
      .from('dealers')
      .select('settings')
      .eq('id', dealer_id)
      .single();

    const merged = { ...(existing?.settings || {}), ...settings };

    const { data, error } = await db
      .from('dealers')
      .update({ settings: merged, updated_at: new Date().toISOString() })
      .eq('id', dealer_id)
      .select('id, settings')
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ success: true, settings: data?.settings });
  } catch (err) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';
import type { Plan } from '@/lib/types';

const PLAN_CONFIG: Record<Plan, { messages_included: number; overage_rate: number; monthly_cost: number }> = {
  single_lot: { messages_included: 1000, overage_rate: 0.05, monthly_cost: 99.00 },
  multi_lot: { messages_included: 3500, overage_rate: 0.03, monthly_cost: 199.00 },
};

/**
 * POST /api/dealers/provision
 * Called by the main Bed Sync app when enabling SMS for a user.
 * Creates or returns existing dealer in Supabase, linked by bedsync_user_id.
 *
 * Secured by BEDSYNC_API_KEY shared secret.
 */
export async function POST(req: NextRequest) {
  try {
    // Validate shared API key
    const apiKey = req.headers.get('x-api-key');
    if (!apiKey || apiKey !== process.env.BEDSYNC_API_KEY) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { bedsync_user_id, business_name, owner_name, owner_phone, owner_email, plan, twilio_phone } = body;

    if (!bedsync_user_id || !business_name) {
      return NextResponse.json({ error: 'bedsync_user_id and business_name required' }, { status: 400 });
    }

    const db = getServiceClient();
    const planKey: Plan = plan === 'multi_lot' ? 'multi_lot' : 'single_lot';
    const planConfig = PLAN_CONFIG[planKey];

    // Check if dealer already exists for this Bed Sync user
    const { data: existing } = await db
      .from('dealers')
      .select('id, active')
      .eq('bedsync_user_id', bedsync_user_id)
      .single();

    if (existing) {
      // Reactivate if previously disabled
      if (!existing.active) {
        await db.from('dealers').update({ active: true }).eq('id', existing.id);
      }
      // Update twilio phone if provided
      if (twilio_phone) {
        await db.from('dealers').update({ twilio_phone }).eq('id', existing.id);
      }
      return NextResponse.json({
        success: true,
        dealer_id: existing.id,
        created: false,
      });
    }

    // Create new dealer
    const { data: dealer, error: createError } = await db
      .from('dealers')
      .insert({
        bedsync_user_id,
        business_name,
        owner_name: owner_name || null,
        owner_phone: owner_phone || null,
        owner_email: owner_email || null,
        twilio_phone: twilio_phone || null,
        plan: planKey,
        messages_included: planConfig.messages_included,
        overage_rate: planConfig.overage_rate,
        monthly_cost: planConfig.monthly_cost,
        settings: {
          auto_reply: true,
          follow_up_enabled: true,
          follow_up_delays: [30, 1440, 4320],
          max_follow_ups: 3,
          business_hours_start: '09:00',
          business_hours_end: '20:00',
          timezone: 'America/Chicago',
          greeting_style: 'friendly',
          store_address: '',
          financing_url: '',
          deposit_url: '',
          handoff_phone: owner_phone || '',
          show_pricing: true,
        },
      })
      .select()
      .single();

    if (createError || !dealer) {
      console.error('[Provision] DB error:', createError);
      return NextResponse.json({ error: 'Failed to create dealer' }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      dealer_id: dealer.id,
      created: true,
    }, { status: 201 });

  } catch (err) {
    console.error('[Provision] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

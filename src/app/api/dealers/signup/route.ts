import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';
import { provisionLocalNumber } from '@/lib/telnyx-provisioning';
import { z } from 'zod';
import { hasInternalSecret } from '@/lib/api-auth';
import type { Plan } from '@/lib/types';
import { resolveUsableCampaign } from '@/lib/10dlc';

const PLAN_CONFIG: Record<Plan, { messages_included: number; overage_rate: number; monthly_cost: number }> = {
  single_lot: { messages_included: 1000, overage_rate: 0.05, monthly_cost: 99.00 },
  multi_lot: { messages_included: 3500, overage_rate: 0.03, monthly_cost: 199.00 },
};

const SignupSchema = z.object({
  business_name: z.string().min(2),
  owner_name: z.string().min(2),
  owner_phone: z.string().min(10),
  owner_email: z.string().email(),
  plan: z.enum(['single_lot', 'multi_lot']).default('single_lot'),
  area_code: z.string().length(3).regex(/^\d{3}$/),
  store_address: z.string().optional(),
  financing_url: z.string().url().optional().or(z.literal('')),
  deposit_url: z.string().url().optional().or(z.literal('')),
});

/**
 * POST /api/dealers/signup
 * Create a new dealer account and auto-provision a local Twilio number.
 */
export async function POST(req: NextRequest) {
  try {
    // This creates a dealer and calls provisionLocalNumber, so an open route
    // was an endpoint that spends money: anyone could make us buy a phone
    // number, repeatedly. Server-to-server only.
    if (!hasInternalSecret(req)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const body = await req.json();
    const parsed = SignupSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const {
      business_name, owner_name, owner_phone, owner_email,
      plan, area_code, store_address, financing_url, deposit_url,
    } = parsed.data;

    const planConfig = PLAN_CONFIG[plan];
    const db = getServiceClient();

    // Check if dealer already exists with this email
    const { data: existing } = await db
      .from('dealers')
      .select('id')
      .eq('owner_email', owner_email)
      .single();

    if (existing) {
      return NextResponse.json({ error: 'An account with this email already exists' }, { status: 409 });
    }

    // 1. Create dealer record (without twilio_phone — provisioning fills it in)
    const { data: dealer, error: createError } = await db
      .from('dealers')
      .insert({
        business_name,
        owner_name,
        owner_phone,
        owner_email,
        plan,
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
          store_address: store_address || '',
          financing_url: financing_url || '',
          deposit_url: deposit_url || '',
          handoff_phone: owner_phone,
        },
      })
      .select()
      .single();

    if (createError || !dealer) {
      console.error('[Signup] DB error:', createError);
      return NextResponse.json({ error: 'Failed to create account' }, { status: 500 });
    }

    // 2. Give them a number of their own — but only if a 10DLC campaign can
    // actually accept it. Without this gate, signing up during a carrier review
    // bought a number that could never send, and said it had succeeded.
    //
    // A dealer with no number of their own is not broken: sendAndTrack falls
    // back to the shared toll-free, so they work from day one and the hourly
    // provisioning cron upgrades them once a campaign clears.
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://your-app.vercel.app';
    const campaign = await resolveUsableCampaign();

    if (!campaign.ok) {
      console.log(`[Signup] ${dealer.id} starts on the shared line — ${campaign.reason}`);
      return NextResponse.json({
        success: true,
        dealer_id: dealer.id,
        phone_provisioned: false,
        phone_pending_reason: campaign.reason,
        plan,
        monthly_cost: planConfig.monthly_cost,
        messages_included: planConfig.messages_included,
        message:
          'Account created. Texts send from the shared Bed Sync line for now; ' +
          'a local number is issued automatically once carrier registration clears.',
      }, { status: 201 });
    }

    const provision = await provisionLocalNumber(dealer.id, area_code, appUrl, campaign.campaignId);

    if (!provision.success) {
      // Dealer is created but number provisioning failed — they can retry
      return NextResponse.json({
        success: true,
        dealer_id: dealer.id,
        phone_provisioned: false,
        phone_error: provision.error,
        message: 'Account created but phone number provisioning failed. Contact support or retry.',
      }, { status: 201 });
    }

    // campaignAssigned is reported separately on purpose: a number that was
    // bought but not registered cannot send, and must never be handed back as
    // though it works.
    return NextResponse.json({
      success: true,
      dealer_id: dealer.id,
      phone_provisioned: provision.campaignAssigned === true,
      twilio_phone: provision.phoneNumber,
      campaign_assigned: provision.campaignAssigned === true,
      campaign_error: provision.campaignError,
      plan,
      monthly_cost: planConfig.monthly_cost,
      messages_included: planConfig.messages_included,
    }, { status: 201 });
  } catch (err) {
    console.error('[Signup] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

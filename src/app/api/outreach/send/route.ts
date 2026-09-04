import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';
import { sendSms } from '@/lib/sms';

/**
 * Send outreach SMS and register prospect for reply routing.
 * Called by main BedSync project with INTERNAL_API_SECRET auth.
 */
export async function POST(req: NextRequest) {
  try {
    const { phone, message, name, business_name, city, state, campaign, secret } = await req.json();

    // Fail CLOSED when the secret is not configured. `secret !== undefined`
    // is false when both sides are undefined, so an unset env turned this
    // send-an-SMS endpoint into an open one.
    const expected = process.env.INTERNAL_API_SECRET;
    if (!expected || secret !== expected) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!phone || !message) {
      return NextResponse.json({ error: 'phone and message required' }, { status: 400 });
    }

    // Format phone number
    let formattedPhone = phone.replace(/\D/g, '');
    if (formattedPhone.length === 10) formattedPhone = '+1' + formattedPhone;
    else if (formattedPhone.length === 11 && formattedPhone.startsWith('1')) formattedPhone = '+' + formattedPhone;
    else if (!formattedPhone.startsWith('+')) formattedPhone = '+' + formattedPhone;

    const db = getServiceClient();

    // Upsert prospect so inbound replies route correctly
    await db.from('outreach_prospects').upsert(
      {
        phone: formattedPhone,
        name: name || null,
        business_name: business_name || null,
        city: city || null,
        state: state || null,
        campaign: campaign || 'mba_outreach_v1',
        status: 'sent',
        last_message_sent: message,
        last_message_sent_at: new Date().toISOString(),
        phase: 1,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'phone' }
    );

    // Send via Telnyx (uses existing sms.ts which already has credentials)
    const result = await sendSms(formattedPhone, message);
    if (result.failure) {
      // This returned success unconditionally, so a rejected number reported as
      // a delivered outreach message.
      console.error('[Outreach] SMS failed to:', formattedPhone, result.failure.detail);
      return NextResponse.json(
        { success: false, to: formattedPhone, error: result.failure.detail, permanent: result.failure.permanent },
        { status: 502 }
      );
    }

    console.log('[Outreach] SMS sent to:', formattedPhone);
    return NextResponse.json({ success: true, to: formattedPhone, message_id: result.id });
  } catch (err) {
    console.error('[Outreach Send] Error:', err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';
import type { Dealer } from '@/lib/types';

/**
 * Twilio voice webhook - handles incoming calls to the dealer's Twilio number.
 *
 * Flow:
 * 1. Ring the dealer's handoff phone for 20 seconds
 * 2. If dealer answers → live call, no AI
 * 3. If no answer → plays "we just texted you" message
 * 4. Status callback at /api/twilio/voice/missed triggers the auto-text
 */
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const from = formData.get('From') as string;
    const to = formData.get('To') as string;

    if (!from || !to) {
      return voiceResponse('Sorry, this number is not available.');
    }

    const db = getServiceClient();

    // Find the dealer by their Twilio phone number
    const { data: dealer } = await db
      .from('dealers')
      .select('*')
      .eq('twilio_phone', to)
      .eq('active', true)
      .single();

    if (!dealer) {
      return voiceResponse('Sorry, this number is not available. Please try again later.');
    }

    const settings = (dealer as Dealer).settings;
    const businessName = (dealer as Dealer).business_name;
    const dealerPhone = settings.handoff_phone || (dealer as Dealer).owner_phone;

    // If dealer has a phone to ring, try them first
    if (dealerPhone) {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://sms.bed-sync.com';
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="20" callerId="${to}" action="${appUrl}/api/twilio/voice/missed?dealer_id=${dealer.id}&amp;caller=${encodeURIComponent(from)}">
    <Number>${dealerPhone}</Number>
  </Dial>
</Response>`;

      return new NextResponse(twiml, {
        headers: { 'Content-Type': 'text/xml' },
      });
    }

    // No dealer phone configured — go straight to missed call flow
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://sms.bed-sync.com';
    // Redirect to the missed handler directly
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">${appUrl}/api/twilio/voice/missed?dealer_id=${dealer.id}&amp;caller=${encodeURIComponent(from)}&amp;DialCallStatus=no-answer</Redirect>
</Response>`;

    return new NextResponse(twiml, {
      headers: { 'Content-Type': 'text/xml' },
    });
  } catch (err) {
    console.error('[Twilio Voice] Error:', err);
    return voiceResponse('Sorry, something went wrong. Please try again later.');
  }
}

function voiceResponse(message: string): NextResponse {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Matthew">${message}</Say>
  <Hangup/>
</Response>`;

  return new NextResponse(twiml, {
    headers: { 'Content-Type': 'text/xml' },
  });
}

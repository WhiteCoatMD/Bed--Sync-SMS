import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';
import { sendAndTrack } from '@/lib/sms';
import type { Dealer } from '@/lib/types';

/**
 * Twilio voice webhook - handles incoming calls to the dealer's Twilio number.
 * Plays a brief message, then sends an auto-text to the caller if missed_call_text is enabled.
 */
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const from = formData.get('From') as string;
    const to = formData.get('To') as string;
    const callStatus = formData.get('CallStatus') as string;

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

    // Send a brief voicemail-style message, then hang up
    // Twilio will trigger the status callback after the call ends
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Matthew">Thanks for calling ${businessName}. We're not able to answer right now, but we just sent you a text message so we can help you out. Talk soon!</Say>
  <Hangup/>
</Response>`;

    // Auto-text the caller
    if (settings.missed_call_text !== false && from) {
      const missedCallMessage =
        `Hey! Sorry we missed your call at ${businessName}. ` +
        `How can we help? Just text us back here and we'll get right on it!`;

      // Find or create lead
      const cleanPhone = from.replace(/^\+1/, '').replace(/\D/g, '');
      let { data: lead } = await db
        .from('leads')
        .select('*')
        .eq('dealer_id', dealer.id)
        .or(`phone.eq.${from},phone.eq.${cleanPhone},phone.eq.+1${cleanPhone}`)
        .single();

      if (!lead) {
        const { data: newLead } = await db
          .from('leads')
          .insert({
            dealer_id: dealer.id,
            phone: from,
            source: 'phone',
            status: 'new',
          })
          .select()
          .single();
        lead = newLead;
      }

      if (lead) {
        // Find or create conversation
        let { data: conversation } = await db
          .from('conversations')
          .select('*')
          .eq('lead_id', lead.id)
          .in('status', ['active', 'follow_up', 'paused', 'handed_off'])
          .order('created_at', { ascending: false })
          .limit(1)
          .single();

        if (!conversation) {
          const { data: newConv } = await db
            .from('conversations')
            .insert({
              lead_id: lead.id,
              dealer_id: dealer.id,
              status: 'active',
              agent_state: 'greeting',
            })
            .select()
            .single();
          conversation = newConv;
        }

        if (conversation) {
          await sendAndTrack(
            dealer.id,
            conversation.id,
            from,
            missedCallMessage,
            'agent'
          );

          await db.from('agent_logs').insert({
            conversation_id: conversation.id,
            action: 'missed_call_text',
            details: { caller: from, call_status: callStatus },
          });
        }
      }
    }

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

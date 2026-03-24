import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';
import { sendAndTrack } from '@/lib/sms';
import type { Dealer } from '@/lib/types';

/**
 * Twilio Dial action callback — called after the dealer's phone rings.
 *
 * DialCallStatus values:
 * - "completed" → dealer answered and call finished (do nothing)
 * - "no-answer" → dealer didn't pick up
 * - "busy" → dealer's line was busy
 * - "failed" → call couldn't connect
 *
 * On anything except "completed", we play a message and auto-text the caller.
 */
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const url = new URL(req.url);

    // DialCallStatus comes from form data (Twilio Dial action callback)
    const dialStatus = (formData.get('DialCallStatus') as string)
      || (url.searchParams.get('DialCallStatus') as string)
      || 'no-answer';
    const dealerId = url.searchParams.get('dealer_id');
    const caller = url.searchParams.get('caller') || (formData.get('From') as string);

    // If dealer answered, call is done — nothing to do
    if (dialStatus === 'completed') {
      return new NextResponse(
        `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`,
        { headers: { 'Content-Type': 'text/xml' } }
      );
    }

    const db = getServiceClient();

    // Get dealer info
    const { data: dealer } = await db
      .from('dealers')
      .select('*')
      .eq('id', dealerId)
      .eq('active', true)
      .single();

    if (!dealer) {
      return twimlSay('Sorry, we are unable to take your call right now. Please try again later.');
    }

    const settings = (dealer as Dealer).settings;
    const businessName = (dealer as Dealer).business_name;

    // Play voicemail message
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Matthew">Thanks for calling ${escapeXml(businessName)}. We're not able to answer right now, but we just sent you a text message so we can help you out. Talk soon!</Say>
  <Hangup/>
</Response>`;

    // Auto-text the caller
    if (settings.missed_call_text !== false && caller) {
      const missedCallMessage =
        `Hey! Sorry we missed your call at ${businessName}. ` +
        `How can we help? Just text us back here and we'll get right on it!`;

      // Find or create lead
      const cleanPhone = caller.replace(/^\+1/, '').replace(/\D/g, '');
      let { data: lead } = await db
        .from('leads')
        .select('*')
        .eq('dealer_id', dealer.id)
        .or(`phone.eq.${caller},phone.eq.${cleanPhone},phone.eq.+1${cleanPhone}`)
        .single();

      if (!lead) {
        const { data: newLead } = await db
          .from('leads')
          .insert({
            dealer_id: dealer.id,
            phone: caller,
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
            caller,
            missedCallMessage,
            'agent'
          );

          await db.from('agent_logs').insert({
            conversation_id: conversation.id,
            action: 'missed_call_text',
            details: { caller, dial_status: dialStatus },
          });
        }
      }
    }

    return new NextResponse(twiml, {
      headers: { 'Content-Type': 'text/xml' },
    });
  } catch (err) {
    console.error('[Twilio Voice Missed] Error:', err);
    return twimlSay('Sorry, something went wrong. Please try again later.');
  }
}

function twimlSay(message: string): NextResponse {
  return new NextResponse(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Matthew">${escapeXml(message)}</Say><Hangup/></Response>`,
    { headers: { 'Content-Type': 'text/xml' } }
  );
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

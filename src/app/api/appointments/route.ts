import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';
import { canAccessDealer, dealerIdForAppointment } from '@/lib/api-auth';

/**
 * GET /api/appointments?dealer_id=xxx
 * List appointments for a dealer, optionally filtered by date range.
 */
export async function GET(req: NextRequest) {
  try {
    const searchParams = new URL(req.url).searchParams;
    const dealerId = searchParams.get('dealer_id');
    const from = searchParams.get('from'); // ISO date
    const to = searchParams.get('to');     // ISO date

    if (!dealerId) {
      return NextResponse.json({ error: 'dealer_id required' }, { status: 400 });
    }

    if (!(await canAccessDealer(req, dealerId))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const db = getServiceClient();
    let query = db
      .from('appointments')
      .select(`
        *,
        lead:leads!inner(id, phone, customer_name),
        conversation:conversations!inner(id, status, agent_state)
      `)
      .eq('dealer_id', dealerId)
      .order('scheduled_at', { ascending: true });

    if (from) query = query.gte('scheduled_at', from);
    if (to) query = query.lte('scheduled_at', to);

    const { data, error } = await query;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, appointments: data || [] });
  } catch (err) {
    console.error('[Appointments] List error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/appointments
 * Create a new appointment.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      dealer_id, type, scheduled_at, duration_minutes, notes, created_by,
      customer_name, phone,
    } = body;
    let { conversation_id, lead_id } = body;

    if (!dealer_id || !scheduled_at) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    if (!(await canAccessDealer(req, dealer_id))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const db = getServiceClient();

    // A walk-in the dealer books by hand has no conversation and no lead, but
    // both columns are NOT NULL, so make them. Doing it this way rather than
    // loosening the schema keeps the manual booking visible to everything else:
    // it shows a name in the list, and the agent's double-booking check counts
    // it like any other.
    if (!conversation_id || !lead_id) {
      if (!customer_name && !phone) {
        return NextResponse.json(
          { error: 'A name or phone number is needed for a manual appointment' },
          { status: 400 }
        );
      }

      // A dealer typing a customer's number into a booking box is NOT SMS
      // consent. A non-numeric placeholder can never match an inbound message,
      // so a blank phone cannot accidentally attach this person to a real
      // conversation later.
      const leadPhone = (phone || '').trim() || `no-phone-${Date.now().toString(36)}`;

      const { data: existing } = await db
        .from('leads')
        .select('id')
        .eq('dealer_id', dealer_id)
        .eq('phone', leadPhone)
        .maybeSingle();

      if (existing) {
        lead_id = existing.id;
      } else {
        const { data: newLead, error: leadErr } = await db
          .from('leads')
          .insert({
            dealer_id,
            phone: leadPhone,
            customer_name: customer_name || null,
            source: 'manual',
            status: 'new',
          })
          .select('id')
          .single();
        if (leadErr || !newLead) {
          return NextResponse.json({ error: leadErr?.message || 'Could not create the customer' }, { status: 500 });
        }
        lead_id = newLead.id;
      }

      // 'closed' on purpose: the reminder job skips closed conversations, so
      // booking a walk-in never sends them a text they did not ask for.
      const { data: conv, error: convErr } = await db
        .from('conversations')
        .insert({ dealer_id, lead_id, status: 'closed', agent_state: 'closing' })
        .select('id')
        .single();
      if (convErr || !conv) {
        return NextResponse.json({ error: convErr?.message || 'Could not create the booking' }, { status: 500 });
      }
      conversation_id = conv.id;
    }

    // Refuse a clash rather than quietly creating one -- an appointment-only
    // store sees one customer at a time, which is the whole point of the guard
    // the agent already obeys.
    const wanted = new Date(scheduled_at).getTime();
    const mins = duration_minutes || (type === 'phone_call' ? 15 : 30);
    const { data: nearby } = await db
      .from('appointments')
      .select('scheduled_at, duration_minutes')
      .eq('dealer_id', dealer_id)
      .in('status', ['scheduled', 'confirmed'])
      .gte('scheduled_at', new Date(wanted - 12 * 3600000).toISOString())
      .lte('scheduled_at', new Date(wanted + 12 * 3600000).toISOString());

    const clash = (nearby || []).find((n) => {
      const s = new Date(n.scheduled_at).getTime();
      const e = s + ((n.duration_minutes ?? 30) * 60000);
      return wanted < e && s < wanted + mins * 60000;
    });
    if (clash) {
      return NextResponse.json(
        { error: 'double_booked', conflict_at: clash.scheduled_at },
        { status: 409 }
      );
    }

    const { data, error } = await db
      .from('appointments')
      .insert({
        dealer_id,
        conversation_id,
        lead_id,
        type: type || 'showroom_visit',
        scheduled_at,
        duration_minutes: mins,
        status: 'scheduled',
        notes: notes || null,
        created_by: created_by || 'human',
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, appointment: data });
  } catch (err) {
    console.error('[Appointments] Create error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * PATCH /api/appointments
 * Update an appointment status.
 */
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { id, status, scheduled_at, notes } = body;

    if (!id) {
      return NextResponse.json({ error: 'id required' }, { status: 400 });
    }

    // Scope by the appointment's own dealer: the caller supplies only an id,
    // so without this any signed-in dealer could cancel anyone's booking.
    const owningDealerId = await dealerIdForAppointment(id);
    if (!owningDealerId || !(await canAccessDealer(req, owningDealerId))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const db = getServiceClient();
    const update: Record<string, unknown> = {};
    if (status) update.status = status;
    if (scheduled_at) update.scheduled_at = scheduled_at;
    if (notes !== undefined) update.notes = notes;

    const { error } = await db.from('appointments').update(update).eq('id', id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[Appointments] Update error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

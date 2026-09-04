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
    const { dealer_id, conversation_id, lead_id, type, scheduled_at, duration_minutes, notes, created_by } = body;

    if (!dealer_id || !conversation_id || !lead_id || !scheduled_at) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    if (!(await canAccessDealer(req, dealer_id))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const db = getServiceClient();
    const { data, error } = await db
      .from('appointments')
      .insert({
        dealer_id,
        conversation_id,
        lead_id,
        type: type || 'showroom_visit',
        scheduled_at,
        duration_minutes: duration_minutes || 30,
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

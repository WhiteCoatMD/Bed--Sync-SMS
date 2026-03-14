import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';

/**
 * GET /api/conversations
 * List conversations with filtering.
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const dealerId = searchParams.get('dealer_id');
    const status = searchParams.get('status');
    const limit = parseInt(searchParams.get('limit') || '50');
    const offset = parseInt(searchParams.get('offset') || '0');

    if (!dealerId) {
      return NextResponse.json({ error: 'dealer_id required' }, { status: 400 });
    }

    const db = getServiceClient();

    let query = db
      .from('conversations')
      .select(`
        *,
        lead:leads!inner(id, phone, customer_name, email, source, status, lead_score, qualification, created_at),
        dealer:dealers!inner(id, business_name)
      `)
      .eq('dealer_id', dealerId)
      .order('updated_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error, count } = await query;

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      conversations: data || [],
      total: count,
    });
  } catch (err) {
    console.error('[Conversations] List error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

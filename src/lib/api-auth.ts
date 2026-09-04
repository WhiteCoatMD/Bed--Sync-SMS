import type { NextRequest } from 'next/server';
import { getServiceClient } from '@/lib/supabase';

/**
 * Who is allowed to read or change a dealer's data.
 *
 * The appointments API used to take dealer_id straight off the query string and
 * trust it, so anyone holding a dealer UUID could list that dealer's booked
 * visits -- customer names and phone numbers included -- and cancel them.
 *
 * A valid Bed Sync token is NOT on its own enough: it says who is asking, not
 * which dealer they are. Any signed-in dealer would otherwise be able to read
 * every other dealer's appointment book. So the token has to resolve to THIS
 * dealer, or to a Bed Sync super-admin.
 */
export async function canAccessDealer(req: NextRequest, dealerId: string): Promise<boolean> {
  if (!dealerId) return false;

  // Server-to-server (cron, Bed Sync itself).
  const apiKey = req.headers.get('x-api-key');
  if (apiKey && process.env.BEDSYNC_API_KEY && apiKey === process.env.BEDSYNC_API_KEY) {
    return true;
  }

  const token = req.headers.get('authorization')?.replace(/^Bearer /i, '');
  if (!token) return false;

  let user: { id?: number; is_admin?: boolean } | null = null;
  try {
    const bedsyncUrl = process.env.BEDSYNC_API_URL || 'https://www.bed-sync.com';
    const res = await fetch(`${bedsyncUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return false;
    const data = await res.json();
    if (!data?.success || !data.user) return false;
    user = data.user;
  } catch {
    // A network blip must not read as "authorized". Deny and let the caller retry.
    return false;
  }

  if (user?.is_admin) return true;
  if (!user?.id) return false;

  const db = getServiceClient();
  const { data: dealer } = await db
    .from('dealers')
    .select('id')
    .eq('id', dealerId)
    .eq('bedsync_user_id', user.id)
    .maybeSingle();

  return !!dealer;
}

/** The dealer an appointment belongs to, for scoping updates by appointment id. */
export async function dealerIdForAppointment(appointmentId: string): Promise<string | null> {
  const db = getServiceClient();
  const { data } = await db
    .from('appointments')
    .select('dealer_id')
    .eq('id', appointmentId)
    .maybeSingle();
  return data?.dealer_id ?? null;
}

/** The dealer a conversation belongs to, for scoping by conversation id. */
export async function dealerIdForConversation(conversationId: string): Promise<string | null> {
  const db = getServiceClient();
  const { data } = await db
    .from('conversations')
    .select('dealer_id')
    .eq('id', conversationId)
    .maybeSingle();
  return data?.dealer_id ?? null;
}

/**
 * Server-to-server only. Fails CLOSED when the secret is not configured:
 * comparing an unset env to an absent header is undefined !== undefined, which
 * is false, so a missing secret would have let everyone through.
 */
export function hasInternalSecret(req: NextRequest): boolean {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) return false;
  const supplied = req.headers.get('x-internal-secret') || req.headers.get('x-api-key');
  return supplied === secret || supplied === process.env.BEDSYNC_API_KEY;
}

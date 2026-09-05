import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';
import { sendSms } from '@/lib/sms';

/**
 * The day's appointments, texted to the dealer at 8am their own time.
 *
 * Runs hourly rather than once a day: 8am is a different instant in every
 * timezone, so each run asks which dealers are currently at 8 and sends only
 * to those. A dealer in Denver gets theirs two hours after one in Port Orange,
 * from the same schedule.
 *
 * This is a dealer notification, not customer marketing -- it goes to the
 * number the dealer entered themselves, which is the use case the toll-free is
 * verified for ("notifications exclusively to the dealer").
 */

export const dynamic = 'force-dynamic';

/** The dealer's local hour right now, e.g. 8. */
function localHour(tz: string): number {
  return Number(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date())
  );
}

/** Today's date in the dealer's timezone, as YYYY-MM-DD. */
function localDate(tz: string): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz });
}

/** The UTC instants that bound the dealer's local day. */
function dayBounds(tz: string): { start: string; end: string } {
  const date = localDate(tz);
  // Offset for this zone today, taken from a known instant so DST is handled.
  const probe = new Date(date + 'T12:00:00Z');
  const asLocal = new Date(probe.toLocaleString('en-US', { timeZone: tz }));
  const asUtc = new Date(probe.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offsetMs = asUtc.getTime() - asLocal.getTime();
  const startLocalNoon = new Date(date + 'T00:00:00Z').getTime() + offsetMs;
  return {
    start: new Date(startLocalNoon).toISOString(),
    end: new Date(startLocalNoon + 86400000).toISOString(),
  };
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization') || '';
  const secret = process.env.CRON_SECRET;
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = getServiceClient();
  const results: Array<Record<string, unknown>> = [];

  try {
    const { data: dealers } = await db
      .from('dealers')
      .select('id, business_name, twilio_phone, active, settings')
      .eq('active', true);

    for (const d of dealers || []) {
      const s = (d.settings || {}) as Record<string, unknown>;
      const tz = (s.timezone as string) || 'America/Chicago';
      const name = d.business_name as string;

      // A seeded storefront must never text a real person.
      if (s.demo === true) { results.push({ dealer: name, skipped: 'demo dealer' }); continue; }

      if (localHour(tz) !== 8) continue;

      const notify = (s.lead_notify_phone as string) || '';
      if (!notify) { results.push({ dealer: name, skipped: 'no notify number' }); continue; }

      const today = localDate(tz);
      // Sent once per local day, so an hourly schedule cannot repeat it.
      if (s.last_daily_digest === today) { results.push({ dealer: name, skipped: 'already sent today' }); continue; }

      const { start, end } = dayBounds(tz);
      const { data: appts } = await db
        .from('appointments')
        .select('scheduled_at, type, notes, lead:leads!inner(customer_name, phone)')
        .eq('dealer_id', d.id)
        .in('status', ['scheduled', 'confirmed'])
        .gte('scheduled_at', start)
        .lt('scheduled_at', end)
        .order('scheduled_at', { ascending: true });

      // Nothing on today is not worth a text. A dealer who gets "you have 0
      // appointments" every morning stops reading the ones that matter.
      if (!appts || appts.length === 0) { results.push({ dealer: name, skipped: 'nothing booked today' }); continue; }

      const lines = appts.map((a) => {
        const when = new Date(a.scheduled_at as string)
          .toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
        const lead = (a.lead || {}) as { customer_name?: string; phone?: string };
        const who = lead.customer_name || lead.phone || 'a customer';
        const kind = a.type === 'phone_call' ? 'call' : a.type === 'delivery' ? 'delivery' : '';
        return `${when} ${who}${kind ? ' (' + kind + ')' : ''}`;
      });

      const count = appts.length;
      const body =
        `Bed Sync: ${count} appointment${count === 1 ? '' : 's'} today at ${name} — ` +
        lines.join(', ') +
        `. Details in your dashboard. Reply STOP to opt out.`;

      try {
        await sendSms(notify, body, (d.twilio_phone as string) || undefined);
        await db.from('dealers')
          .update({ settings: { ...s, last_daily_digest: today } })
          .eq('id', d.id);
        results.push({ dealer: name, sent: true, appointments: count });
      } catch (err) {
        console.error(`[Daily Appointments] ${name}:`, (err as Error).message);
        results.push({ dealer: name, sent: false, error: (err as Error).message });
      }
    }

    return NextResponse.json({ success: true, results });
  } catch (err) {
    console.error('[Daily Appointments] Error:', err);
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}

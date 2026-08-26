import { getServiceClient } from '../supabase';
import { sendAndTrack } from '../sms';
import type { DealerSettings } from '../types';

/**
 * Appointment reminders.
 * Sends one friendly SMS reminder before each upcoming appointment (calls or
 * showroom visits) — the #1 lever against no-shows for an appointment-based
 * business. Dedupes via an agent_logs entry per appointment (no schema change).
 * Run from the existing follow-up cron (every 5 min).
 */
const WINDOW_MINUTES = 180; // remind when the appointment is within the next 3 hours

/**
 * No reminder before this hour, in the store's own timezone.
 *
 * The three-hour window alone has no sense of time of day: a 9am appointment
 * reminded at 6am, and an early one could text someone in the middle of the
 * night. Holding until 7:30 costs nothing — the follow-up cron runs every five
 * minutes, so a held reminder goes out shortly after the floor passes, and an
 * 8am appointment still gets half an hour of notice.
 */
const EARLIEST_LOCAL_HOUR = 7;
const EARLIEST_LOCAL_MINUTE = 30;

/** Wall-clock hour and minute at `at`, in the given timezone. */
function localHourMinute(timeZone: string, at: Date): { hour: number; minute: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(at);
    // Intl reports midnight as 24 in some environments; normalise it.
    const hour = Number(parts.find((x) => x.type === 'hour')?.value ?? '0') % 24;
    const minute = Number(parts.find((x) => x.type === 'minute')?.value ?? '0');
    return { hour, minute };
  } catch {
    // An unknown timezone must not silently unlock 3am texts, so treat it as
    // too early and let the next run try again once it is safely daytime UTC.
    return { hour: 0, minute: 0 };
  }
}

/** Whether it is late enough, where this store is, to text a customer. */
function isPastQuietHours(timeZone: string, at: Date): boolean {
  const { hour, minute } = localHourMinute(timeZone, at);
  if (hour > EARLIEST_LOCAL_HOUR) return true;
  if (hour < EARLIEST_LOCAL_HOUR) return false;
  return minute >= EARLIEST_LOCAL_MINUTE;
}

export async function processPendingReminders(): Promise<number> {
  const db = getServiceClient();
  const now = new Date();
  const windowEnd = new Date(now.getTime() + WINDOW_MINUTES * 60 * 1000);

  // Upcoming appointments inside the reminder window
  const { data: appts, error } = await db
    .from('appointments')
    .select(`
      id, dealer_id, conversation_id, scheduled_at, type, status,
      conversation:conversations!inner( id, status, lead:leads!inner(phone, customer_name) ),
      dealer:dealers!inner( id, business_name, settings )
    `)
    .in('status', ['scheduled', 'confirmed'])
    .gt('scheduled_at', now.toISOString())
    .lte('scheduled_at', windowEnd.toISOString())
    .limit(100);

  if (error) { console.error('[Reminders] query error:', error.message); return 0; }
  if (!appts || appts.length === 0) return 0;

  // Which of these already got a reminder? Dedupe via agent_logs using the
  // allowed 'tool_call' action. Key on appointment_id + scheduled_at so a
  // rescheduled appointment (new time) correctly gets a fresh reminder.
  const convIds = [...new Set(appts.map((a: any) => a.conversation_id))];
  const { data: logs } = await db
    .from('agent_logs')
    .select('details')
    .eq('action', 'tool_call')
    .in('conversation_id', convIds);
  const reminded = new Set(
    (logs || [])
      .filter((l: any) => l.details && l.details.tool === 'appointment_reminder')
      .map((l: any) => `${l.details.appointment_id}|${new Date(l.details.scheduled_at).toISOString()}`)
  );

  let sent = 0;
  for (const a of appts as any[]) {
    if (reminded.has(`${a.id}|${new Date(a.scheduled_at).toISOString()}`)) continue;
    const conv = a.conversation;
    const dealer = a.dealer;
    if (!conv || conv.status === 'closed' || conv.status === 'handed_off') continue;
    const phone = conv.lead && conv.lead.phone;
    if (!phone) continue;

    const settings = (dealer.settings || {}) as DealerSettings;
    const tz = settings.timezone || 'America/Chicago';

    // Too early where they are: leave it pending. The appointment stays inside
    // the window until it starts, so this run simply skips and a later one sends.
    if (!isPastQuietHours(tz, now)) {
      continue;
    }
    const when = new Date(a.scheduled_at).toLocaleString('en-US', {
      timeZone: tz, weekday: 'long', hour: 'numeric', minute: '2-digit',
    });
    const first = conv.lead.customer_name ? ` ${String(conv.lead.customer_name).split(' ')[0]}` : '';
    const kind = a.type === 'phone_call' ? 'call' : 'visit';

    const message = `Hi${first}! Friendly reminder about your ${kind} with ${dealer.business_name} on ${when}. They're looking forward to it — just reply here if you need to reschedule.`;

    try {
      await sendAndTrack(a.dealer_id, a.conversation_id, phone, message, 'agent');
      const { error: logErr } = await db.from('agent_logs').insert({
        conversation_id: a.conversation_id,
        action: 'tool_call',
        details: { tool: 'appointment_reminder', appointment_id: a.id, scheduled_at: new Date(a.scheduled_at).toISOString() },
      });
      if (logErr) console.error('[Reminders] dedup log failed:', logErr.message);
      sent++;
    } catch (err) {
      console.error('[Reminders] send error for appointment', a.id, err);
    }
  }

  return sent;
}

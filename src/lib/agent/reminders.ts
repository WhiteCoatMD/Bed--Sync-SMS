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

  // Which of these already had a reminder sent? (dedupe via agent_logs)
  const convIds = [...new Set(appts.map((a: any) => a.conversation_id))];
  const { data: logs } = await db
    .from('agent_logs')
    .select('details')
    .eq('action', 'appointment_reminder_sent')
    .in('conversation_id', convIds);
  const reminded = new Set(
    (logs || []).map((l: any) => l.details && l.details.appointment_id).filter(Boolean)
  );

  let sent = 0;
  for (const a of appts as any[]) {
    if (reminded.has(a.id)) continue;
    const conv = a.conversation;
    const dealer = a.dealer;
    if (!conv || conv.status === 'closed' || conv.status === 'handed_off') continue;
    const phone = conv.lead && conv.lead.phone;
    if (!phone) continue;

    const settings = (dealer.settings || {}) as DealerSettings;
    const tz = settings.timezone || 'America/Chicago';
    const when = new Date(a.scheduled_at).toLocaleString('en-US', {
      timeZone: tz, weekday: 'long', hour: 'numeric', minute: '2-digit',
    });
    const first = conv.lead.customer_name ? ` ${String(conv.lead.customer_name).split(' ')[0]}` : '';
    const kind = a.type === 'phone_call' ? 'call' : 'visit';

    const message = `Hi${first}! Friendly reminder about your ${kind} with ${dealer.business_name} on ${when}. We're looking forward to it — just reply here if you need to reschedule.`;

    try {
      await sendAndTrack(a.dealer_id, a.conversation_id, phone, message, 'agent');
      await db.from('agent_logs').insert({
        conversation_id: a.conversation_id,
        action: 'appointment_reminder_sent',
        details: { appointment_id: a.id, scheduled_at: a.scheduled_at },
      });
      sent++;
    } catch (err) {
      console.error('[Reminders] send error for appointment', a.id, err);
    }
  }

  return sent;
}

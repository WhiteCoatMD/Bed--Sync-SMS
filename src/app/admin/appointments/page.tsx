'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { resolveAdminSession } from '@/lib/admin-session';
import AvailabilityPanel, { type Blackout, type DayHours } from './AvailabilityPanel';
import { zonedWallClockToUtcIso } from '@/lib/business-hours';


interface Appointment {
  id: string;
  type: string;
  scheduled_at: string;
  duration_minutes: number;
  status: string;
  notes: string | null;
  created_by: string;
  lead: { id: string; phone: string; customer_name: string | null };
  conversation: { id: string; status: string };
}

/**
 * A manual booking with no number stores a non-numeric placeholder, which must
 * never be offered as something to dial.
 */
function callable_(phone: string | null | undefined): boolean {
  // Count digits anywhere, not seven in a row: a dealer types 386-555-0147 and
  // that has four consecutive digits at most, which would have hidden their
  // customer's number precisely when they wanted to ring it.
  return !!phone && phone.replace(/\D/g, '').length >= 7;
}

/** +13865550147 -> (386) 555-0147 */
function prettyPhone(phone: string): string {
  const d = phone.replace(/\D/g, '');
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  if (ten.length !== 10) return phone;
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}

const STATUS_COLORS: Record<string, string> = {
  scheduled: 'bg-blue-500/15 text-blue-300 border border-blue-500/30',
  confirmed: 'bg-green-500/15 text-green-300 border border-green-500/30',
  completed: 'bg-ink-card/5 text-ink-muted border border-ink-border',
  cancelled: 'bg-red-500/15 text-red-300 border border-red-500/30',
  no_show: 'bg-yellow-500/15 text-yellow-300 border border-yellow-500/30',
};

const TYPE_ICONS: Record<string, string> = {
  showroom_visit: '🏪',
  phone_call: '📞',
  delivery: '🚚',
  other: '📋',
};

export default function AppointmentsPage() {
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [dealerId, setDealerId] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [view, setView] = useState<'upcoming' | 'past'>('upcoming');
  const [updating, setUpdating] = useState<string | null>(null);
  // Blocking time off is an appointment-only need: an MBA dealer sees one
  // customer at a time, so a week away has to stop bookings outright. A
  // walk-in store just has nobody booked that day.
  const [dealerType, setDealerType] = useState<string | null>(null);
  const [blackouts, setBlackouts] = useState<Blackout[]>([]);
  const [dayHours, setDayHours] = useState<Record<string, DayHours> | null>(null);
  // Manual booking: a walk-in or a phone call the dealer takes themselves.
  const [showAdd, setShowAdd] = useState(false);
  const [addName, setAddName] = useState('');
  const [addPhone, setAddPhone] = useState('');
  const [addWhen, setAddWhen] = useState('');
  const [addType, setAddType] = useState('showroom_visit');
  const [addNotes, setAddNotes] = useState('');
  const [addErr, setAddErr] = useState<string | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  // Store timezone, so a dealer viewing from another zone (or a franchisor,
  // or a travelling owner) still sees the time the customer will arrive.
  const [timezone, setTimezone] = useState<string | undefined>(undefined);

  useEffect(() => { authenticate(); }, []);
  useEffect(() => { if (dealerId) fetchAppointments(); }, [dealerId, view]);

  async function authenticate() {
    const { token, overrideDealerId } = resolveAdminSession('/admin/appointments');
    if (!token) { setAuthError('Not authenticated.'); setLoading(false); return; }
    try {
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, dealer_id: overrideDealerId }),
      });
      const data = await res.json();
      if (data.success && data.dealer_id) {
        setTimezone(data.timezone || undefined);
        setDealerId(data.dealer_id);
        setDealerType(data.dealer_type || null);
        setBlackouts(Array.isArray(data.blackouts) ? data.blackouts : []);
        setDayHours(data.day_hours || null);
      } else {
        setAuthError('Not authorized.');
        setLoading(false);
      }
    } catch {
      setAuthError('Auth failed.');
      setLoading(false);
    }
  }

  /** Bed Sync token for the appointments API, which now scopes by dealer. */
  function authHeaders(): Record<string, string> {
    const token = localStorage.getItem('sms_auth_token') || localStorage.getItem('auth_token');
    return token ? { Authorization: 'Bearer ' + token } : {};
  }

  async function fetchAppointments() {
    if (!dealerId) return;
    const now = new Date().toISOString();
    const params = view === 'upcoming'
      ? `dealer_id=${dealerId}&from=${now}`
      : `dealer_id=${dealerId}&to=${now}`;
    try {
      const res = await fetch(`/api/appointments?${params}`, { headers: authHeaders() });
      const data = await res.json();
      const sorted = (data.appointments || []).sort((a: Appointment, b: Appointment) => {
        const diff = new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime();
        return view === 'upcoming' ? diff : -diff;
      });
      setAppointments(sorted);
    } catch (err) {
      console.error('Fetch error:', err);
    }
    setLoading(false);
  }

  /** Dates that already have an appointment, so the calendar can warn. */
  const bookedDates = new Set(
    appointments
      .filter((a) => a.status === 'scheduled' || a.status === 'confirmed')
      .map((a) => new Date(a.scheduled_at).toLocaleDateString('en-CA', { timeZone: timezone }))
  );

  /** Booked times per date, so the day panel can show what is already on. */
  const appointmentsByDate: Record<string, { time: string; who: string }[]> = {};
  for (const a of appointments) {
    if (a.status !== 'scheduled' && a.status !== 'confirmed') continue;
    const key = new Date(a.scheduled_at).toLocaleDateString('en-CA', { timeZone: timezone });
    (appointmentsByDate[key] ||= []).push({
      time: new Date(a.scheduled_at).toLocaleTimeString('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' }),
      who: a.lead?.customer_name || a.lead?.phone || '',
    });
  }

  async function addAppointment() {
    setAddErr(null);
    if (!addName.trim() && !addPhone.trim()) { setAddErr('Add a name or a phone number.'); return; }
    if (!addWhen) { setAddErr('Pick a date and time.'); return; }
    setAddBusy(true);
    try {
      // The picker gives store-local wall clock; send the real instant so the
      // booking means the same moment to the dealer and to the assistant.
      const scheduled_at = zonedWallClockToUtcIso(addWhen.replace('T', ' ') + ':00', timezone || 'America/Chicago');
      const res = await fetch('/api/appointments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          dealer_id: dealerId,
          customer_name: addName.trim() || null,
          phone: addPhone.trim() || null,
          scheduled_at,
          type: addType,
          notes: addNotes.trim() || null,
          created_by: 'human',
        }),
      });
      const data = await res.json();
      if (res.status === 409) {
        const at = new Date(data.conflict_at).toLocaleString('en-US',
          { timeZone: timezone, weekday: 'short', hour: 'numeric', minute: '2-digit' });
        setAddErr(`You already have an appointment at ${at}. Pick another time.`);
        return;
      }
      if (!res.ok || !data.success) { setAddErr(data.error || 'Could not add it.'); return; }
      setAddName(''); setAddPhone(''); setAddWhen(''); setAddNotes('');
      setShowAdd(false);
      await fetchAppointments();
    } catch (e) {
      setAddErr((e as Error).message);
    } finally {
      setAddBusy(false);
    }
  }

  async function saveAvailability(patch: { day_hours: Record<string, DayHours>; blackouts: Blackout[] }) {
    try {
      const res = await fetch('/api/dealers/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ dealer_id: dealerId, settings: patch }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) return false;
      setBlackouts(patch.blackouts);
      setDayHours(patch.day_hours);
      return true;
    } catch {
      return false;
    }
  }

  async function updateStatus(id: string, status: string) {
    setUpdating(id);
    await fetch('/api/appointments', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ id, status }),
    });
    await fetchAppointments();
    setUpdating(null);
  }

  if (authError) {
    return (
      <div className="text-center py-20">
        <p className="text-ink-muted">{authError}</p>
        <a href="https://www.bed-sync.com/admin.html" className="mt-4 inline-block text-brand-900 underline">
          Go to Bed Sync Admin
        </a>
      </div>
    );
  }

  // Group by day
  const grouped: Record<string, Appointment[]> = {};
  appointments.forEach((a) => {
    const day = new Date(a.scheduled_at).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric', timeZone: timezone });
    if (!grouped[day]) grouped[day] = [];
    grouped[day].push(a);
  });

  // The old panel asked for two datetime-local values to say "I am away next
  // week". Replaced by an availability editor: weekly hours plus a month
  // calendar you click. Same two settings underneath.
  const blockPanel = dealerType === 'mba' ? (
    <AvailabilityPanel
      timezone={timezone || 'America/Chicago'}
      initialDayHours={dayHours}
      initialBlackouts={blackouts}
      bookedDates={bookedDates}
      appointmentsByDate={appointmentsByDate}
      onSave={saveAvailability}
    />
  ) : null;

  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-ink-text">Appointments</h1>
          <p className="text-sm text-ink-muted">Scheduled calls and showroom visits</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex bg-ink-hover rounded-lg p-0.5">
            <button
              onClick={() => setView('upcoming')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition ${view === 'upcoming' ? 'bg-ink-card shadow text-ink-text' : 'text-ink-muted'}`}
            >
              Upcoming
            </button>
            <button
              onClick={() => setView('past')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition ${view === 'past' ? 'bg-ink-card shadow text-ink-text' : 'text-ink-muted'}`}
            >
              Past
            </button>
          </div>
          <Link href="/admin" className="text-sm text-brand-900 hover:underline">
            Conversations
          </Link>
        </div>
      </div>

      <div className="bg-ink-card border border-ink-border rounded-xl p-4 mb-6">
        <button
          onClick={() => setShowAdd((v) => !v)}
          className="w-full flex items-center gap-3 text-left"
          aria-expanded={showAdd}
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-brand-600/15 text-lg" aria-hidden>
            &#10133;
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-ink-text">Add an appointment</span>
            <span className="block text-xs text-ink-muted">Someone who called or walked in</span>
          </span>
          <span className="flex items-center gap-1.5 shrink-0 rounded-full bg-brand-600 px-3 py-1 text-xs font-semibold text-white">
            {showAdd ? 'Close' : 'Add'}
            <span aria-hidden>{showAdd ? '\u25B4' : '\u25BE'}</span>
          </span>
        </button>

        {showAdd && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-ink-muted">
              Customer name
              <input value={addName} onChange={(e) => setAddName(e.target.value)} maxLength={80}
                placeholder="Sarah Nguyen"
                className="mt-1 block w-full bg-ink-hover border border-ink-border rounded-md px-2 py-1.5 text-sm text-ink-text placeholder-ink-faint" />
            </label>
            <label className="text-xs text-ink-muted">
              Phone <span className="text-ink-faint">(optional)</span>
              <input value={addPhone} onChange={(e) => setAddPhone(e.target.value)} maxLength={20}
                placeholder="386-555-0100"
                className="mt-1 block w-full bg-ink-hover border border-ink-border rounded-md px-2 py-1.5 text-sm text-ink-text placeholder-ink-faint" />
            </label>
            <label className="text-xs text-ink-muted">
              Date and time
              <input type="datetime-local" value={addWhen} onChange={(e) => setAddWhen(e.target.value)}
                className="mt-1 block w-full bg-ink-hover border border-ink-border rounded-md px-2 py-1.5 text-sm text-ink-text" />
            </label>
            <label className="text-xs text-ink-muted">
              Type
              <select value={addType} onChange={(e) => setAddType(e.target.value)}
                className="mt-1 block w-full bg-ink-hover border border-ink-border rounded-md px-2 py-1.5 text-sm text-ink-text">
                <option value="showroom_visit">Showroom visit</option>
                <option value="phone_call">Phone call</option>
                <option value="delivery">Delivery</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label className="text-xs text-ink-muted sm:col-span-2">
              Notes <span className="text-ink-faint">(optional)</span>
              <input value={addNotes} onChange={(e) => setAddNotes(e.target.value)} maxLength={200}
                placeholder="Queen, side sleeper"
                className="mt-1 block w-full bg-ink-hover border border-ink-border rounded-md px-2 py-1.5 text-sm text-ink-text placeholder-ink-faint" />
            </label>

            <div className="sm:col-span-2 flex items-center gap-3">
              <button onClick={addAppointment} disabled={addBusy}
                className="bg-brand-600 text-white text-sm font-semibold px-4 py-1.5 rounded-md disabled:opacity-50">
                {addBusy ? 'Adding\u2026' : 'Add appointment'}
              </button>
              <span className="text-xs text-ink-faint">
                We will not text them &mdash; they have not opted in.
              </span>
            </div>
            {addErr && <p className="sm:col-span-2 text-xs text-red-400">{addErr}</p>}
          </div>
        )}
      </div>

      {blockPanel}

      {loading ? (
        <div className="text-center py-12 text-ink-faint">Loading...</div>
      ) : appointments.length === 0 ? (
        <div className="text-center py-16">
          <div className="text-4xl mb-3">📅</div>
          <p className="text-ink-faint">
            {view === 'upcoming' ? 'No upcoming appointments.' : 'No past appointments.'}
          </p>
          <p className="text-xs text-ink-faint mt-1">Appointments are created when the AI schedules a call or visit with a customer.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(grouped).map(([day, appts]) => (
            <div key={day}>
              <h2 className="text-xs font-bold text-ink-faint uppercase tracking-wide mb-2">{day}</h2>
              <div className="space-y-2">
                {appts.map((a) => {
                  const time = new Date(a.scheduled_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: timezone });
                  const isActive = a.status === 'scheduled' || a.status === 'confirmed';
                  return (
                    <div
                      key={a.id}
                      className={`bg-ink-card rounded-xl border p-4 transition ${isActive ? 'border-ink-border shadow-sm' : 'border-ink-border opacity-75'}`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="text-2xl">{TYPE_ICONS[a.type] || '📋'}</div>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-sm text-ink-text">
                                {a.lead.customer_name || a.lead.phone}
                              </span>
                              <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS[a.status] || 'bg-ink-hover'}`}>
                                {a.status}
                              </span>
                              {a.created_by === 'agent' && (
                                <span className="text-[10px] bg-purple-50 text-purple-600 px-1.5 py-0.5 rounded">AI scheduled</span>
                              )}
                            </div>
                            {callable_(a.lead.phone) && (
                              <a
                                href={`tel:${a.lead.phone}`}
                                className="inline-flex items-center gap-1 mt-1 text-xs font-medium text-brand-600 hover:underline"
                                title="Call this customer"
                              >
                                <span aria-hidden>&#128222;</span>
                                {prettyPhone(a.lead.phone)}
                              </a>
                            )}
                            <div className="text-xs text-ink-muted mt-0.5">
                              <span className="font-medium">{time}</span>
                              <span className="mx-1.5">·</span>
                              <span>{a.type.replace('_', ' ')}</span>
                              <span className="mx-1.5">·</span>
                              <span>{a.duration_minutes}min</span>
                              {a.notes && (
                                <>
                                  <span className="mx-1.5">·</span>
                                  <span className="text-ink-faint">{a.notes}</span>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Link
                            href={`/admin/conversations/${a.conversation.id}`}
                            className="text-xs text-brand-900 hover:underline"
                          >
                            View chat
                          </Link>
                          {isActive && (
                            <>
                              <button
                                onClick={() => updateStatus(a.id, 'completed')}
                                disabled={updating === a.id}
                                className="text-xs px-2.5 py-1 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 disabled:opacity-50"
                              >
                                Done
                              </button>
                              <button
                                onClick={() => updateStatus(a.id, 'no_show')}
                                disabled={updating === a.id}
                                className="text-xs px-2.5 py-1 bg-yellow-500 text-white rounded-lg font-medium hover:bg-yellow-600 disabled:opacity-50"
                              >
                                No-show
                              </button>
                              <button
                                onClick={() => updateStatus(a.id, 'cancelled')}
                                disabled={updating === a.id}
                                className="text-xs px-2.5 py-1 bg-ink-hover text-ink-muted rounded-lg font-medium hover:bg-gray-300 disabled:opacity-50"
                              >
                                Cancel
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

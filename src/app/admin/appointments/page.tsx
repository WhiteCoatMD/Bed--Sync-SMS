'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

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

const STATUS_COLORS: Record<string, string> = {
  scheduled: 'bg-blue-100 text-blue-800',
  confirmed: 'bg-green-100 text-green-800',
  completed: 'bg-gray-100 text-gray-600',
  cancelled: 'bg-red-100 text-red-600',
  no_show: 'bg-yellow-100 text-yellow-800',
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
  // Store timezone, so a dealer viewing from another zone (or a franchisor,
  // or a travelling owner) still sees the time the customer will arrive.
  const [timezone, setTimezone] = useState<string | undefined>(undefined);

  useEffect(() => { authenticate(); }, []);
  useEffect(() => { if (dealerId) fetchAppointments(); }, [dealerId, view]);

  async function authenticate() {
    // Capture token + dealer_id from the URL (super-admin switcher deep-links
    // straight here), persist them, then strip them from the address bar.
    const sp = new URLSearchParams(window.location.search);
    const tokenParam = sp.get('token');
    if (tokenParam) localStorage.setItem('sms_auth_token', tokenParam);
    const dealerParam = sp.get('dealer_id');
    if (dealerParam) localStorage.setItem('sms_dealer_override', dealerParam);
    if (tokenParam || dealerParam) window.history.replaceState({}, '', '/admin/appointments');
    const token = localStorage.getItem('sms_auth_token') || localStorage.getItem('auth_token');
    if (!token) { setAuthError('Not authenticated.'); setLoading(false); return; }
    const overrideDealerId = localStorage.getItem('sms_dealer_override') || undefined;
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
      } else {
        setAuthError('Not authorized.');
        setLoading(false);
      }
    } catch {
      setAuthError('Auth failed.');
      setLoading(false);
    }
  }

  async function fetchAppointments() {
    if (!dealerId) return;
    const now = new Date().toISOString();
    const params = view === 'upcoming'
      ? `dealer_id=${dealerId}&from=${now}`
      : `dealer_id=${dealerId}&to=${now}`;
    try {
      const res = await fetch(`/api/appointments?${params}`);
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

  async function updateStatus(id: string, status: string) {
    setUpdating(id);
    await fetch('/api/appointments', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status }),
    });
    await fetchAppointments();
    setUpdating(null);
  }

  if (authError) {
    return (
      <div className="text-center py-20">
        <p className="text-gray-500">{authError}</p>
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

  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Appointments</h1>
          <p className="text-sm text-gray-500">Scheduled calls and showroom visits</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex bg-gray-100 rounded-lg p-0.5">
            <button
              onClick={() => setView('upcoming')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition ${view === 'upcoming' ? 'bg-white shadow text-gray-900' : 'text-gray-500'}`}
            >
              Upcoming
            </button>
            <button
              onClick={() => setView('past')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition ${view === 'past' ? 'bg-white shadow text-gray-900' : 'text-gray-500'}`}
            >
              Past
            </button>
          </div>
          <Link href="/admin" className="text-sm text-brand-900 hover:underline">
            Conversations
          </Link>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading...</div>
      ) : appointments.length === 0 ? (
        <div className="text-center py-16">
          <div className="text-4xl mb-3">📅</div>
          <p className="text-gray-400">
            {view === 'upcoming' ? 'No upcoming appointments.' : 'No past appointments.'}
          </p>
          <p className="text-xs text-gray-300 mt-1">Appointments are created when the AI schedules a call or visit with a customer.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(grouped).map(([day, appts]) => (
            <div key={day}>
              <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-2">{day}</h2>
              <div className="space-y-2">
                {appts.map((a) => {
                  const time = new Date(a.scheduled_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: timezone });
                  const isActive = a.status === 'scheduled' || a.status === 'confirmed';
                  return (
                    <div
                      key={a.id}
                      className={`bg-white rounded-xl border p-4 transition ${isActive ? 'border-gray-200 shadow-sm' : 'border-gray-100 opacity-75'}`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="text-2xl">{TYPE_ICONS[a.type] || '📋'}</div>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-sm text-gray-900">
                                {a.lead.customer_name || a.lead.phone}
                              </span>
                              <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS[a.status] || 'bg-gray-100'}`}>
                                {a.status}
                              </span>
                              {a.created_by === 'agent' && (
                                <span className="text-[10px] bg-purple-50 text-purple-600 px-1.5 py-0.5 rounded">AI scheduled</span>
                              )}
                            </div>
                            <div className="text-xs text-gray-500 mt-0.5">
                              <span className="font-medium">{time}</span>
                              <span className="mx-1.5">·</span>
                              <span>{a.type.replace('_', ' ')}</span>
                              <span className="mx-1.5">·</span>
                              <span>{a.duration_minutes}min</span>
                              {a.notes && (
                                <>
                                  <span className="mx-1.5">·</span>
                                  <span className="text-gray-400">{a.notes}</span>
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
                                className="text-xs px-2.5 py-1 bg-gray-200 text-gray-600 rounded-lg font-medium hover:bg-gray-300 disabled:opacity-50"
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

'use client';

/**
 * Availability editor for appointment-only dealers.
 *
 * Two controls, because availability is really two questions and cramming them
 * into one is what made the first version cumbersome:
 *
 *   1. Weekly hours  - "when do I normally take appointments"
 *   2. Time off      - "which specific days am I away"
 *
 * That split is the settled pattern in this space (Calendly calls them weekly
 * hours and date-specific hours; Cal.com calls them schedules and date
 * overrides). It beats a single calendar because a dealer sets the weekly part
 * once and then only ever touches the exceptions.
 *
 * The first version asked for two datetime-local values and a reason, which
 * meant typing an exact timestamp to say "I'm away next week". Here that is
 * clicking the days.
 */

import { useMemo, useState } from 'react';
import { zonedWallClockToUtcIso } from '@/lib/business-hours';

export interface Blackout { start: string; end: string; reason?: string }
export interface DayHours { open: boolean; start: string; end: string }

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/** A sane starting point for a dealer who has never set hours. */
const DEFAULT_DAY: DayHours = { open: true, start: '10:00', end: '18:00' };

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Whole-day block for `date` (YYYY-MM-DD) in the store's timezone. */
function fullDayBlackout(date: string, tz: string, reason?: string): Blackout {
  const next = new Date(date + 'T12:00:00Z');
  next.setUTCDate(next.getUTCDate() + 1);
  return {
    start: zonedWallClockToUtcIso(date + ' 00:00:00', tz),
    end: zonedWallClockToUtcIso(ymd(next) + ' 00:00:00', tz),
    reason,
  };
}

/** Which dates a set of blackouts covers for the whole day, for the calendar. */
function blockedDates(blackouts: Blackout[], tz: string): Set<string> {
  const out = new Set<string>();
  for (const b of blackouts) {
    const start = new Date(b.start);
    const end = new Date(b.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    // Walk day by day so a multi-day block lights up every date it covers.
    for (let t = start.getTime(); t < end.getTime(); t += 86400000) {
      const local = new Date(t).toLocaleDateString('en-CA', { timeZone: tz });
      out.add(local);
    }
  }
  return out;
}

export default function AvailabilityPanel({
  timezone,
  initialDayHours,
  initialBlackouts,
  bookedDates,
  onSave,
}: {
  timezone: string;
  initialDayHours: Record<string, DayHours> | null;
  initialBlackouts: Blackout[];
  bookedDates: Set<string>;
  onSave: (patch: { day_hours: Record<string, DayHours>; blackouts: Blackout[] }) => Promise<boolean>;
}) {
  const [dayHours, setDayHours] = useState<Record<string, DayHours>>(() => {
    const base: Record<string, DayHours> = {};
    for (let i = 0; i < 7; i++) {
      base[String(i)] = initialDayHours?.[String(i)] ?? { ...DEFAULT_DAY, open: i !== 0 };
    }
    return base;
  });
  const [blackouts, setBlackouts] = useState<Blackout[]>(initialBlackouts);
  const [cursor, setCursor] = useState(() => new Date());
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const blocked = useMemo(() => blockedDates(blackouts, timezone), [blackouts, timezone]);

  const grid = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const cells: (Date | null)[] = Array(first.getDay()).fill(null);
    const days = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
    for (let d = 1; d <= days; d++) cells.push(new Date(cursor.getFullYear(), cursor.getMonth(), d));
    while (cells.length % 7) cells.push(null);
    return cells;
  }, [cursor]);

  function setDay(i: number, patch: Partial<DayHours>) {
    setDayHours((prev) => ({ ...prev, [String(i)]: { ...prev[String(i)], ...patch } }));
    setDirty(true);
  }

  function copyToWeekdays(i: number) {
    const src = dayHours[String(i)];
    setDayHours((prev) => {
      const next = { ...prev };
      for (let d = 1; d <= 5; d++) next[String(d)] = { ...src };
      return next;
    });
    setDirty(true);
  }

  function toggleDate(d: Date) {
    const key = ymd(d);
    if (blocked.has(key)) {
      // Drop any blackout that covers this date.
      setBlackouts((prev) =>
        prev.filter((b) => !blockedDates([b], timezone).has(key))
      );
    } else {
      setBlackouts((prev) => [...prev, fullDayBlackout(key, timezone)]
        .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()));
    }
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    setMsg(null);
    const ok = await onSave({ day_hours: dayHours, blackouts });
    setSaving(false);
    setMsg(ok ? 'Saved. Your assistant is using this now.' : 'Could not save — try again.');
    if (ok) setDirty(false);
  }

  const today = ymd(new Date());
  const monthLabel = cursor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 mb-6">
      <div className="flex items-baseline justify-between mb-1">
        <h2 className="text-sm font-semibold text-gray-900">Your availability</h2>
        <span className="text-xs text-gray-400">times shown in your store&apos;s timezone</span>
      </div>
      <p className="text-xs text-gray-500 mb-4">
        Your assistant will only book inside these hours, and never on a day you have blocked.
      </p>

      {/* ---------------- weekly hours ---------------- */}
      <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-2">Weekly hours</h3>
      <div className="border border-gray-100 rounded-lg divide-y divide-gray-100 mb-5">
        {DAY_NAMES.map((name, i) => {
          const d = dayHours[String(i)];
          return (
            <div key={name} className="flex items-center gap-3 px-3 py-2">
              <label className="flex items-center gap-2 w-28 shrink-0 cursor-pointer">
                <input
                  type="checkbox"
                  checked={d.open}
                  onChange={(e) => setDay(i, { open: e.target.checked })}
                  className="h-4 w-4"
                />
                <span className={`text-sm ${d.open ? 'text-gray-900' : 'text-gray-400'}`}>{name}</span>
              </label>

              {d.open ? (
                <div className="flex items-center gap-2">
                  <input
                    type="time"
                    value={d.start}
                    onChange={(e) => setDay(i, { start: e.target.value })}
                    className="border border-gray-300 rounded-md px-2 py-1 text-sm"
                  />
                  <span className="text-gray-400 text-sm">to</span>
                  <input
                    type="time"
                    value={d.end}
                    onChange={(e) => setDay(i, { end: e.target.value })}
                    className="border border-gray-300 rounded-md px-2 py-1 text-sm"
                  />
                </div>
              ) : (
                <span className="text-sm text-gray-400">Closed</span>
              )}

              {i === 1 && d.open && (
                <button
                  onClick={() => copyToWeekdays(i)}
                  className="ml-auto text-xs text-brand-900 hover:underline"
                  title="Use these hours for Monday through Friday"
                >
                  copy to weekdays
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* ---------------- time off ---------------- */}
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wide">Time off</h3>
        <div className="flex items-center gap-2">
          <button onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
            className="px-2 py-0.5 text-gray-500 hover:bg-gray-100 rounded" aria-label="Previous month">&#8249;</button>
          <span className="text-sm font-medium text-gray-800 w-36 text-center">{monthLabel}</span>
          <button onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
            className="px-2 py-0.5 text-gray-500 hover:bg-gray-100 rounded" aria-label="Next month">&#8250;</button>
        </div>
      </div>
      <p className="text-xs text-gray-500 mb-2">Click a day to block it. Click again to unblock.</p>

      <div className="grid grid-cols-7 gap-1 mb-1">
        {DAY_SHORT.map((d, i) => (
          <div key={i} className="text-center text-[0.65rem] font-medium text-gray-400 py-1">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {grid.map((d, i) => {
          if (!d) return <div key={i} />;
          const key = ymd(d);
          const isBlocked = blocked.has(key);
          const isPast = key < today;
          const hasBooking = bookedDates.has(key);
          const weeklyClosed = !dayHours[String(d.getDay())]?.open;
          return (
            <button
              key={i}
              onClick={() => !isPast && toggleDate(d)}
              disabled={isPast}
              title={
                isPast ? 'in the past'
                  : hasBooking ? 'You have an appointment booked this day'
                  : weeklyClosed ? 'Closed by your weekly hours'
                  : isBlocked ? 'Blocked — click to unblock' : 'Click to block this day'
              }
              className={[
                'relative aspect-square rounded-md text-sm transition',
                isPast ? 'text-gray-300 cursor-default'
                  : isBlocked ? 'bg-red-600 text-white font-semibold'
                  : weeklyClosed ? 'bg-gray-100 text-gray-400'
                  : 'bg-white text-gray-800 hover:bg-gray-100 border border-gray-200',
              ].join(' ')}
            >
              {d.getDate()}
              {hasBooking && !isBlocked && (
                <span className="absolute bottom-1 left-1/2 -translate-x-1/2 h-1 w-1 rounded-full bg-blue-500" />
              )}
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-4 mt-3 text-[0.7rem] text-gray-500">
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded bg-red-600" /> blocked</span>
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded bg-gray-100 border border-gray-200" /> closed weekly</span>
        <span className="flex items-center gap-1"><span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-500" /> has a booking</span>
      </div>

      <div className="flex items-center gap-3 mt-4">
        <button
          onClick={save}
          disabled={saving || !dirty}
          className="bg-brand-900 text-white text-sm font-medium px-4 py-1.5 rounded-md disabled:opacity-40"
        >
          {saving ? 'Saving…' : dirty ? 'Save availability' : 'Saved'}
        </button>
        {msg && <span className="text-xs text-gray-500">{msg}</span>}
      </div>
    </div>
  );
}

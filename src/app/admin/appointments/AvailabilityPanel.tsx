'use client';

/**
 * Availability editor. Shown to every dealer: a walk-in store still needs to
 * tell the assistant when it is open and when it is away.
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

/** Block just part of a day, e.g. 14:00-16:00 on 2026-09-10, in store time. */
function partialBlackout(date: string, from: string, to: string, tz: string, reason?: string): Blackout {
  return {
    start: zonedWallClockToUtcIso(`${date} ${from}:00`, tz),
    end: zonedWallClockToUtcIso(`${date} ${to}:00`, tz),
    reason,
  };
}

/** Does this blackout cover the whole of `date` in store time? */
function coversWholeDay(b: Blackout, date: string, tz: string): boolean {
  const dayStart = new Date(zonedWallClockToUtcIso(`${date} 00:00:00`, tz)).getTime();
  const next = new Date(date + 'T12:00:00Z');
  next.setUTCDate(next.getUTCDate() + 1);
  const dayEnd = new Date(zonedWallClockToUtcIso(`${ymd(next)} 00:00:00`, tz)).getTime();
  return new Date(b.start).getTime() <= dayStart && new Date(b.end).getTime() >= dayEnd;
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
  appointmentsByDate,
  onSave,
}: {
  timezone: string;
  initialDayHours: Record<string, DayHours> | null;
  initialBlackouts: Blackout[];
  bookedDates: Set<string>;
  appointmentsByDate: Record<string, { time: string; who: string }[]>;
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
  const [selected, setSelected] = useState<string | null>(null);
  const [fromTime, setFromTime] = useState('12:00');
  const [toTime, setToTime] = useState('14:00');
  const [dayErr, setDayErr] = useState<string | null>(null);
  // Both collapsed by default. A dealer sets hours once and then mostly comes
  // here to read the day's appointments, so the editors should not push the
  // list off the screen. The summary lines mean neither has to be opened to
  // see where things stand.
  const [showHours, setShowHours] = useState(false);
  const [showTimeOff, setShowTimeOff] = useState(false);
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

  const sortBlocks = (list: Blackout[]) =>
    [...list].sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  /** Blocks touching this date, so the day panel can list and remove them. */
  function blocksOn(date: string): Blackout[] {
    return blackouts.filter((b) => blockedDates([b], timezone).has(date));
  }

  function isWholeDayBlocked(date: string) {
    return blocksOn(date).some((b) => coversWholeDay(b, date, timezone));
  }

  function toggleWholeDay(date: string) {
    setDayErr(null);
    if (isWholeDayBlocked(date)) {
      setBlackouts((prev) => prev.filter((b) => !coversWholeDay(b, date, timezone)));
    } else {
      // Replace any part-day blocks on this date -- the whole day covers them.
      const kept = blackouts.filter((b) => !blockedDates([b], timezone).has(date));
      setBlackouts(sortBlocks([...kept, fullDayBlackout(date, timezone)]));
    }
    setDirty(true);
  }

  function addPartial(date: string) {
    setDayErr(null);
    if (fromTime >= toTime) { setDayErr('The end time has to be after the start.'); return; }
    setBlackouts((prev) => sortBlocks([...prev, partialBlackout(date, fromTime, toTime, timezone)]));
    setDirty(true);
  }

  function removeBlock(b: Blackout) {
    setBlackouts((prev) => prev.filter((x) => !(x.start === b.start && x.end === b.end)));
    setDirty(true);
  }

  const hhmm = (iso: string) =>
    new Date(iso).toLocaleTimeString('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' });

  async function save() {
    setSaving(true);
    setMsg(null);
    const ok = await onSave({ day_hours: dayHours, blackouts });
    setSaving(false);
    setMsg(ok ? 'Saved. Your assistant is using this now.' : 'Could not save — try again.');
    if (ok) setDirty(false);
  }

  /** e.g. "Mon-Sat 11:00-19:00, Sun closed" or "Varies by day". */
  function weeklySummary() {
    const open: number[] = [];
    const closed: number[] = [];
    for (let i = 0; i < 7; i++) {
      const d = dayHours[String(i)];
      (d?.open ? open : closed).push(i);
    }
    if (open.length === 0) return 'Closed every day';
    const first = dayHours[String(open[0])];
    const uniform = open.every((i) => dayHours[String(i)].start === first.start
      && dayHours[String(i)].end === first.end);
    const openLabel = uniform
      ? `${open.map((i) => DAY_NAMES[i].slice(0, 3)).join(', ')} ${first.start}-${first.end}`
      : `${open.length} day${open.length === 1 ? '' : 's'} open, hours vary`;
    return closed.length
      ? `${openLabel} · closed ${closed.map((i) => DAY_NAMES[i].slice(0, 3)).join(', ')}`
      : openLabel;
  }

  /** Only counts what is still ahead -- past blocks are noise. */
  function timeOffSummary() {
    const now = Date.now();
    const upcoming = blackouts.filter((b) => new Date(b.end).getTime() > now);
    if (upcoming.length === 0) return 'Nothing blocked';
    const whole = upcoming.filter((b) => {
      const d = new Date(b.start).toLocaleDateString('en-CA', { timeZone: timezone });
      return coversWholeDay(b, d, timezone);
    }).length;
    const part = upcoming.length - whole;
    const bits: string[] = [];
    if (whole) bits.push(`${whole} day${whole === 1 ? '' : 's'}`);
    if (part) bits.push(`${part} time${part === 1 ? '' : 's'}`);
    return bits.join(' and ') + ' blocked';
  }

  const today = ymd(new Date());
  const monthLabel = cursor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  return (
    <div className="bg-ink-card border border-ink-border rounded-xl p-4 mb-6">
      <div className="flex items-baseline justify-between mb-1">
        <h2 className="text-sm font-semibold text-ink-text">Your availability</h2>
        <span className="text-xs text-ink-faint">times shown in your store&apos;s timezone</span>
      </div>
      <p className="text-xs text-ink-muted mb-4">
        Your assistant only books inside your hours, never on time you have blocked, and
        never two customers at once.
      </p>

      {/* ---------------- weekly hours ---------------- */}
      <button
        onClick={() => setShowHours((v) => !v)}
        className="w-full flex items-center gap-3 px-3 py-3 mb-2 rounded-lg border border-ink-border bg-ink-hover hover:border-brand-600 transition text-left"
        aria-expanded={showHours}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-brand-600/15 text-lg" aria-hidden>
          &#9200;
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-ink-text">Weekly hours</span>
          <span className="block text-xs text-ink-muted truncate">{weeklySummary()}</span>
        </span>
        <span className="flex items-center gap-1.5 shrink-0 rounded-full bg-brand-600 px-3 py-1 text-xs font-semibold text-white">
          {showHours ? 'Done' : 'Edit'}
          <span aria-hidden>{showHours ? '\u25B4' : '\u25BE'}</span>
        </span>
      </button>
      <div className={`border border-ink-border rounded-lg divide-y divide-ink-border mb-5 ${showHours ? '' : 'hidden'}`}>
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
                <span className={`text-sm ${d.open ? 'text-ink-text' : 'text-ink-faint'}`}>{name}</span>
              </label>

              {d.open ? (
                <div className="flex items-center gap-2">
                  <input
                    type="time"
                    value={d.start}
                    onChange={(e) => setDay(i, { start: e.target.value })}
                    className="border border-ink-border rounded-md px-2 py-1 text-sm"
                  />
                  <span className="text-ink-faint text-sm">to</span>
                  <input
                    type="time"
                    value={d.end}
                    onChange={(e) => setDay(i, { end: e.target.value })}
                    className="border border-ink-border rounded-md px-2 py-1 text-sm"
                  />
                </div>
              ) : (
                <span className="text-sm text-ink-faint">Closed</span>
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
      <button
        onClick={() => setShowTimeOff((v) => !v)}
        className="w-full flex items-center gap-3 px-3 py-3 mb-2 rounded-lg border border-ink-border bg-ink-hover hover:border-brand-600 transition text-left"
        aria-expanded={showTimeOff}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-brand-600/15 text-lg" aria-hidden>
          &#128197;
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-ink-text">Time off</span>
          <span className="block text-xs text-ink-muted truncate">{timeOffSummary()}</span>
        </span>
        <span className="flex items-center gap-1.5 shrink-0 rounded-full bg-brand-600 px-3 py-1 text-xs font-semibold text-white">
          {showTimeOff ? 'Done' : 'Edit'}
          <span aria-hidden>{showTimeOff ? '\u25B4' : '\u25BE'}</span>
        </span>
      </button>

      <div className={showTimeOff ? '' : 'hidden'}>
      <div className="flex items-center justify-end mb-2">
        <div className="flex items-center gap-2">
          <button onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
            className="px-2 py-0.5 text-ink-muted hover:bg-ink-hover rounded" aria-label="Previous month">&#8249;</button>
          <span className="text-sm font-medium text-ink-text w-36 text-center">{monthLabel}</span>
          <button onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
            className="px-2 py-0.5 text-ink-muted hover:bg-ink-hover rounded" aria-label="Next month">&#8250;</button>
        </div>
      </div>
      <p className="text-xs text-ink-muted mb-2">Click a day to block the whole day, or just the hours you are busy.</p>

      <div className="grid grid-cols-7 gap-1 mb-1">
        {DAY_SHORT.map((d, i) => (
          <div key={i} className="text-center text-[0.65rem] font-medium text-ink-faint py-1">{d}</div>
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
              onClick={() => !isPast && setSelected(key)}
              disabled={isPast}
              title={
                isPast ? 'in the past'
                  : hasBooking ? 'You have an appointment booked this day'
                  : weeklyClosed ? 'Closed by your weekly hours'
                  : isBlocked ? 'Blocked — click to unblock' : 'Click to block this day'
              }
              className={[
                'relative aspect-square rounded-md text-sm transition',
                selected === key ? 'ring-2 ring-brand-900 ring-offset-1' : '',
                isPast ? 'text-ink-faint cursor-default'
                  : isBlocked ? 'bg-brand-600 text-white font-semibold'
                  : weeklyClosed ? 'bg-white/5 text-ink-faint'
                  : 'bg-ink-hover text-ink-text border border-ink-border hover:border-brand-600',
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

      {selected && (
        <div className="mt-3 border border-ink-border rounded-lg p-3 bg-ink-bg">
          <div className="flex items-center justify-between mb-2">
            <strong className="text-sm text-ink-text">
              {new Date(selected + 'T12:00:00Z').toLocaleDateString('en-US',
                { weekday: 'long', month: 'long', day: 'numeric' })}
            </strong>
            <button onClick={() => setSelected(null)} className="text-xs text-ink-faint hover:text-ink-muted">close</button>
          </div>

          {(appointmentsByDate[selected] || []).length > 0 && (
            <p className="text-xs text-blue-700 mb-2">
              Booked: {(appointmentsByDate[selected] || []).map((a) => `${a.time} ${a.who}`).join(', ')}
            </p>
          )}

          <label className="flex items-center gap-2 mb-3 cursor-pointer">
            <input type="checkbox" checked={isWholeDayBlocked(selected)}
              onChange={() => toggleWholeDay(selected)} className="h-4 w-4" />
            <span className="text-sm text-ink-text">Block the whole day</span>
          </label>

          {!isWholeDayBlocked(selected) && (
            <>
              <div className="flex flex-wrap items-end gap-2 mb-2">
                <label className="text-xs text-ink-muted">
                  Busy from
                  <input type="time" value={fromTime} onChange={(e) => setFromTime(e.target.value)}
                    className="block mt-0.5 border border-ink-border rounded-md px-2 py-1 text-sm" />
                </label>
                <label className="text-xs text-ink-muted">
                  until
                  <input type="time" value={toTime} onChange={(e) => setToTime(e.target.value)}
                    className="block mt-0.5 border border-ink-border rounded-md px-2 py-1 text-sm" />
                </label>
                <button onClick={() => addPartial(selected)}
                  className="bg-gray-800 text-white text-sm px-3 py-1.5 rounded-md">Block these hours</button>
              </div>
              {dayErr && <p className="text-xs text-red-600 mb-2">{dayErr}</p>}
            </>
          )}

          {blocksOn(selected).length > 0 ? (
            <ul className="divide-y divide-ink-border border border-ink-border rounded-md bg-ink-card">
              {blocksOn(selected).map((b, i) => (
                <li key={b.start + i} className="flex items-center justify-between px-2 py-1.5">
                  <span className="text-sm text-ink-text">
                    {coversWholeDay(b, selected, timezone) ? 'All day' : `${hhmm(b.start)} – ${hhmm(b.end)}`}
                  </span>
                  <button onClick={() => removeBlock(b)} className="text-xs text-red-600 hover:underline">remove</button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-ink-faint">Nothing blocked this day.</p>
          )}
        </div>
      )}

      <div className="flex items-center gap-4 mt-3 text-[0.7rem] text-ink-muted">
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded bg-brand-600" /> blocked</span>
        <span className="flex items-center gap-1"><span className="inline-block h-3 w-3 rounded bg-white/5 border border-ink-border" /> closed weekly</span>
        <span className="flex items-center gap-1"><span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-500" /> has a booking</span>
      </div>

      </div>

      <div className="flex items-center gap-3 mt-4">
        <button
          onClick={save}
          disabled={saving || !dirty}
          className="bg-brand-900 text-white text-sm font-medium px-4 py-1.5 rounded-md disabled:opacity-40"
        >
          {saving ? 'Saving…' : dirty ? 'Save availability' : 'Saved'}
        </button>
        {msg && <span className="text-xs text-ink-muted">{msg}</span>}
      </div>
    </div>
  );
}

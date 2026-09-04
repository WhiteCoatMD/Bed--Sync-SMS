import type { DealerSettings, DayHours } from './types';

/**
 * Check if the current time is within the dealer's business hours.
 * Supports per-day hours (day_hours) with fallback to legacy flat hours.
 */
export function isWithinBusinessHours(settings: DealerSettings): boolean {
  const tz = settings.timezone || 'America/Chicago';

  const now = new Date();
  const localTimeStr = now.toLocaleString('en-US', { timeZone: tz });
  const localDate = new Date(localTimeStr);

  const dayOfWeek = localDate.getDay(); // 0=Sun ... 6=Sat
  const currentHour = localDate.getHours() + localDate.getMinutes() / 60;

  // Per-day hours
  if (settings.day_hours) {
    const day = settings.day_hours[String(dayOfWeek)];
    if (day) {
      if (!day.open) return false;
      const [startH, startM] = day.start.split(':').map(Number);
      const [endH, endM] = day.end.split(':').map(Number);
      const startDecimal = startH + (startM || 0) / 60;
      const endDecimal = endH + (endM || 0) / 60;
      return currentHour >= startDecimal && currentHour < endDecimal;
    }
  }

  // Legacy fallback: same hours every day
  const startStr = settings.business_hours_start || '09:00';
  const endStr = settings.business_hours_end || '18:00';
  const [startH, startM] = startStr.split(':').map(Number);
  const [endH, endM] = endStr.split(':').map(Number);
  const startDecimal = startH + (startM || 0) / 60;
  const endDecimal = endH + (endM || 0) / 60;

  return currentHour >= startDecimal && currentHour < endDecimal;
}

/**
 * Check if a specific datetime falls within the dealer's business hours.
 */
export function isDatetimeWithinHours(datetime: string, settings: DealerSettings): boolean {
  const tz = settings.timezone || 'America/Chicago';
  const date = new Date(datetime);
  const localStr = date.toLocaleString('en-US', { timeZone: tz });
  const local = new Date(localStr);

  const dayOfWeek = local.getDay();
  const hour = local.getHours() + local.getMinutes() / 60;

  if (settings.day_hours) {
    const day = settings.day_hours[String(dayOfWeek)];
    if (day) {
      if (!day.open) return false;
      const [sH, sM] = day.start.split(':').map(Number);
      const [eH, eM] = day.end.split(':').map(Number);
      return hour >= sH + (sM || 0) / 60 && hour < eH + (eM || 0) / 60;
    }
  }

  const [sH, sM] = (settings.business_hours_start || '09:00').split(':').map(Number);
  const [eH, eM] = (settings.business_hours_end || '18:00').split(':').map(Number);
  return hour >= sH + (sM || 0) / 60 && hour < eH + (eM || 0) / 60;
}

/**
 * Interpret a naive "YYYY-MM-DDTHH:MM:SS" datetime as a WALL-CLOCK time in the
 * given IANA timezone and return the matching UTC instant as an ISO string.
 *
 * The LLM emits appointment times as store-local wall clock with no offset
 * (e.g. "2026-08-22T14:00:00" meaning 2 PM at the store). Stored directly, a
 * no-offset timestamp is read as UTC — so 2 PM local silently became 2 PM UTC
 * (4 hours early in America/New_York). This converts it correctly.
 *
 * If the input already carries an offset or 'Z', it already denotes a fixed
 * moment and is returned unchanged (normalized to ISO).
 */
export function zonedWallClockToUtcIso(datetime: string, timeZone: string): string {
  const raw = (datetime || '').trim();
  const hasOffset = /([zZ])$|[+-]\d{2}:?\d{2}$/.test(raw);
  if (hasOffset) {
    const d = new Date(raw);
    return isNaN(d.getTime()) ? raw : d.toISOString();
  }
  // Treat the naive components as if UTC to get a reference instant, then shift
  // by the target timezone's offset at that instant.
  const asUtc = new Date(raw + 'Z');
  if (isNaN(asUtc.getTime())) {
    const d = new Date(raw);
    return isNaN(d.getTime()) ? raw : d.toISOString();
  }
  const offsetMs = tzOffsetMs(timeZone, asUtc);
  return new Date(asUtc.getTime() - offsetMs).toISOString();
}

/** Offset (ms) of an IANA timezone from UTC at a given instant. */
function tzOffsetMs(timeZone: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(at)) if (p.type !== 'literal') map[p.type] = p.value;
  let hour = Number(map.hour);
  if (hour === 24) hour = 0; // Intl can render midnight as '24'
  const asUTC = Date.UTC(
    Number(map.year), Number(map.month) - 1, Number(map.day),
    hour, Number(map.minute), Number(map.second)
  );
  return asUTC - at.getTime();
}

/**
 * Format business hours for the AI system prompt.
 */
export function formatHoursForPrompt(settings: DealerSettings): string {
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  if (settings.day_hours) {
    return dayNames.map((name, i) => {
      const day = settings.day_hours?.[String(i)];
      if (!day || !day.open) return `${name}: Closed`;
      return `${name}: ${day.start} - ${day.end}`;
    }).join('\n');
  }

  const start = settings.business_hours_start || '09:00';
  const end = settings.business_hours_end || '18:00';
  return `Every day: ${start} - ${end}`;
}

/**
 * Is this instant inside a block the dealer marked unavailable?
 *
 * Weekly hours say when the store is normally open; they cannot say "not this
 * Thursday, I'm at a wedding". Without this the agent would happily book into
 * it, and for an appointment-only dealer that is a customer driving to a
 * locked door.
 */
export function isBlackedOut(datetime: string, settings: DealerSettings): { blocked: boolean; reason?: string } {
  const at = new Date(datetime).getTime();
  if (Number.isNaN(at)) return { blocked: false };

  for (const b of settings.blackouts || []) {
    const start = new Date(b.start).getTime();
    const end = new Date(b.end).getTime();
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    if (at >= start && at < end) return { blocked: true, reason: b.reason };
  }
  return { blocked: false };
}

/**
 * Does a proposed slot run into one already booked?
 *
 * Nothing used to check. Two shoppers could be given the same 2pm, which an
 * appointment-only store cannot honour -- they see one customer at a time.
 * Half-open comparison so a 2:00-2:30 and a 2:30-3:00 sit side by side.
 */
export function overlapsExisting(
  startIso: string,
  durationMinutes: number,
  existing: Array<{ scheduled_at: string; duration_minutes?: number | null }>
): boolean {
  const start = new Date(startIso).getTime();
  if (Number.isNaN(start)) return false;
  const end = start + durationMinutes * 60000;

  return existing.some((e) => {
    const eStart = new Date(e.scheduled_at).getTime();
    if (Number.isNaN(eStart)) return false;
    const eEnd = eStart + ((e.duration_minutes ?? 30) * 60000);
    return start < eEnd && eStart < end;
  });
}

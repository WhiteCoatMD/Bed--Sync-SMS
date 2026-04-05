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

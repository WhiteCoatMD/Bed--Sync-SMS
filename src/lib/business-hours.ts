import type { DealerSettings } from './types';

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

import type { DealerSettings } from './types';

/**
 * Check if the current time is within the dealer's business hours.
 */
export function isWithinBusinessHours(settings: DealerSettings): boolean {
  const tz = settings.timezone || 'America/Chicago';
  const startStr = settings.business_hours_start || '09:00';
  const endStr = settings.business_hours_end || '18:00';

  const now = new Date();
  const localTimeStr = now.toLocaleString('en-US', { timeZone: tz });
  const localDate = new Date(localTimeStr);
  const currentHour = localDate.getHours() + localDate.getMinutes() / 60;

  const [startH, startM] = startStr.split(':').map(Number);
  const [endH, endM] = endStr.split(':').map(Number);
  const startDecimal = startH + (startM || 0) / 60;
  const endDecimal = endH + (endM || 0) / 60;

  return currentHour >= startDecimal && currentHour < endDecimal;
}

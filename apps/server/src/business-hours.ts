import { z } from 'zod';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const businessHoursSchema = z.object({
  enabled: z.boolean(),
  timezone: z.string().min(1).max(64).refine(isValidTimeZone, 'invalid timezone'),
  /** index 0 = Sunday ... 6 = Saturday; null = closed all day */
  days: z.array(z.object({ open: hhmm, close: hhmm }).nullable()).length(7),
  awayMessage: z.string().trim().min(1).max(1000),
});
export type BusinessHours = z.infer<typeof businessHoursSchema>;

export const DEFAULT_HOURS: BusinessHours = {
  enabled: false,
  timezone: 'Asia/Jerusalem',
  days: [
    { open: '09:00', close: '17:00' }, { open: '09:00', close: '17:00' }, { open: '09:00', close: '17:00' },
    { open: '09:00', close: '17:00' }, { open: '09:00', close: '17:00' }, null, null,
  ],
  awayMessage: 'שלום, קיבלנו את הודעתך. אנחנו מחוץ לשעות הפעילות וניצור קשר בהקדם בשעות הפעילות.',
};

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Is `now` within the configured opening hours (evaluated in the configured time zone)? */
export function isOpen(h: BusinessHours, now: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: h.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  const range = h.days[day];
  if (!range) return false;
  const minutes = Number(get('hour')) * 60 + Number(get('minute'));
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  return minutes >= toMin(range.open) && minutes < toMin(range.close);
}

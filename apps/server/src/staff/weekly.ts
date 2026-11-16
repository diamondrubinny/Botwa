import type { Db } from '../db.js';
import { safetyReport, safetyReportText } from '../safety/report.js';
import { mayAsk } from './assistant.js';

/** Sunday, from 08:40 at the business's time zone (once a week). */
export function weeklyDue(now: Date, timeZone = 'Asia/Jerusalem'): { due: boolean; key: string } {
  let parts: Record<string, string>;
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(now).map((p) => [p.type, p.value]));
  } catch { return weeklyDue(now, 'Asia/Jerusalem'); }
  const key = `${parts.year}-${parts.month}-${parts.day}`;
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  return { due: parts.weekday === 'Sun' && mins >= 8 * 60 + 40, key };
}

export const WEEKLY_FOOTER = 'לכיבוי הסיכום השבועי: בפאנל, "החשבון שלי" ← "בטי בווצאפ".';

/**
 * The weekly safety summary for every manager who linked WhatsApp to Betty, may ask about the inquiries, and did not switch it off.
 * Claimed once per Sunday in the settings table (several server processes never send it twice). Returns the recipients' links.
 */
export async function weeklySummaryTargets(db: Db, now: Date, timeZone: string): Promise<{ text: string; to: { channelId: string; externalId: string }[] } | null> {
  const { due, key } = weeklyDue(now, timeZone);
  if (!due) return null;
  const claim = await db.query(
    `INSERT INTO settings (key, value) VALUES ('weekly_summary_sent', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now() WHERE settings.value->>'date' IS DISTINCT FROM $2
     RETURNING key`, [JSON.stringify({ date: key }), key]);
  if (!claim.rowCount) return null;
  const rows = (await db.query(
    `SELECT DISTINCT ON (l.user_id) l.user_id, l.channel_id, l.external_id FROM staff_links l JOIN users u ON u.id = l.user_id
      WHERE u.active AND u.weekly_summary ORDER BY l.user_id, l.last_used_at DESC NULLS LAST`)).rows as { user_id: string; channel_id: string; external_id: string }[];
  const to: { channelId: string; externalId: string }[] = [];
  for (const r of rows) if (await mayAsk(db, r.user_id)) to.push({ channelId: r.channel_id, externalId: r.external_id });
  if (!to.length) return { text: '', to };
  const text = `🗓️ סיכום בטיחות שבועי\n\n${safetyReportText(await safetyReport(db, 7))}\n\n${WEEKLY_FOOTER}`;
  return { text, to };
}

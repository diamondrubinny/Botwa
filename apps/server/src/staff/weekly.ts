import type { Db } from '../db.js';
import { safetyReport, safetyReportText } from '../safety/report.js';
import { permissionsOfRole } from '../routes/users.js';
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

/** questions customers asked last week that Betty could not answer (distinct wordings; the count only, never the text) */
export async function weeklyGaps(db: Db): Promise<number> {
  return (await db.query(`SELECT count(DISTINCT lower(text))::int AS n FROM kb_queries WHERE NOT answered AND via IN ('bot','staff') AND created_at > now() - interval '7 days'`)).rows[0].n as number;
}
export const gapsLine = (n: number) => `❓ ${n} שאלות שבטי לא ידעה לענות עליהן השבוע. אפשר לכתוב להן תשובה במאגר הידע ← "שאלות ללא מענה".`;

export interface WeeklyPlan { text: string; gaps: number; to: { channelId: string; externalId: string; kb: boolean }[]; kbUsers: string[] }

/**
 * The weekly safety summary for every manager who linked WhatsApp to Betty, may ask about the inquiries, and did not switch it off;
 * those who manage the knowledge base also get the number of questions Betty could not answer (and a push, linked or not).
 * Claimed once per Sunday in the settings table (several server processes never send it twice).
 */
export async function weeklySummaryTargets(db: Db, now: Date, timeZone: string): Promise<WeeklyPlan | null> {
  const { due, key } = weeklyDue(now, timeZone);
  if (!due) return null;
  const claim = await db.query(
    `INSERT INTO settings (key, value) VALUES ('weekly_summary_sent', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now() WHERE settings.value->>'date' IS DISTINCT FROM $2
     RETURNING key`, [JSON.stringify({ date: key }), key]);
  if (!claim.rowCount) return null;
  const canKb = async (role: string) => !!(await permissionsOfRole(db, role))?.includes('kb.manage');
  const kbUsers: string[] = [];
  for (const u of (await db.query(`SELECT id, role FROM users WHERE active AND NOT must_change_password`)).rows as { id: string; role: string }[]) if (await canKb(u.role)) kbUsers.push(u.id);
  const rows = (await db.query(
    `SELECT DISTINCT ON (l.user_id) l.user_id, l.channel_id, l.external_id, u.role FROM staff_links l JOIN users u ON u.id = l.user_id
      WHERE u.active AND u.weekly_summary ORDER BY l.user_id, l.last_used_at DESC NULLS LAST`)).rows as { user_id: string; channel_id: string; external_id: string; role: string }[];
  const to: WeeklyPlan['to'] = [];
  for (const r of rows) if (await mayAsk(db, r.user_id)) to.push({ channelId: r.channel_id, externalId: r.external_id, kb: kbUsers.includes(r.user_id) });
  const gaps = await weeklyGaps(db);
  const text = to.length ? `🗓️ סיכום בטיחות שבועי\n\n${safetyReportText(await safetyReport(db, 7))}` : '';
  return { text, gaps, to, kbUsers };
}

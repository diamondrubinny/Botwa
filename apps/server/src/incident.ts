import { z } from 'zod';
import type { Db } from './db.js';

/**
 * A wide emergency ("אירוע חירום רחב": an alarm, a big fire, an evacuation): a manager switches it on with a status message; while
 * it is on, everyone who writes gets that message once (in English for English conversations when an English text is given), the
 * conversation is tagged "אירוע חירום", and every staff screen shows a banner. A personal emergency in a message is still handled
 * first. Switched off in one click; both are in the audit log.
 */
export const incidentSchema = z.object({
  active: z.boolean(),
  text: z.string().trim().min(10).max(1000),
  textEn: z.string().trim().max(1000).default(''),
  textAr: z.string().trim().max(1000).default(''),
});
export type Incident = z.infer<typeof incidentSchema> & { startedAt: string | null; startedBy: string | null };

export const DEFAULT_INCIDENT_TEXT = '⚠️ עדכון מיחידת הבטיחות: מתרחש כרגע אירוע חירום בקמפוס. יש לפעול לפי הנחיות הגורמים בשטח ולהתרחק מהאזור. בכל סכנה מיידית התקשרו מיד למד"א 101 או לכבאות והצלה 102. נעדכן כאן כשיהיה מידע נוסף.';

export async function loadIncident(db: Db): Promise<Incident> {
  const v = (await db.query(`SELECT value FROM settings WHERE key = 'incident'`)).rows[0]?.value as Partial<Incident> | undefined;
  return { active: !!v?.active, text: v?.text || DEFAULT_INCIDENT_TEXT, textEn: v?.textEn ?? '', textAr: v?.textAr ?? '', startedAt: v?.startedAt ?? null, startedBy: v?.startedBy ?? null };
}

export async function saveIncident(db: Db, next: z.infer<typeof incidentSchema>, userId: string): Promise<Incident> {
  const cur = await loadIncident(db);
  const startedAt = next.active ? (cur.active && cur.startedAt ? cur.startedAt : new Date().toISOString()) : null;
  const value: Incident = { ...next, startedAt, startedBy: next.active ? (cur.active ? cur.startedBy : userId) : null };
  await db.query(`INSERT INTO settings (key, value) VALUES ('incident', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [value]);
  return value;
}

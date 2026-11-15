import { z } from 'zod';
import type { Db } from '../db.js';

/** Periodic inspections: what, where, every how many days, who; "done" logs it and moves the due date on by the interval. */
export const inspectionSchema = z.object({
  title: z.string().trim().min(2).max(120),
  place: z.string().trim().max(120).default(''),
  intervalDays: z.number().int().min(1).max(3650),
  nextDue: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  assignee: z.string().uuid().nullable().default(null),
  notes: z.string().trim().max(1000).default(''),
  active: z.boolean().default(true),
});

export interface InspectionRow {
  id: string; title: string; place: string; intervalDays: number; nextDue: string; assignee: string | null; assigneeName: string | null;
  notes: string; active: boolean; lastDoneAt: string | null; lastDoneBy: string | null; status: 'overdue' | 'soon' | 'ok' | 'off'; daysLeft: number;
}

const SELECT = `SELECT i.id, i.title, i.place, i.interval_days AS "intervalDays", to_char(i.next_due, 'YYYY-MM-DD') AS "nextDue", i.assignee,
    COALESCE(u.name_he, u.name) AS "assigneeName", i.notes, i.active, i.last_done_at AS "lastDoneAt",
    (SELECT COALESCE(du.name_he, du.name) FROM inspection_log l LEFT JOIN users du ON du.id = l.done_by WHERE l.inspection_id = i.id ORDER BY l.done_at DESC LIMIT 1) AS "lastDoneBy",
    (i.next_due - (now() AT TIME ZONE 'Asia/Jerusalem')::date)::int AS "daysLeft"
  FROM inspections i LEFT JOIN users u ON u.id = i.assignee`;
const status = (r: { active: boolean; daysLeft: number }): InspectionRow['status'] => (!r.active ? 'off' : r.daysLeft < 0 ? 'overdue' : r.daysLeft <= 7 ? 'soon' : 'ok');

export async function listInspections(db: Db): Promise<InspectionRow[]> {
  const rows = (await db.query(`${SELECT} ORDER BY i.active DESC, i.next_due, i.title`)).rows as Omit<InspectionRow, 'status'>[];
  return rows.map((r) => ({ ...r, status: status(r) }));
}

/** Done: logged (who, when, a note) and due again after the interval, counted from today. */
export async function markDone(db: Db, id: string, userId: string, note: string): Promise<boolean> {
  const r = await db.query(
    `UPDATE inspections SET last_done_at = now(), last_reminded_at = NULL,
            next_due = (now() AT TIME ZONE 'Asia/Jerusalem')::date + interval_days WHERE id = $1 RETURNING id`, [id]);
  if (!r.rowCount) return false;
  await db.query('INSERT INTO inspection_log (inspection_id, done_by, note) VALUES ($1, $2, $3)', [id, userId, note.slice(0, 1000)]);
  return true;
}

export async function inspectionLog(db: Db, id: string): Promise<{ doneAt: string; doneBy: string | null; note: string }[]> {
  return (await db.query(`SELECT l.done_at AS "doneAt", COALESCE(u.name_he, u.name) AS "doneBy", l.note FROM inspection_log l LEFT JOIN users u ON u.id = l.done_by
      WHERE l.inspection_id = $1 ORDER BY l.done_at DESC LIMIT 50`, [id])).rows;
}

/** Due within a week or overdue, active, with someone responsible, and not reminded in the last 20 hours: one reminder a day. */
export async function dueReminders(db: Db): Promise<(InspectionRow & { assignee: string })[]> {
  const rows = (await db.query(`${SELECT} WHERE i.active AND i.assignee IS NOT NULL AND i.next_due <= (now() AT TIME ZONE 'Asia/Jerusalem')::date + 7
      AND (i.last_reminded_at IS NULL OR i.last_reminded_at < now() - interval '20 hours') ORDER BY i.next_due LIMIT 100`)).rows as Omit<InspectionRow, 'status'>[];
  return rows.map((r) => ({ ...r, status: status(r) })) as (InspectionRow & { assignee: string })[];
}

const fmt = (d: string) => d.split('-').reverse().slice(0, 2).join('/');
export function reminderText(list: Pick<InspectionRow, 'title' | 'place' | 'nextDue' | 'daysLeft'>[]): string {
  return ['🗓️ בדיקות תקופתיות באחריותך:', ...list.slice(0, 10).map((i) => `• ${i.title}${i.place ? `, ${i.place}` : ''}: ${i.daysLeft < 0 ? `⚠️ באיחור של ${-i.daysLeft} ימים` : i.daysLeft === 0 ? 'היום' : `עד ${fmt(i.nextDue)} (עוד ${i.daysLeft} ימים)`}`),
    'אחרי הבדיקה, סמנו "בוצע" בפאנל: החשבון שלי ← הבדיקות שלי.'].join('\n');
}

/** For managers on WhatsApp ("8"): what is overdue and what comes in the next two weeks. */
export async function inspectionsSummary(db: Db): Promise<string> {
  const rows = (await listInspections(db)).filter((i) => i.active && i.daysLeft <= 14);
  if (!rows.length) return '🗓️ אין בדיקות תקופתיות באיחור או בשבועיים הקרובים.';
  return ['🗓️ בדיקות תקופתיות:', ...rows.slice(0, 15).map((i) => `• ${i.title}${i.place ? `, ${i.place}` : ''} · ${i.assigneeName ?? 'בלי אחראי'} · ${i.daysLeft < 0 ? `⚠️ באיחור ${-i.daysLeft} ימים` : i.daysLeft === 0 ? 'היום' : `עוד ${i.daysLeft} ימים`}`)].join('\n');
}

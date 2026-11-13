import ExcelJS from 'exceljs';
import type { Db } from '../db.js';
import { extract } from '../kb/extract.js';
import { resolveUserRef } from '../usernames.js';

export interface Officer { id: string; name: string; email: string | null; phone: string | null; userId: string | null; userName: string | null; userUsername?: string | null; userActive: boolean; notes: string; active: boolean; topics: string[] }

/** Digits of a WhatsApp number with country code: "050-123 4567" becomes 972501234567. Null when it cannot be a phone number. */
export function normalizePhone(raw: string): string | null {
  let d = raw.replace(/[^\d]/g, '').replace(/^00/, '');
  if (/^0\d{8,9}$/.test(d)) d = `972${d.slice(1)}`;
  return /^\d{8,15}$/.test(d) ? d : null;
}
export const cleanTopics = (list: string[]): string[] => [...new Set(list.map((t) => t.replace(/\s+/g, ' ').trim()).filter((t) => t.length > 0 && t.length <= 60))].slice(0, 30);
const splitList = (s: string) => s.split(/[\n,;]/);

const SELECT = `SELECT o.id, o.name, o.email, o.phone, o.user_id AS "userId", u.name AS "userName", u.username AS "userUsername", COALESCE(u.active, false) AS "userActive", o.notes, o.active,
                       COALESCE((SELECT array_agg(t.topic ORDER BY t.topic) FROM officer_topics t WHERE t.officer_id = o.id), '{}') AS topics
                  FROM officers o LEFT JOIN users u ON u.id = o.user_id`;

export async function listOfficers(db: Db): Promise<Officer[]> {
  return (await db.query(`${SELECT} ORDER BY o.sort, o.created_at`)).rows as Officer[];
}

/** Active officers for a topic (names compared without regard to case), in the order they were entered. */
export async function officersForTopic(db: Db, topic: string): Promise<Officer[]> {
  return (await db.query(`${SELECT} WHERE o.active AND EXISTS (SELECT 1 FROM officer_topics t WHERE t.officer_id = o.id AND lower(t.topic) = lower($1)) ORDER BY o.sort, o.created_at`, [topic])).rows as Officer[];
}

/** The officer who gets the conversation: the first one with an active account, else the first one (who is then contacted by the details shown). */
export const pickOfficer = (list: Officer[]): Officer | null => list.find((o) => o.userId && o.userActive) ?? list[0] ?? null;

export function contactText(o: Officer): string {
  return [`הממונה על הנושא: ${o.name}`, o.phone && `ווצאפ: https://wa.me/${o.phone}`, o.email && `אימייל: ${o.email}`].filter(Boolean).join('\n');
}
export function officerNote(topic: string, o: Officer): string {
  return `ממונה בתחום "${topic}": ${[o.name, o.phone && `ווצאפ ${o.phone}`, o.email, o.userId && o.userActive ? 'השיחה שויכה לחשבון שלו' : 'אין לו חשבון פעיל במערכת: יש לפנות אליו בפרטים האלה'].filter(Boolean).join(', ')}.`;
}

export interface OfficerImportResult { created: number; updated: number; skipped: { row: number; reason: 'missing_name' | 'bad_phone' | 'bad_email' }[]; unlinked: number }
const HEAD = { name: /^(שם|שם הממונה|ממונה)$/, email: /מייל|אימייל|דוא/, phone: /ווצאפ|וואטסאפ|טלפון|נייד/, topics: /נושא|תחום/, user: /משתמש|חשבון/, notes: /הערה/ };

/** Officers from a workbook: name, e-mail, WhatsApp, topics (one per line or separated by commas), the account e-mail, notes. Matched by e-mail, else by name. */
export async function importOfficers(db: Db, buf: Buffer): Promise<OfficerImportResult> {
  const sheet = (await extract('xlsx', buf)).sheets?.[0];
  const rows = sheet?.rows ?? [];
  const hi = rows.findIndex((r) => r.some((c) => HEAD.name.test(c.trim())) && r.some((c) => HEAD.topics.test(c)));
  if (hi < 0) throw new Error('unknown_workbook');
  const h = rows[hi]!;
  const ix = (re: RegExp) => h.findIndex((c) => re.test(c.trim()));
  const c = { name: ix(HEAD.name), email: ix(HEAD.email), phone: ix(HEAD.phone), topics: ix(HEAD.topics), user: ix(HEAD.user), notes: ix(HEAD.notes) };
  const out: OfficerImportResult = { created: 0, updated: 0, skipped: [], unlinked: 0 };
  let n = 0;
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.every((x) => !x.trim())) continue;
    const row = i + 1;
    const cell = (k: number) => (k >= 0 ? (r[k] ?? '').trim() : '');
    const name = cell(c.name).slice(0, 100);
    if (!name) { out.skipped.push({ row, reason: 'missing_name' }); continue; }
    const email = cell(c.email).toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { out.skipped.push({ row, reason: 'bad_email' }); continue; }
    const phoneRaw = cell(c.phone);
    const phone = phoneRaw ? normalizePhone(phoneRaw) : null;
    if (phoneRaw && !phone) { out.skipped.push({ row, reason: 'bad_phone' }); continue; }
    if (++n > 300) break;
    const topics = cleanTopics(splitList(cell(c.topics)));
    const acct = cell(c.user).toLowerCase();
    let userId: string | null = null;
    if (acct) { userId = await resolveUserRef(db, acct); if (!userId) out.unlinked++; }   // the account: @username, username or e-mail
    const existing = (await db.query(email ? 'SELECT id FROM officers WHERE lower(email) = $1' : 'SELECT id FROM officers WHERE lower(name) = lower($1)', [email || name])).rows[0]?.id as string | undefined;
    let id = existing;
    if (id) await db.query('UPDATE officers SET name = $2, email = $3, phone = $4, user_id = COALESCE($5, user_id), notes = $6 WHERE id = $1', [id, name, email || null, phone, userId, cell(c.notes).slice(0, 300)]);
    else id = (await db.query(`INSERT INTO officers (name, email, phone, user_id, notes, sort) VALUES ($1,$2,$3,$4,$5, COALESCE((SELECT max(sort) + 1 FROM officers), 0)) RETURNING id`, [name, email || null, phone, userId, cell(c.notes).slice(0, 300)])).rows[0].id;
    await db.query('DELETE FROM officer_topics WHERE officer_id = $1', [id]);
    for (const t of topics) await db.query('INSERT INTO officer_topics (officer_id, topic) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, t]);
    if (existing) out.updated++; else out.created++;
  }
  return out;
}

export async function officersTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('ממונים', { views: [{ rightToLeft: true }] });
  ws.columns = [{ header: 'שם', width: 24 }, { header: 'אימייל', width: 30 }, { header: 'ווצאפ', width: 18 }, { header: 'נושאים (אחד בכל שורה או מופרדים בפסיק)', width: 44 }, { header: 'חשבון במערכת: @שם משתמש או אימייל (אם יש)', width: 32 }, { header: 'הערות', width: 30 }];
  ws.addRow(['דוגמה: דנה כהן', 'dana@example.org', '050-123-4567', 'לייזרים\nקרינה מייננת / בלתי מייננת', '@dana', '']);
  ws.getRow(1).font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

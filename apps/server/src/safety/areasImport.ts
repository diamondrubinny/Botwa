import { resolveUserRef } from '../usernames.js';
import ExcelJS from 'exceljs';
import type { Db } from '../db.js';
import { extract } from '../kb/extract.js';

export interface AreaImportResult { created: number; updated: number; skipped: { row: number; reason: 'missing_fields' | 'unknown_officer' | 'name_too_long' }[] }

const HEAD = { name: /אזור|בניין|שם/, keywords: /מילות|זיהוי|מילים|ביטויים/, email: /מייל|אימייל|דוא|שם משתמש|משתמש/ };
const splitWords = (s: string) => [...new Set(s.split(/[\n,;]/).map((x) => x.trim()).filter((x) => x.length > 0 && x.length <= 60))].slice(0, 30);

/**
 * Responsibility areas from a workbook: one row per area with its name, identifying words (one per line or separated by commas)
 * and the e-mail of the officer. Officers must already exist (accounts are opened in the Team page, never created by an import).
 * A row whose area name already exists updates that area.
 */
export async function importAreas(db: Db, buf: Buffer): Promise<AreaImportResult> {
  const doc = await extract('xlsx', buf);
  const rows = doc.sheets?.[0]?.rows ?? [];
  const hi = rows.findIndex((r) => r.some((c) => HEAD.email.test(c)) && r.some((c) => HEAD.keywords.test(c)));
  if (hi < 0) throw new Error('unknown_workbook');
  const h = rows[hi]!;
  const col = { keywords: h.findIndex((c) => HEAD.keywords.test(c)), email: h.findIndex((c) => HEAD.email.test(c)) };
  const nameCol = h.findIndex((c, i) => i !== col.keywords && i !== col.email && HEAD.name.test(c));
  if (nameCol < 0) throw new Error('unknown_workbook');
  const out: AreaImportResult = { created: 0, updated: 0, skipped: [] };
  let n = 0;
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.every((c) => !c.trim())) continue;
    const row = i + 1;
    const name = (r[nameCol] ?? '').trim(), kws = splitWords(r[col.keywords] ?? ''), email = (r[col.email] ?? '').trim().toLowerCase();
    if (!name || !kws.length || !email) { out.skipped.push({ row, reason: 'missing_fields' }); continue; }
    if (name.length > 80) { out.skipped.push({ row, reason: 'name_too_long' }); continue; }
    const uid = await resolveUserRef(db, email);   // the officer's e-mail, or @username
    if (!uid) { out.skipped.push({ row, reason: 'unknown_officer' }); continue; }
    if (++n > 200) break;
    const up = await db.query('UPDATE responsibility_areas SET keywords = $2, user_id = $3 WHERE name = $1', [name, kws, uid]);
    if (up.rowCount) { out.updated++; continue; }
    await db.query(`INSERT INTO responsibility_areas (name, keywords, user_id, sort) VALUES ($1,$2,$3, COALESCE((SELECT max(sort) + 1 FROM responsibility_areas), 0))`, [name, kws, uid]);
    out.created++;
  }
  return out;
}

/** An empty workbook with the right headings and one example row, right-to-left. */
export async function areasTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('אזורי אחריות', { views: [{ rightToLeft: true }] });
  ws.columns = [{ header: 'שם האזור', width: 28 }, { header: 'מילות זיהוי (אחת בכל שורה או מופרדות בפסיק)', width: 50 }, { header: 'אימייל הממונה או @שם משתמש', width: 32 }];
  ws.addRow(['דוגמה: בניין 12', 'בניין 12\nבניין י״ב', 'name@example.org']);
  ws.getRow(1).font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

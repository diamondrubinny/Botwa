import ExcelJS from 'exceljs';
import { extract } from './kb/extract.js';

/** One person read from a workbook. `role` is a role key when the sheet names a permission level, else null (the default is used). */
export interface ImportRow { row: number; name: string; email: string; jobTitle: string | null; role: string | null; roleText: string | null }
export interface ImportParse { rows: ImportRow[]; invalid: { row: number; reason: 'missing_name' | 'bad_email' | 'missing_email' | 'duplicate'; value: string }[]; columns: Record<'name' | 'email' | 'title' | 'role', string | null>; headerFound: boolean }

const H = {
  name: /^(שם( מלא)?|שם העובד|שם עובד|full ?name|name|employee)$/i,
  first: /^(שם פרטי|first ?name|given ?name)$/i,
  last: /^(שם משפחה|last ?name|surname|family ?name)$/i,
  email: /(אי?מייל|דוא"?ל|דואר אלקטרוני|e-?mail|mail)/i,
  title: /^(תפקיד|תפקיד בארגון|title|job ?title|position|role ?title)$/i,
  role: /^(הרשאה|הרשאות|סוג משתמש|רמת הרשאה|permission|access|system ?role|role)$/i,
};
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Reads people from the first sheet: a header row in Hebrew or English (name or first+last, e-mail, job title, permission level),
 * or, without a header, the columns are recognised by their content (the e-mail column, the name next to it). At most 500 people.
 */
export async function parseUsersWorkbook(buf: Buffer, roles: { key: string; name: string }[]): Promise<ImportParse> {
  const sheet = (await extract('xlsx', buf)).sheets?.[0];
  const all = (sheet?.rows ?? []).map((r) => r.map((c) => clean(String(c ?? ''))));
  const head = all.findIndex((r) => r.some((c) => H.email.test(c)) && r.some((c) => H.name.test(c) || H.first.test(c)));
  const ix = (re: RegExp, h: string[]) => h.findIndex((c) => re.test(c));
  let col: { name: number; first: number; last: number; email: number; title: number; role: number };
  let start: number;
  if (head >= 0) {
    const h = all[head]!;
    col = { name: ix(H.name, h), first: ix(H.first, h), last: ix(H.last, h), email: ix(H.email, h), title: ix(H.title, h), role: ix(H.role, h) };
    start = head + 1;
  } else {
    // no header: the e-mail column is the one most of whose cells are e-mails; the name is the first text column that is not it
    const width = Math.max(0, ...all.map((r) => r.length));
    const score = (k: number) => all.filter((r) => EMAIL.test(r[k] ?? '')).length;
    let email = -1; let best = 0;
    for (let k = 0; k < width; k++) { const s = score(k); if (s > best) { best = s; email = k; } }
    if (email < 0) throw new Error('unknown_workbook');
    const textCols = [...Array(width).keys()].filter((k) => k !== email && all.some((r) => /[A-Za-z֐-׿]/.test(r[k] ?? '') && !EMAIL.test(r[k] ?? '')));
    col = { name: textCols[0] ?? -1, first: -1, last: -1, email, title: textCols[1] ?? -1, role: -1 };
    start = 0;
  }
  if (col.email < 0 || (col.name < 0 && col.first < 0)) throw new Error('unknown_workbook');
  const headerRow = head >= 0 ? all[head]! : [];
  const label = (k: number) => (k >= 0 ? headerRow[k] || `עמודה ${k + 1}` : null);
  const roleOf = (t: string): string | null => {
    const v = t.toLowerCase();
    return roles.find((r) => r.key.toLowerCase() === v || r.name.toLowerCase() === v)?.key
      ?? (/(מנהל מערכת|admin)/i.test(t) ? 'admin' : /(מפקח|אחראי|supervisor|manager)/i.test(t) ? 'supervisor' : /(נציג|agent|עובד)/i.test(t) ? 'agent' : null);
  };

  const out: ImportParse = { rows: [], invalid: [], columns: { name: label(col.name >= 0 ? col.name : col.first), email: label(col.email), title: label(col.title), role: label(col.role) }, headerFound: head >= 0 };
  const seen = new Set<string>();
  for (let i = start; i < all.length && out.rows.length < 500; i++) {
    const r = all[i]!;
    if (r.every((c) => !c)) continue;
    const cell = (k: number) => (k >= 0 ? r[k] ?? '' : '');
    const name = clean(col.name >= 0 ? cell(col.name) : `${cell(col.first)} ${cell(col.last)}`).slice(0, 100);
    const email = cell(col.email).toLowerCase().replace(/^mailto:/, '');
    const row = i + 1;
    if (!name && !email) continue;
    if (!email) { out.invalid.push({ row, reason: 'missing_email', value: name }); continue; }
    if (!EMAIL.test(email) || email.length > 254) { out.invalid.push({ row, reason: 'bad_email', value: email }); continue; }
    if (!name) { out.invalid.push({ row, reason: 'missing_name', value: email }); continue; }
    if (seen.has(email)) { out.invalid.push({ row, reason: 'duplicate', value: email }); continue; }
    seen.add(email);
    const title = cell(col.title).slice(0, 80) || null;
    const roleText = cell(col.role) || null;
    out.rows.push({ row, name, email, jobTitle: title, role: roleText ? roleOf(roleText) : null, roleText });
  }
  return out;
}

export async function usersTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('משתמשים', { views: [{ rightToLeft: true }] });
  ws.columns = [{ header: 'שם מלא', width: 24 }, { header: 'אימייל', width: 30 }, { header: 'תפקיד', width: 30 }, { header: 'הרשאה (נציג / מפקח / מנהל, לא חובה)', width: 30 }];
  ws.getRow(1).font = { bold: true };
  ws.addRow(['דנה כהן', 'dana@example.org', 'ממונת בטיחות, הפקולטה לכימיה', 'נציג']);
  ws.addRow(['אבי לוי', 'avi@example.org', 'רכז בטיחות', '']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

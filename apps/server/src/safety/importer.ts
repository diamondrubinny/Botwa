import { createHash } from 'node:crypto';
import type { Db } from '../db.js';
import { extract } from '../kb/extract.js';
import type { KnowledgeBase } from '../kb/service.js';
import { assignCategories, boardCategories, ensureBoardCategories } from './categories.js';

type Sheet = { name: string; rows: string[][] };
export type ImportKind = 'regulations' | 'weekly';
export interface Item { externalId: string; title: string; body: string; reference: string; url: string | null; meta: Record<string, string>; matchText: string }

const col = (header: string[], ...names: string[]): number => header.findIndex((h) => names.includes(h.trim()));
const cell = (row: string[], i: number): string => (i >= 0 ? (row[i] ?? '').trim() : '');

/** Which of the two known workbook layouts this is (null = unknown). */
export function detectKind(sheets: Sheet[]): ImportKind | null {
  if (sheets.some((s) => s.name === 'כל_הסעיפים' && s.rows[0]?.includes('סימוכין'))) return 'regulations';
  if (sheets.some((s) => s.rows.slice(0, 3).some((r) => r.includes('מזהה עמוד') && r.includes('שאלה')))) return 'weekly';
  return null;
}

/** Law and ordinance provisions sorted by topic: one item per provision, plus the cross-document relations sheet. */
export function parseRegulations(sheets: Sheet[]): Item[] {
  const items: Item[] = [];
  const main = sheets.find((s) => s.name === 'כל_הסעיפים');
  if (main) {
    const h = main.rows[0]!;
    const c = { cat: col(h, 'קטגוריה'), src: col(h, 'מקור'), ref: col(h, 'סימוכין'), sec: col(h, 'סעיף'), title: col(h, 'כותרת סעיף'), chap: col(h, 'פרק'), sign: col(h, 'סימן'), type: col(h, 'סוג הוראה'), sum: col(h, 'תקציר הוראה'), text: col(h, 'נוסח מקוצר / תוכן מרכזי'), rel: col(h, 'הקשרים / הצלבות'), diff: col(h, 'סתירה / שוני היקף') };
    for (const r of main.rows.slice(1)) {
      const ref = cell(r, c.ref);
      if (!ref) continue;
      const title = cell(r, c.title);
      const body = [cell(r, c.sum), cell(r, c.text) !== cell(r, c.sum) ? cell(r, c.text) : '', cell(r, c.rel) && `הצלבות: ${cell(r, c.rel)}`, cell(r, c.diff) && `שוני/סתירה: ${cell(r, c.diff)}`].filter(Boolean).join('\n\n');
      items.push({
        externalId: `reg:${ref}`, title: `${ref}${title ? ` — ${title}` : ''}`.slice(0, 300), body: body || title || ref, reference: ref,
        url: null, meta: { instrument: cell(r, c.src), category: cell(r, c.cat), chapter: cell(r, c.chap), sign: cell(r, c.sign), type: cell(r, c.type), related: cell(r, c.rel), difference: cell(r, c.diff), section: cell(r, c.sec) },
        matchText: `${title} ${cell(r, c.sum)} ${cell(r, c.text)}`,
      });
    }
  }
  const rel = sheets.find((s) => s.name === 'קשרים_וסתירות');
  if (rel && rel.rows.length > 1) {
    const h = rel.rows[0]!;
    const c = { cat: col(h, 'קטגוריה'), kind: col(h, 'סוג ממצא'), a: col(h, 'מקור א'), b: col(h, 'מקור ב'), why: col(h, 'הסבר הקשר'), diff: col(h, 'הערת סתירה / שוני') };
    rel.rows.slice(1).forEach((r, i) => {
      if (!cell(r, c.a) && !cell(r, c.b)) return;
      items.push({
        externalId: `rel:${i + 1}:${cell(r, c.a)}|${cell(r, c.b)}`, title: `קשר בין מסמכים: ${cell(r, c.a)} ⇄ ${cell(r, c.b)}`.slice(0, 300),
        body: [cell(r, c.why), cell(r, c.diff) && `שוני/סתירה: ${cell(r, c.diff)}`].filter(Boolean).join('\n\n') || cell(r, c.kind), reference: `${cell(r, c.a)} ⇄ ${cell(r, c.b)}`.slice(0, 200),
        url: null, meta: { instrument: 'קשרים בין מסמכים', category: cell(r, c.cat), kind: cell(r, c.kind) }, matchText: `${cell(r, c.cat)} ${cell(r, c.why)}`,
      });
    });
  }
  return items;
}

/** "Answer of the week" pages of the Institute for Safety and Hygiene: one item per answer, linking back to the original page. */
export function parseWeekly(sheets: Sheet[]): Item[] {
  const sheet = sheets.find((s) => s.name === 'כל התשובות') ?? sheets.find((s) => s.rows.slice(0, 3).some((r) => r.includes('מזהה עמוד')));
  if (!sheet) return [];
  const hi = sheet.rows.findIndex((r) => r.includes('מזהה עמוד'));
  const h = sheet.rows[hi]!;
  const c = { id: col(h, 'מזהה עמוד'), date: col(h, 'תאריך'), cat: col(h, 'קטגוריה ראשית'), sub: col(h, 'תת-נושא'), q: col(h, 'שאלה'), a: col(h, 'תמצית התשובה'), law: col(h, 'אזכור תחיקתי / מקור מרכזי'), who: col(h, 'משיב/ה'), url: col(h, 'כתובת מקור') };
  const items: Item[] = [];
  for (const r of sheet.rows.slice(hi + 1)) {
    const id = cell(r, c.id), q = cell(r, c.q);
    if (!id || !q) continue;
    const url = cell(r, c.url);
    items.push({
      externalId: `weekly:${id}`, title: q.slice(0, 300), body: [cell(r, c.a), cell(r, c.law) && `אזכור תחיקתי: ${cell(r, c.law)}`].filter(Boolean).join('\n\n'), reference: cell(r, c.law).slice(0, 300),
      url: /^https:\/\/[^\s]+$/.test(url) ? url : null,
      meta: { instrument: 'תשובת השבוע', pageId: id, date: cell(r, c.date), category: cell(r, c.cat), subtopic: cell(r, c.sub), answeredBy: cell(r, c.who) },
      matchText: `${q} ${cell(r, c.sub)} ${cell(r, c.a)} ${cell(r, c.law)}`,
    });
  }
  return items;
}

export interface ImportResult { kind: ImportKind; created: number; updated: number; unchanged: number; categorized: number; uncategorized: number }

/** Import a spreadsheet of standards. Re-importing updates existing rows (matched by origin + id) and never duplicates. */
export async function importWorkbook(db: Db, kb: KnowledgeBase, buf: Buffer, opts: { audience: 'bot' | 'staff' | 'both'; userId: string | null }): Promise<ImportResult> {
  const scan = await kb.scanBinary(buf);
  if (scan === 'infected') throw new Error('infected');
  if (scan !== 'clean') throw new Error('scan_unavailable');
  const ex = await extract('xlsx', buf, 60_000);
  const sheets = ex.sheets ?? [];
  const kind = detectKind(sheets);
  if (!kind) throw new Error('unknown_workbook');
  const items = kind === 'regulations' ? parseRegulations(sheets) : parseWeekly(sheets);
  if (items.length === 0) throw new Error('empty_content');
  if (items.length > 5000) throw new Error('too_many_rows');
  await ensureBoardCategories(db);
  const cats = await boardCategories(db);
  const origin = `xlsx:${kind}`;
  const out: ImportResult = { kind, created: 0, updated: 0, unchanged: 0, categorized: 0, uncategorized: 0 };
  for (const it of items) {
    const hash = createHash('sha256').update(JSON.stringify([it.title, it.body, it.reference, it.url, it.meta])).digest('hex');
    const cur = (await db.query('SELECT id, content_hash FROM kb_sources WHERE origin = $1 AND external_id = $2', [origin, it.externalId])).rows[0];
    let id: string;
    if (!cur) {
      id = (await db.query(
        `INSERT INTO kb_sources (kind, title, body, url, reference, origin, external_id, meta, audience, created_by, content_hash) VALUES ('text',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [it.title, it.body, it.url, it.reference, origin, it.externalId, JSON.stringify(it.meta), opts.audience, opts.userId, hash])).rows[0].id;
      out.created++;
    } else if (cur.content_hash !== hash) {
      id = cur.id;
      await db.query(`UPDATE kb_sources SET title = $2, body = $3, url = $4, reference = $5, meta = $6, content_hash = $7, updated_at = now() WHERE id = $1`, [id, it.title, it.body, it.url, it.reference, JSON.stringify(it.meta), hash]);
      out.updated++;
    } else { id = cur.id; out.unchanged++; }
    if (!cur || cur.content_hash !== hash) await kb.indexWritten(id).catch(() => undefined);
    const n = await assignCategories(db, id, it.matchText, cats);
    if (n) out.categorized++; else out.uncategorized++;
  }
  return out;
}

/** Board categories of one source from its title, text and (for uploaded documents) its first passages. */
export async function categorizeSource(db: Db, id: string, cats?: Awaited<ReturnType<typeof boardCategories>>): Promise<number> {
  const c = cats ?? (await boardCategories(db));
  if (c.length === 0) return 0;
  const r = (await db.query('SELECT title, body, meta FROM kb_sources WHERE id = $1', [id])).rows[0];
  if (!r) return 0;
  const first = (await db.query('SELECT body FROM kb_chunks WHERE source_id = $1 ORDER BY ord LIMIT 3', [id])).rows.map((x) => x.body as string).join(' ');
  const m = (r.meta ?? {}) as Record<string, string>;
  return assignCategories(db, id, `${r.title} ${r.body ?? first} ${m.subtopic ?? ''}`, c);
}

/** Recompute board categories for every source (after the keywords were edited, or after documents were uploaded). */
export async function reapplyCategories(db: Db): Promise<{ sources: number; categorized: number }> {
  const cats = await boardCategories(db);
  const { rows } = await db.query(`SELECT id FROM kb_sources WHERE status = 'ready' AND parent_id IS NULL OR origin IS NOT NULL`);
  let categorized = 0;
  for (const r of rows) if (await categorizeSource(db, r.id as string, cats)) categorized++;
  return { sources: rows.length, categorized };
}

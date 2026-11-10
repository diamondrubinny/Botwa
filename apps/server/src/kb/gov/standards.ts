import { createHash } from 'node:crypto';
import type { Db } from '../../db.js';
import { FetchError } from '../fetch.js';
import type { KnowledgeBase } from '../service.js';
import { categorizeSource } from '../../safety/importer.js';
import { STANDARDS_ATTRIBUTION } from './notes.js';
import type { GovHttp } from './wikisource.js';

/**
 * Stage 2: the official standards in force in Israel ("מאגר תקנים רשמיים", Ministry of Economy and Industry, data.gov.il CKAN API).
 * The list holds number, name, edition, validity, amendments and which sections are mandatory; the text of a standard itself is sold by
 * the Standards Institution and is not available. Each standard becomes one question-and-answer entry ("ת"י 1847 חלק 1 – סולמות ...").
 */
export const DG_HOST = 'data.gov.il';
export const STANDARDS_RESOURCE = '1a4d94e2-369a-488d-a223-eb1020612fbd';
export const STANDARDS_DATASET_URL = 'https://data.gov.il/dataset/mandatory-standards';
export const STD_ORIGIN = 'gov:standards';
export const STD_CATEGORY = 'תקנים רשמיים (ייבוא אוטומטי)';
const FIELDS = ['index', 'standard_number', 'standard_name', 'standard_edition', 'validity_from', 'validity_to', 'amendments', 'mandatory_sections', 'note',
  'standard_process', 'standard_originality', 'standard_number_en', 'standard_name_en'] as const;
export type StdRecord = Record<(typeof FIELDS)[number], string | null>;

/**
 * Words that select the standards relevant to safety at work. A word matches a whole word of the name, also after a Hebrew prefix letter
 * (ו/ה/ב/כ/ל/מ/ש): "אש" matches "אש" and "באש" but not "האשה" or "אשפה". A word ending in * matches the start of a word
 * ("סולמ*" → סולמות). Several words together ("מתקני חשמל") match as a phrase.
 */
export const DEFAULT_KEYWORDS = [
  'סולמ*', 'פיגומ*', 'כיבוי', 'מטפ*', 'ציוד מגן', 'ביגוד מגן', 'כפפות מגן', 'קסדות בטיחות', 'מנעלי בטיחות', 'רתמ*', 'נפיל*', 'הרמה', 'עגורנ*', 'מעלי*', 'מלגז*',
  'גלאי*', 'עשן', 'אש', 'דליקות', 'מילוט', 'חירום', 'גפ"מ', 'גפ"ם', 'גז', 'גזים', 'רעש', 'נשימ*', 'עיניים', 'שמיעה', 'מסוכנים', 'ריתוך', 'מפסקי מגן', 'מפסק מגן',
  'מתקני חשמל', 'קיטור', 'דודי*', 'במות הרמה',
];

const PREFIX = 'והבכלמש';
const norm = (s: string) => s.normalize('NFKC').replace(/[֑-ׇ]/g, '').replace(/[״"]/g, '"').toLowerCase();
const tokens = (s: string) => norm(s).split(/[^\p{L}\p{N}"]+/u).filter(Boolean);

export function matchesKeywords(name: string, keywords: string[]): boolean {
  const toks = tokens(name);
  const flat = ` ${toks.join(' ')} `;
  return keywords.some((raw) => {
    const k = norm(raw.trim());
    if (!k) return false;
    const stem = k.endsWith('*');
    const w = stem ? k.slice(0, -1) : k;
    if (w.length < 2) return false;
    if (w.includes(' ')) return flat.includes(` ${w}`) || [...PREFIX].some((p) => flat.includes(` ${p}${w}`));
    return toks.some((t) => {
      const forms = [t, ...(t.length > w.length && PREFIX.includes(t[0]!) ? [t.slice(1)] : [])];
      return forms.some((f) => (stem ? f.startsWith(w) : f === w));
    });
  });
}

const clean = (v: string | null | undefined) => (v ?? '').replace(/<[^>]{0,500}>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const meaningful = (v: string | null | undefined) => { const c = clean(v); return c && !['אין', 'לא בתהליך', 'No amendments', 'None'].includes(c) ? c : ''; };

/** The knowledge-base entry of one standard: what staff (and, if allowed, customers) need to know about it, in plain text. */
export function standardEntry(r: StdRecord, asOf: string): { title: string; variants: string[]; body: string } {
  const num = clean(r.standard_number);
  const name = clean(r.standard_name);
  const en = [clean(r.standard_number_en), clean(r.standard_name_en)].filter(Boolean).join(' – ');
  const digits = /(\d[\d.]*)/.exec(num)?.[1] ?? '';
  const part = /חלק\s+([\d.]+)/.exec(num)?.[1];
  const from = clean(r.validity_from);
  const to = clean(r.validity_to);
  const lines = [
    `${num} – ${name}${en ? ` (${en})` : ''}`,
    `תקן רשמי בישראל (ברשימת התקנים הרשמיים של משרד הכלכלה והתעשייה).`,
    clean(r.standard_edition) && `מהדורה: ${clean(r.standard_edition)}.`,
    `תוקף: ${/^\d/.test(from) ? `מ־${from}` : 'בתוקף'}${/^\d/.test(to) ? `, עד ${to}` : ''}.`,
    clean(r.mandatory_sections) && `סעיפים מחייבים: ${clean(r.mandatory_sections)}.`,
    meaningful(r.amendments) && `גיליונות תיקון: ${meaningful(r.amendments)}.`,
    meaningful(r.standard_process) && `בתהליך: ${meaningful(r.standard_process)}.`,
    meaningful(r.standard_originality) && `מקור התקן: ${meaningful(r.standard_originality)}.`,
    meaningful(r.note) && `הערה: ${meaningful(r.note)}`,
    `נוסח התקן עצמו נרכש ממכון התקנים הישראלי. נכון ל־${asOf}.`,
  ].filter(Boolean) as string[];
  const variants = [...new Set([
    digits && `תקן ${digits}${part ? ` חלק ${part}` : ''}`,
    digits && `תקן ישראלי ${digits}${part ? ` חלק ${part}` : ''}`,
    digits && `ת"י ${digits}`,
    name,
    clean(r.standard_name_en),
  ].filter((v): v is string => !!v && v.length >= 2).map((v) => v.slice(0, 300)))].slice(0, 6);
  return { title: `${num} – ${name}`.slice(0, 300), variants, body: lines.join('\n').slice(0, 6000) };
}

export interface StdReport {
  at: string; trigger: 'manual' | 'schedule'; total: number; matched: number; created: number; updated: number; unchanged: number; removed: number; detached: number;
  skipped: boolean; failed: { title: string; error: string }[]; durationMs: number;
}
export interface StdSettings { enabled: boolean; audience: 'bot' | 'staff' | 'both'; refreshDays: number; keywords: string[]; includeAll: boolean; lastRunAt: string | null; lastReport: StdReport | null; sourceModified: string | null }
export interface DgOptions { http: GovHttp; sleep: (ms: number) => Promise<void> }

async function dgApi<T>(o: DgOptions, action: string, params: Record<string, string>): Promise<T> {
  const url = `https://${DG_HOST}/api/3/action/${action}?${new URLSearchParams(params)}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await o.http(url);
    if (r.status === 200) {
      let j: { success?: boolean; result?: T };
      try { j = JSON.parse(r.body); } catch { throw new FetchError('bad_response'); }
      if (!j.success || !j.result) throw new FetchError('bad_response');
      return j.result;
    }
    if (r.status === 429 || r.status === 503 || r.status === 502) { await o.sleep(Math.min(120, r.retryAfter ?? 15 * (attempt + 1)) * 1000 + 500); continue; }
    throw new FetchError(`http_${r.status}`);
  }
  throw new FetchError('rate_limited');
}

export class StandardsImporter {
  private running: Promise<StdReport> | null = null;
  constructor(private readonly db: Db, private readonly kb: KnowledgeBase, private dg: DgOptions) {}
  setDg(o: DgOptions): void { this.dg = o; }
  isRunning(): boolean { return this.running !== null; }

  async settings(): Promise<StdSettings> {
    const r = (await this.db.query(`SELECT enabled, audience, refresh_days, keywords, include_all, last_run_at, last_report, source_modified FROM gov_sources WHERE key = 'standards'`)).rows[0];
    return { enabled: r.enabled, audience: r.audience, refreshDays: r.refresh_days, keywords: r.keywords, includeAll: r.include_all, lastRunAt: r.last_run_at, lastReport: r.last_report, sourceModified: r.source_modified };
  }

  async imported() {
    return (await this.db.query(
      `SELECT s.id, s.title, s.enabled, s.status, s.detached, s.audience, s.last_fetched_at AS "fetchedAt" FROM kb_sources s WHERE s.origin = $1 ORDER BY s.title`, [STD_ORIGIN])).rows;
  }

  sync(trigger: StdReport['trigger'], userId: string | null = null, force = false): Promise<StdReport> {
    if (this.running) return this.running;
    this.running = this.run(trigger, userId, force).finally(() => { this.running = null; });
    return this.running;
  }

  async runDue(): Promise<StdReport | null> {
    const s = await this.settings();
    if (!s.enabled || this.running) return null;
    if (s.lastRunAt && Date.now() - new Date(s.lastRunAt).getTime() < s.refreshDays * 24 * 3600_000) return null;
    return this.sync('schedule');
  }

  private async run(trigger: StdReport['trigger'], userId: string | null, force: boolean): Promise<StdReport> {
    const t0 = Date.now();
    const rep: StdReport = { at: new Date().toISOString(), trigger, total: 0, matched: 0, created: 0, updated: 0, unchanged: 0, removed: 0, detached: 0, skipped: false, failed: [], durationMs: 0 };
    const s = await this.settings();
    // the filter is part of what is imported: when it changed, everything is matched again even if the source did not change
    const filterKey = createHash('sha256').update(JSON.stringify([s.includeAll, s.keywords, s.audience])).digest('hex').slice(0, 16);
    try {
      const res = await dgApi<{ last_modified?: string; metadata_modified?: string }>(this.dg, 'resource_show', { id: STANDARDS_RESOURCE });
      const modified = `${res.last_modified ?? res.metadata_modified ?? ''}|${filterKey}`;
      if (!force && s.sourceModified === modified) {
        rep.skipped = true;
        await this.db.query(`UPDATE kb_sources SET last_fetched_at = now() WHERE origin = $1`, [STD_ORIGIN]);
        return this.finish(rep, t0, null);
      }
      const data = await dgApi<{ total: number; records: StdRecord[] }>(this.dg, 'datastore_search', { resource_id: STANDARDS_RESOURCE, limit: '5000', fields: FIELDS.join(',') });
      const records = (data.records ?? []).filter((r) => clean(r.index) && clean(r.standard_number) && clean(r.standard_name));
      if (records.length < 50) throw new FetchError('unrecognized_format');   // a broken or emptied answer must not wipe the imported list
      rep.total = records.length;
      const keywords = s.keywords.length ? s.keywords : DEFAULT_KEYWORDS;
      const chosen = records.filter((r) => s.includeAll || matchesKeywords(`${clean(r.standard_name)} ${clean(r.standard_name_en)}`, keywords));
      rep.matched = chosen.length;
      await this.apply(chosen, s, userId, rep);
      return this.finish(rep, t0, rep.failed.length ? null : modified);   // after a partial failure the next run tries again
    } catch (e) {
      rep.failed.push({ title: '*', error: (e as Error).message.slice(0, 80) });
      return this.finish(rep, t0, null);
    }
  }

  private async apply(chosen: StdRecord[], s: StdSettings, userId: string | null, rep: StdReport): Promise<void> {
    const cat = (await this.db.query(`INSERT INTO kb_categories (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [STD_CATEGORY])).rows[0].id as string;
    const existing = new Map((await this.db.query(`SELECT id, external_id, detached, content_hash FROM kb_sources WHERE origin = $1`, [STD_ORIGIN])).rows.map((r) => [r.external_id as string, r]));
    const asOf = new Date().toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });
    const keep = new Set<string>();
    for (const r of chosen) {
      const ext = clean(r.index).slice(0, 120);
      if (keep.has(ext)) continue;
      keep.add(ext);
      const cur = existing.get(ext);
      if (cur?.detached) { rep.detached++; continue; }
      // the date in the text changes every run: the hash covers the source fields, not the rendered text
      const hash = createHash('sha256').update(JSON.stringify(FIELDS.map((f) => r[f] ?? ''))).digest('hex');
      if (cur && cur.content_hash === hash) {
        await this.db.query('UPDATE kb_sources SET audience = $2, last_fetched_at = now() WHERE id = $1', [cur.id, s.audience]);
        rep.unchanged++;
        continue;
      }
      const e = standardEntry(r, asOf);
      const meta = { source: 'data.gov.il', dataset: STANDARDS_DATASET_URL, attribution: STANDARDS_ATTRIBUTION, number: clean(r.standard_number), edition: clean(r.standard_edition) };
      try {
        let id: string;
        if (!cur) {
          id = (await this.db.query(
            `INSERT INTO kb_sources (kind, title, variants, body, url, reference, origin, external_id, meta, audience, category_id, created_by, content_hash)
             VALUES ('faq', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
            [e.title, e.variants, e.body, STANDARDS_DATASET_URL, clean(r.standard_number), STD_ORIGIN, ext, JSON.stringify(meta), s.audience, cat, userId, hash])).rows[0].id;
          rep.created++;
        } else {
          id = cur.id;
          await this.db.query(`UPDATE kb_sources SET title = $2, variants = $3, body = $4, meta = $5, audience = $6, content_hash = $7, enabled = true, error = NULL, updated_at = now() WHERE id = $1`,
            [id, e.title, e.variants, e.body, JSON.stringify(meta), s.audience, hash]);
          rep.updated++;
        }
        await this.kb.indexWritten(id);
        await categorizeSource(this.db, id).catch(() => 0);
      } catch (err) { rep.failed.push({ title: clean(r.standard_number), error: (err as Error).message.slice(0, 80) }); }
    }
    // standards no longer official (or no longer matching the words): their entries go; an edited one stays as the staff's own entry
    for (const [ext, r] of existing) {
      if (keep.has(ext)) continue;
      if (r.detached) await this.db.query('UPDATE kb_sources SET origin = NULL, external_id = NULL WHERE id = $1', [r.id]);
      else await this.db.query('DELETE FROM kb_sources WHERE id = $1', [r.id]);
      rep.removed++;
    }
  }

  private async finish(rep: StdReport, t0: number, modified: string | null): Promise<StdReport> {
    rep.durationMs = Date.now() - t0;
    await this.db.query(`UPDATE gov_sources SET last_run_at = now(), last_report = $1, source_modified = COALESCE($2, source_modified) WHERE key = 'standards'`, [JSON.stringify(rep), modified]);
    return rep;
  }
}

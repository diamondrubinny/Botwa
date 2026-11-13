import { createHash } from 'node:crypto';
import type { Db } from '../../db.js';
import { FetchError } from '../fetch.js';
import type { KnowledgeBase } from '../service.js';
import { categorizeSource } from '../../safety/importer.js';
import { FIRE_ATTRIBUTION } from './notes.js';
import { dgApi, type DgOptions } from './standards.js';

/**
 * Stage 4: fire-safety requirements of the National Fire and Rescue Authority for a business licence ("דרישות בטיחות אש לרישוי עסקים",
 * data.gov.il). About 22,000 rows: each requirement once per business sub-type (pharmacy up to 200 m², 200-500 m² ...). Staff choose
 * business types (the 71 of the licensing order); each sub-type becomes one source with one passage per requirement, so a question about
 * "pharmacy over 500 m²" lands on exactly its requirements. Off and staff-only by default.
 */
export const FIRE_DATASET = 'businessreq';
export const FIRE_DATASET_URL = 'https://data.gov.il/dataset/businessreq';
export const FIRE_ORIGIN = 'gov:fire';
export const FIRE_CATEGORY = 'דרישות כבאות לרישוי עסקים (ייבוא אוטומטי)';
const FIELDS = ['CategoryDesc1', 'CategoryCode2', 'CategoryDesc2', 'CategoryDesc3', 'CategoryDesc4', 'CategoryDesc5', 'CategoryDesc6', 'CategoryDesc7', 'RequirementNumber', 'RequirementDesc', 'Remarks', 'REQUIREMENT_SOURCE_DESC'] as const;
type FireRow = Partial<Record<(typeof FIELDS)[number], string | number | null>>;
const PAGE = 3000;   // about 3 MB per page with the fields used
const MAX_ROWS = 60_000;

export interface FireType { code: string; name: string; group: string; subtypes: number; requirements: number }
export interface FireSubtype { code: string; typeName: string; group: string; path: string[]; requirements: { number: string; title: string; text: string; source: string }[] }

const c = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return s.trim() === 'NULL' ? '' : s.replace(/<[^>]{0,500}>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(); };
/** "1.01" / 1.01 / "  1.01" → "1.01"; numbers keep two decimals (the order's numbering: 4.1 is 4.10). */
const codeOf = (v: unknown) => { const s = c(v); if (!s) return ''; const n = Number(s); return Number.isFinite(n) ? n.toFixed(2) : s.slice(0, 20); };

/** Group the rows by business type and by the most specific sub-type, without repeating a requirement within a sub-type. */
export function groupRows(rows: FireRow[]): { types: FireType[]; subtypes: Map<string, FireSubtype[]> } {
  const byType = new Map<string, { name: string; group: string; subs: Map<string, FireSubtype> ; reqs: number }>();
  for (const r of rows) {
    const group = c(r.CategoryDesc1);
    const code = codeOf(r.CategoryCode2);
    const name = c(r.CategoryDesc2);
    if (!code || !name || !group) continue;               // a row of a whole group (no business type) is not a business
    const title = c(r.RequirementDesc);
    const text = c(r.Remarks);
    if (!title && !text) continue;
    const path = [c(r.CategoryDesc3), c(r.CategoryDesc4), c(r.CategoryDesc5), c(r.CategoryDesc6), c(r.CategoryDesc7)].filter(Boolean);
    let t = byType.get(code);
    if (!t) { t = { name, group, subs: new Map(), reqs: 0 }; byType.set(code, t); }
    const key = path.join(' › ');
    let sub = t.subs.get(key);
    if (!sub) { sub = { code, typeName: t.name, group, path, requirements: [] }; t.subs.set(key, sub); }
    const req = { number: c(r.RequirementNumber).slice(0, 40), title: title.slice(0, 300), text: text.slice(0, 4000), source: c(r.REQUIREMENT_SOURCE_DESC).slice(0, 200) };
    if (sub.requirements.some((x) => x.number === req.number && x.title === req.title && x.text === req.text)) continue;
    sub.requirements.push(req);
    t.reqs++;
  }
  const types = [...byType.entries()].map(([code, t]) => ({ code, name: t.name, group: t.group, subtypes: t.subs.size, requirements: t.reqs }))
    .sort((a, b) => Number(a.code) - Number(b.code) || a.code.localeCompare(b.code));
  return { types, subtypes: new Map([...byType.entries()].map(([code, t]) => [code, [...t.subs.values()]])) };
}

/** Text of one sub-type: one "### דרישה ..." heading per requirement, so every requirement is a passage of its own. */
export function subtypeEntry(s: FireSubtype, asOf: string): { title: string; body: string; externalId: string } {
  const where = [s.typeName, ...s.path].join(' › ');
  const lines = [
    `דרישות בטיחות אש של הרשות הארצית לכבאות והצלה לקבלת רישיון עסק או חידושו, נכון ל־${asOf}.`,
    `סוג העסק: ${s.group} › ${where}`,
    '',
  ];
  for (const r of s.requirements) {
    // a short label in the heading, the whole requirement in the passage (the passage is what an answer quotes)
    const label = r.title.length <= 80 ? r.title : `${r.title.slice(0, 77).replace(/\s+\S*$/, '')}…`;
    lines.push(`### דרישה ${r.number || '—'}${label ? ` – ${label}` : ''}`, '');
    if (r.title) lines.push(r.title);
    if (r.text) lines.push(r.text);
    if (r.source) lines.push(`מקור הדרישה: ${r.source}.`);
    lines.push('');
  }
  return {
    title: `דרישות כבאות לרישוי עסקים – ${where}`.slice(0, 300),
    body: lines.join('\n').slice(0, 190_000),
    externalId: `${s.code}|${createHash('sha256').update(s.path.join('|')).digest('hex').slice(0, 16)}`,
  };
}

export interface FireReport {
  at: string; trigger: 'manual' | 'schedule'; resource: string | null; total: number; types: number; chosen: number; created: number; updated: number; unchanged: number; removed: number; detached: number;
  skipped: boolean; failed: { title: string; error: string }[]; durationMs: number;
}
export interface FireSettings { enabled: boolean; audience: 'bot' | 'staff' | 'both'; refreshDays: number; selection: string[]; catalog: FireType[] | null; catalogAt: string | null; lastRunAt: string | null; lastReport: FireReport | null; sourceModified: string | null }

export class FireImporter {
  private running: Promise<FireReport> | null = null;
  constructor(private readonly db: Db, private readonly kb: KnowledgeBase, private dg: DgOptions) {}
  setDg(o: DgOptions): void { this.dg = o; }
  isRunning(): boolean { return this.running !== null; }

  async settings(): Promise<FireSettings> {
    const r = (await this.db.query(`SELECT enabled, audience, refresh_days, selection, catalog_json, catalog_at, last_run_at, last_report, source_modified FROM gov_sources WHERE key = 'fire'`)).rows[0];
    return { enabled: r.enabled, audience: r.audience, refreshDays: r.refresh_days, selection: r.selection, catalog: r.catalog_json, catalogAt: r.catalog_at, lastRunAt: r.last_run_at, lastReport: r.last_report, sourceModified: r.source_modified };
  }

  async imported() {
    return (await this.db.query(
      `SELECT s.id, s.title, s.enabled, s.status, s.detached, s.audience, split_part(s.external_id, '|', 1) AS code, (SELECT count(*)::int FROM kb_chunks c WHERE c.source_id = s.id) AS chunks
         FROM kb_sources s WHERE s.origin = $1 ORDER BY s.title`, [FIRE_ORIGIN])).rows;
  }

  sync(trigger: FireReport['trigger'], userId: string | null = null): Promise<FireReport> {
    if (this.running) return this.running;
    this.running = this.run(trigger, userId).finally(() => { this.running = null; });
    return this.running;
  }

  async runDue(): Promise<FireReport | null> {
    const s = await this.settings();
    if (!s.enabled || this.running) return null;
    if (s.lastRunAt && Date.now() - new Date(s.lastRunAt).getTime() < s.refreshDays * 24 * 3600_000) return null;
    return this.sync('schedule');
  }

  /** The newest snapshot of the dataset (it is published as a new file every month or so). */
  private async latest(): Promise<{ id: string; modified: string }> {
    const p = await dgApi<{ resources?: { id: string; datastore_active?: boolean; last_modified?: string | null; created?: string; format?: string }[] }>(this.dg, 'package_show', { id: FIRE_DATASET });
    const rs = (p.resources ?? []).filter((r) => r.datastore_active && /^[0-9a-f-]{36}$/.test(r.id))
      .sort((a, b) => (b.last_modified ?? b.created ?? '').localeCompare(a.last_modified ?? a.created ?? ''));
    if (!rs[0]) throw new FetchError('unrecognized_format');
    return { id: rs[0].id, modified: rs[0].last_modified ?? rs[0].created ?? '' };
  }

  private async rows(resource: string): Promise<FireRow[]> {
    const out: FireRow[] = [];
    for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
      const res = await dgApi<{ total?: number; records?: FireRow[] }>(this.dg, 'datastore_search', { resource_id: resource, limit: String(PAGE), offset: String(offset), fields: FIELDS.join(',') });
      const recs = res.records ?? [];
      out.push(...recs);
      if (recs.length < PAGE || out.length >= (res.total ?? 0)) break;
      await this.dg.sleep(500);
    }
    return out;
  }

  private async run(trigger: FireReport['trigger'], userId: string | null): Promise<FireReport> {
    const t0 = Date.now();
    const rep: FireReport = { at: new Date().toISOString(), trigger, resource: null, total: 0, types: 0, chosen: 0, created: 0, updated: 0, unchanged: 0, removed: 0, detached: 0, skipped: false, failed: [], durationMs: 0 };
    const s = await this.settings();
    try {
      const res = await this.latest();
      rep.resource = res.id;
      const key = `${res.id}|${res.modified}|${createHash('sha256').update(JSON.stringify([s.selection, s.audience])).digest('hex').slice(0, 16)}`;
      if (s.sourceModified === key && s.catalog) { rep.skipped = true; return this.finish(rep, t0, null, null); }
      const rows = await this.rows(res.id);
      const { types, subtypes } = groupRows(rows);
      if (rows.length < 1000 || types.length < 10) throw new FetchError('unrecognized_format');   // a broken answer must not wipe what was imported
      rep.total = rows.length;
      rep.types = types.length;
      const chosen = s.selection.filter((code) => subtypes.has(code));
      rep.chosen = chosen.length;
      await this.apply(chosen.flatMap((code) => subtypes.get(code)!), s, userId, rep);
      return this.finish(rep, t0, rep.failed.length ? null : key, types);
    } catch (e) {
      rep.failed.push({ title: '*', error: (e as Error).message.slice(0, 80) });
      return this.finish(rep, t0, null, null);
    }
  }

  private async apply(subs: FireSubtype[], s: FireSettings, userId: string | null, rep: FireReport): Promise<void> {
    const cat = (await this.db.query(`INSERT INTO kb_categories (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [FIRE_CATEGORY])).rows[0].id as string;
    const existing = new Map((await this.db.query(`SELECT id, external_id, detached, content_hash FROM kb_sources WHERE origin = $1`, [FIRE_ORIGIN])).rows.map((r) => [r.external_id as string, r]));
    const asOf = new Date().toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });
    const keep = new Set<string>();
    for (const sub of subs) {
      const e = subtypeEntry(sub, asOf);
      if (keep.has(e.externalId)) continue;
      keep.add(e.externalId);
      const cur = existing.get(e.externalId);
      if (cur?.detached) { rep.detached++; continue; }
      const hash = createHash('sha256').update(JSON.stringify([sub.group, sub.typeName, sub.path, sub.requirements])).digest('hex');
      if (cur && cur.content_hash === hash) {
        await this.db.query('UPDATE kb_sources SET audience = $2, last_fetched_at = now() WHERE id = $1', [cur.id, s.audience]);
        rep.unchanged++;
        continue;
      }
      const meta = { source: 'data.gov.il', dataset: FIRE_DATASET_URL, attribution: FIRE_ATTRIBUTION, type: sub.typeName, code: sub.code, requirements: sub.requirements.length };
      try {
        let id: string;
        if (!cur) {
          id = (await this.db.query(
            `INSERT INTO kb_sources (kind, title, body, url, reference, origin, external_id, meta, audience, category_id, created_by, content_hash)
             VALUES ('text', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
            [e.title, e.body, FIRE_DATASET_URL, `רישוי עסקים ${sub.code}`, FIRE_ORIGIN, e.externalId, JSON.stringify(meta), s.audience, cat, userId, hash])).rows[0].id;
          rep.created++;
        } else {
          id = cur.id;
          await this.db.query(`UPDATE kb_sources SET title = $2, body = $3, meta = $4, audience = $5, content_hash = $6, enabled = true, error = NULL, updated_at = now() WHERE id = $1`,
            [id, e.title, e.body, JSON.stringify(meta), s.audience, hash]);
          rep.updated++;
        }
        await this.kb.indexWritten(id);
        await categorizeSource(this.db, id).catch(() => 0);
      } catch (err) { rep.failed.push({ title: e.title.slice(0, 80), error: (err as Error).message.slice(0, 80) }); }
    }
    for (const [ext, r] of existing) {
      if (keep.has(ext)) continue;
      if (r.detached) await this.db.query('UPDATE kb_sources SET origin = NULL, external_id = NULL WHERE id = $1', [r.id]);
      else await this.db.query('DELETE FROM kb_sources WHERE id = $1', [r.id]);
      rep.removed++;
    }
  }

  private async finish(rep: FireReport, t0: number, key: string | null, types: FireType[] | null): Promise<FireReport> {
    rep.durationMs = Date.now() - t0;
    await this.db.query(
      `UPDATE gov_sources SET last_run_at = now(), last_report = $1, source_modified = COALESCE($2, source_modified),
              catalog_json = COALESCE($3::jsonb, catalog_json), catalog_at = CASE WHEN $3::jsonb IS NULL THEN catalog_at ELSE now() END WHERE key = 'fire'`,
      [JSON.stringify(rep), key, types ? JSON.stringify(types) : null]);
    return rep;
  }
}

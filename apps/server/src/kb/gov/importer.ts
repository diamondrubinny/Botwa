import { createHash } from 'node:crypto';
import type { Db } from '../../db.js';
import type { KnowledgeBase } from '../service.js';
import { categorizeSource } from '../../safety/importer.js';
import { ATTRIBUTION } from './notes.js';
import { parseLawWikitext } from './wikilaw.js';
import { catalog, DEFAULT_TITLES, fetchPage, isLawTitle, pageUrl, revisions, type WsOptions } from './wikisource.js';

export const ORIGIN = 'gov:wikisource';
export const CATEGORY_NAME = 'חקיקה ותקינה (ייבוא אוטומטי)';

export interface GovReport {
  at: string; trigger: 'manual' | 'schedule'; checked: number; created: number; updated: number; unchanged: number; removed: number; detached: number;
  failed: { title: string; error: string }[]; missing: string[]; durationMs: number;
}
export interface GovSettings { enabled: boolean; audience: 'bot' | 'staff' | 'both'; refreshDays: number; selection: string[]; catalog: string[] | null; catalogAt: string | null; lastRunAt: string | null; lastReport: GovReport | null }

/** Titles typed or chosen by staff become API parameters: only plain law titles are accepted (no wiki syntax, no sub-pages). */
export const validTitle = (t: string) => isLawTitle(t) && !/[|#<>[\]{}\u0000-\u001f]/.test(t);

export class GovImporter {
  private running: Promise<GovReport> | null = null;
  constructor(private readonly db: Db, private readonly kb: KnowledgeBase, private ws: WsOptions) {}
  /** Tests replace the network. */
  setWs(o: WsOptions): void { this.ws = o; }
  isRunning(): boolean { return this.running !== null; }

  async settings(): Promise<GovSettings> {
    const r = (await this.db.query(`SELECT enabled, audience, refresh_days, selection, catalog, catalog_at, last_run_at, last_report FROM gov_sources WHERE key = 'wikisource'`)).rows[0];
    return { enabled: r.enabled, audience: r.audience, refreshDays: r.refresh_days, selection: r.selection, catalog: r.catalog, catalogAt: r.catalog_at, lastRunAt: r.last_run_at, lastReport: r.last_report };
  }

  /** The titles to keep imported: the staff's choice, or the default list. */
  async wanted(): Promise<string[]> {
    const s = await this.settings();
    return (s.selection.length ? s.selection : DEFAULT_TITLES).filter(validTitle);
  }

  async refreshCatalog(): Promise<string[]> {
    const list = (await catalog(this.ws)).filter(validTitle).slice(0, 1000);
    await this.db.query(`UPDATE gov_sources SET catalog = $1, catalog_at = now() WHERE key = 'wikisource'`, [list]);
    return list;
  }

  /** Imported rows with their state, for the settings screen. */
  async imported() {
    return (await this.db.query(
      `SELECT s.id, s.title, s.external_id AS "pageTitle", s.url, s.enabled, s.status, s.error, s.detached, s.audience, s.last_fetched_at AS "fetchedAt",
              (s.meta->>'revid')::int AS revid, (s.meta->>'sections')::int AS sections, (SELECT count(*)::int FROM kb_chunks c WHERE c.source_id = s.id) AS chunks
         FROM kb_sources s WHERE s.origin = $1 ORDER BY s.external_id`, [ORIGIN])).rows;
  }

  /** Start a sync unless one runs already (the same promise is returned then). */
  sync(trigger: GovReport['trigger'], userId: string | null = null): Promise<GovReport> {
    if (this.running) return this.running;
    this.running = this.run(trigger, userId).finally(() => { this.running = null; });
    return this.running;
  }

  /** Called hourly: syncs when enabled and the refresh interval has passed. */
  async runDue(): Promise<GovReport | null> {
    const s = await this.settings();
    if (!s.enabled || this.running) return null;
    if (s.lastRunAt && Date.now() - new Date(s.lastRunAt).getTime() < s.refreshDays * 24 * 3600_000) return null;
    return this.sync('schedule');
  }

  private async categoryId(): Promise<string> {
    const r = await this.db.query(`INSERT INTO kb_categories (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [CATEGORY_NAME]);
    return r.rows[0].id as string;
  }

  private async run(trigger: GovReport['trigger'], userId: string | null): Promise<GovReport> {
    const t0 = Date.now();
    const rep: GovReport = { at: new Date().toISOString(), trigger, checked: 0, created: 0, updated: 0, unchanged: 0, removed: 0, detached: 0, failed: [], missing: [], durationMs: 0 };
    const s = await this.settings();
    const wanted = await this.wanted();
    const catId = await this.categoryId();
    const existing = new Map((await this.db.query(`SELECT id, external_id, detached, meta FROM kb_sources WHERE origin = $1`, [ORIGIN])).rows.map((r) => [r.external_id as string, r]));

    // titles no longer chosen: their imported copies go (an edited copy is kept, it is the staff's own text now)
    for (const [title, r] of existing) {
      if (wanted.includes(title)) continue;
      if (r.detached) await this.db.query(`UPDATE kb_sources SET origin = NULL, external_id = NULL WHERE id = $1`, [r.id]);
      else await this.db.query('DELETE FROM kb_sources WHERE id = $1', [r.id]);
      rep.removed++;
    }

    let revs: Map<string, { title: string; revid: number } | null>;
    try { revs = await revisions(this.ws, wanted); } catch (e) {
      rep.failed.push({ title: '*', error: (e as Error).message.slice(0, 80) });
      return this.finish(rep, t0);
    }

    for (const title of wanted) {
      rep.checked++;
      const cur = existing.get(title);
      const rv = revs.get(title);
      if (!rv) {
        rep.missing.push(title);
        // a page that disappeared at the source stops answering (kept, so staff can see what it was)
        if (cur && !cur.detached) await this.db.query(`UPDATE kb_sources SET enabled = false, status = 'error', error = 'gone', updated_at = now() WHERE id = $1`, [cur.id]);
        continue;
      }
      if (cur?.detached) { rep.detached++; continue; }
      if (cur && Number(cur.meta?.revid) === rv.revid) {
        await this.db.query(`UPDATE kb_sources SET last_fetched_at = now(), audience = $2 WHERE id = $1`, [cur.id, s.audience]);
        rep.unchanged++;
        continue;
      }
      try {
        await this.ws.sleep(this.ws.gapMs);
        const page = await fetchPage(this.ws, title);
        if (!page) { rep.missing.push(title); continue; }
        const law = parseLawWikitext(page.content, page.title);
        if (law.text.length < 200 || law.sections === 0) throw new Error('unrecognized_format');
        const meta = { revid: page.revid, revisedAt: page.timestamp, sections: law.sections, signed: law.signed, knessetId: law.knessetId, publications: law.publications.slice(0, 60), attribution: ATTRIBUTION, source: 'wikisource' };
        const hash = createHash('sha256').update(law.text).digest('hex');
        const url = pageUrl(page.title);
        let id: string;
        if (!cur) {
          id = (await this.db.query(
            `INSERT INTO kb_sources (kind, title, body, url, reference, origin, external_id, meta, audience, category_id, created_by, content_hash)
             VALUES ('text', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
            [law.title.slice(0, 300), law.text, url, page.title, ORIGIN, title, JSON.stringify(meta), s.audience, catId, userId, hash])).rows[0].id;
          rep.created++;
        } else {
          id = cur.id;
          await this.db.query(
            `UPDATE kb_sources SET title = $2, body = $3, url = $4, meta = $5, audience = $6, content_hash = $7, enabled = true, error = NULL, updated_at = now() WHERE id = $1`,
            [id, law.title.slice(0, 300), law.text, url, JSON.stringify(meta), s.audience, hash]);
          rep.updated++;
        }
        await this.kb.indexWritten(id);
        await categorizeSource(this.db, id).catch(() => 0);   // topics of the safety board (heights, electricity ...)
      } catch (e) {
        rep.failed.push({ title, error: (e as Error).message.slice(0, 80) });
        if (cur) await this.db.query(`UPDATE kb_sources SET error = $2 WHERE id = $1`, [cur.id, (e as Error).message.slice(0, 120)]);
      }
    }
    return this.finish(rep, t0);
  }

  private async finish(rep: GovReport, t0: number): Promise<GovReport> {
    rep.durationMs = Date.now() - t0;
    await this.db.query(`UPDATE gov_sources SET last_run_at = now(), last_report = $1 WHERE key = 'wikisource'`, [JSON.stringify(rep)]);
    return rep;
  }
}

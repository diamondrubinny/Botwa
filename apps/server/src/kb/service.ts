import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import type { MediaService } from '../media/store.js';
import { checkUrl, FetchError, safeGet, type Fetched } from './fetch.js';
import { extract, kindFor, type DocKind } from './extract.js';
import { bestSnippet, chunkText, indexTerms, queryTokens, variants, words } from './text.js';

export type Audience = 'bot' | 'staff' | 'both';
export interface Hit {
  sourceId: string; chunkId: number; title: string; kind: string; url: string | null; heading: string | null;
  snippet: string; score: number; matched: number; tokens: number; exact: boolean;
}
export interface AnswerSettings { minScore: number; maxChars: number }

const BINARY: DocKind[] = ['pdf', 'docx'];
const MAX_CHUNKS_TOTAL = 30_000;

export class KnowledgeBase {
  private chain: Promise<unknown> = Promise.resolve();
  private fetcher: (url: string) => Promise<Fetched> = safeGet;
  /** Tests replace the network layer. */
  setFetcher(f: (url: string) => Promise<Fetched>): void { this.fetcher = f; }
  private synCache: { at: number; groups: string[][] } = { at: 0, groups: [] };

  constructor(private readonly db: Db, private readonly cfg: Config, private readonly media: MediaService) {}

  /** Resolves when queued ingestion work has finished (tests, shutdown). */
  idle(): Promise<unknown> { return this.chain; }

  enqueue(sourceId: string): void {
    this.chain = this.chain.then(() => this.process(sourceId)).catch(() => undefined);
  }

  /** After a restart: pick up sources that were still pending. */
  async resumePending(): Promise<void> {
    const { rows } = await this.db.query(`SELECT id FROM kb_sources WHERE status = 'pending' AND kind IN ('link') ORDER BY created_at`);
    for (const r of rows) this.enqueue(r.id as string);
  }

  /** Re-read links whose refresh interval has passed (called hourly). */
  async refreshDue(): Promise<number> {
    const { rows } = await this.db.query(
      `SELECT id FROM kb_sources WHERE kind = 'link' AND enabled AND refresh_hours IS NOT NULL AND parent_id IS NULL
          AND (last_fetched_at IS NULL OR last_fetched_at < now() - make_interval(hours => refresh_hours)) LIMIT 20`,
    );
    for (const r of rows) this.enqueue(r.id as string);
    return rows.length;
  }

  // ---- ingestion ---------------------------------------------------------------------------------------------------
  private async replaceChunks(sourceId: string, title: string, variantsList: string[], text: string): Promise<number> {
    const total = (await this.db.query('SELECT count(*)::int AS n FROM kb_chunks WHERE source_id <> $1', [sourceId])).rows[0].n as number;
    const chunks = chunkText(text);
    if (total + chunks.length > MAX_CHUNKS_TOTAL) throw new Error('kb_full');
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM kb_chunks WHERE source_id = $1', [sourceId]);
      let ord = 0;
      for (const c of chunks) {
        const terms = indexTerms(`${title} ${variantsList.join(' ')} ${c.heading ?? ''} ${c.body}`);
        await client.query(`INSERT INTO kb_chunks (source_id, ord, heading, body, terms, tsv) VALUES ($1,$2,$3,$4,$5,to_tsvector('simple', $5))`, [sourceId, ord++, c.heading, c.body, terms]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
    return chunks.length;
  }

  private async setReady(id: string, patch: { title?: string; hash?: string; error?: null }) {
    await this.db.query(
      `UPDATE kb_sources SET status = 'ready', error = NULL, last_fetched_at = now(), updated_at = now(), title = COALESCE($2, title), content_hash = COALESCE($3, content_hash) WHERE id = $1`,
      [id, patch.title ?? null, patch.hash ?? null],
    );
  }
  private async setError(id: string, code: string) {
    await this.db.query(`UPDATE kb_sources SET status = 'error', error = $2, last_fetched_at = now(), updated_at = now() WHERE id = $1`, [id, code.slice(0, 120)]);
  }

  /** (Re)build the searchable chunks of a faq/text source from what staff wrote. */
  async indexWritten(id: string): Promise<void> {
    const { rows } = await this.db.query('SELECT title, variants, body FROM kb_sources WHERE id = $1', [id]);
    const s = rows[0];
    if (!s) return;
    try {
      const n = await this.replaceChunks(id, s.title, s.variants, s.body ?? '');
      if (n === 0) throw new Error('empty_content');
      await this.db.query('UPDATE kb_sources SET version = version + 1 WHERE id = $1', [id]);
      await this.setReady(id, {});
    } catch (e) { await this.setError(id, (e as Error).message); throw e; }
  }

  /** Index uploaded or fetched document bytes for a source (replacing earlier content). Returns false when content is unchanged. */
  async indexDocument(id: string, kind: DocKind, data: Buffer, nameForTitle: string): Promise<boolean> {
    const hash = createHash('sha256').update(data).digest('hex');
    const cur = (await this.db.query('SELECT content_hash, title, (SELECT count(*)::int FROM kb_chunks WHERE source_id = $1) AS chunks FROM kb_sources WHERE id = $1', [id])).rows[0];
    if (!cur) return false;
    if (cur.content_hash === hash && cur.chunks > 0) { await this.setReady(id, {}); return false; } // nothing changed: keep the version
    if (BINARY.includes(kind)) {
      const scan = await this.media.scanBuffer(data);
      if (scan.status === 'infected') throw new Error('infected');
      if (scan.status !== 'clean') throw new Error('scan_unavailable'); // fail closed, like attachments
    }
    const ex = await extract(kind, data);
    if (!ex.text.trim()) throw new Error('empty_content');
    const title = cur.title && cur.title !== nameForTitle ? cur.title : (ex.title ?? nameForTitle).slice(0, 300);
    const n = await this.replaceChunks(id, title, [], ex.text);
    if (n === 0) throw new Error('empty_content');
    await this.db.query('UPDATE kb_sources SET version = version + 1 WHERE id = $1', [id]);
    await this.setReady(id, { title, hash });
    this.lastLinks.set(id, ex.links);
    return true;
  }
  private lastLinks = new Map<string, string[]>();

  /** Fetch + index one link source; optionally crawl same-site pages it links to. */
  private async process(id: string): Promise<void> {
    const { rows } = await this.db.query('SELECT id, kind, url, title, crawl_pages, parent_id FROM kb_sources WHERE id = $1', [id]);
    const s = rows[0];
    if (!s || s.kind !== 'link' || !s.url) return;
    try {
      const f = await this.fetcher(s.url);
      const kind = kindFor(f.url, f.contentType);
      if (!kind) throw new FetchError('unsupported_content_type');
      await this.indexDocument(id, kind, f.body, s.title);
      if (s.crawl_pages > 0 && !s.parent_id && kind === 'html') await this.crawl(id, f.url, s.crawl_pages, this.lastLinks.get(id) ?? []);
    } catch (e) {
      await this.setError(id, e instanceof Error ? e.message : 'failed');
    } finally {
      this.lastLinks.delete(id);
    }
  }

  private async crawl(parentId: string, baseUrl: string, limit: number, links: string[]): Promise<void> {
    const base = new URL(baseUrl);
    const seen = new Set<string>([base.toString()]);
    const todo: string[] = [];
    for (const h of links) {
      try {
        const u = new URL(h, base);
        u.hash = '';
        if (u.origin !== base.origin || !/^https?:$/.test(u.protocol)) continue;
        if (/\.(jpe?g|png|gif|svg|webp|ico|css|js|zip|mp4|mp3|xml|json)(\?|$)/i.test(u.pathname)) continue;
        const key = u.toString();
        if (seen.has(key)) continue;
        seen.add(key); todo.push(key);
      } catch { /* ignore malformed links */ }
      if (todo.length >= limit) break;
    }
    const meta = (await this.db.query('SELECT category_id, audience, boost, created_by FROM kb_sources WHERE id = $1', [parentId])).rows[0];
    for (const url of todo) {
      await new Promise((r) => setTimeout(r, this.cfg.NODE_ENV === 'test' ? 0 : 400)); // be polite to the site
      const ins = await this.db.query(
        `INSERT INTO kb_sources (kind, title, url, category_id, audience, boost, parent_id, created_by) VALUES ('link', $1, $1, $2, $3, $4, $5, $6)
         ON CONFLICT (url) WHERE kind = 'link' DO NOTHING RETURNING id`,
        [url, meta.category_id, meta.audience, meta.boost, parentId, meta.created_by],
      );
      const childId = (ins.rows[0]?.id ?? (await this.db.query(`SELECT id FROM kb_sources WHERE kind = 'link' AND url = $1 AND parent_id = $2`, [url, parentId])).rows[0]?.id) as string | undefined;
      if (!childId) continue; // already exists as an independent source
      try {
        const f = await this.fetcher(url);
        const kind = kindFor(f.url, f.contentType);
        if (!kind) throw new FetchError('unsupported_content_type');
        await this.indexDocument(childId, kind, f.body, url);
      } catch (e) { await this.setError(childId, e instanceof Error ? e.message : 'failed'); }
    }
  }

  static validateUrl(raw: string): string {
    return checkUrl(raw).toString();
  }

  // ---- search ------------------------------------------------------------------------------------------------------
  private async synonymGroups(): Promise<string[][]> {
    if (Date.now() - this.synCache.at < 15_000) return this.synCache.groups;
    const { rows } = await this.db.query('SELECT words FROM kb_synonyms');
    this.synCache = { at: Date.now(), groups: rows.map((r) => (r.words as string[]).flatMap((w) => words(w)).filter(Boolean)) };
    return this.synCache.groups;
  }
  invalidateSynonyms(): void { this.synCache.at = 0; }

  async search(question: string, opts: { audience: 'bot' | 'staff' | 'any'; limit?: number; categoryId?: string } = { audience: 'any' }): Promise<Hit[]> {
    const tokens = queryTokens(question).slice(0, 14);
    if (tokens.length === 0) return [];
    const groups = await this.synonymGroups();
    const alts: Set<string>[] = tokens.map((t) => {
      const set = new Set(variants(t));
      for (const g of groups) if (g.some((w) => variants(w).some((v) => set.has(v)))) for (const w of g) for (const v of variants(w)) set.add(v);
      return set;
    });
    const terms = [...new Set(alts.flatMap((s) => [...s]))].filter((x) => /^[\p{L}\p{N}]+$/u.test(x)).slice(0, 80);
    if (terms.length === 0) return [];
    const { rows } = await this.db.query(
      `SELECT c.id, c.source_id, c.heading, c.body, c.terms, s.title, s.kind, s.url, s.boost, s.variants,
              ts_rank_cd(c.tsv, q.query) AS rank
         FROM kb_chunks c JOIN kb_sources s ON s.id = c.source_id, to_tsquery('simple', $1) AS q(query)
        WHERE c.tsv @@ q.query AND s.enabled AND s.status = 'ready'
          AND ($2::text = 'any' OR s.audience IN ('both', $2))
          AND ($3::uuid IS NULL OR s.category_id = $3)
        ORDER BY rank DESC LIMIT 60`,
      [terms.join(' | '), opts.audience, opts.categoryId ?? null],
    );
    const qSet = new Set(tokens);
    const best = new Map<string, Hit & { rank: number }>();
    for (const r of rows) {
      const termSet = new Set((r.terms as string).split(' '));
      const matched = alts.filter((a) => [...a].some((x) => termSet.has(x))).length;
      const titleSet = new Set(indexTerms(`${r.title} ${(r.variants as string[]).join(' ')} ${r.heading ?? ''}`).split(' '));
      const titleHits = alts.filter((a) => [...a].some((x) => titleSet.has(x))).length;
      const phrases = [r.title as string, ...(r.variants as string[])];
      const exact = r.kind === 'faq' && phrases.some((p) => { const pt = queryTokens(p); return pt.length > 0 && pt.length === qSet.size && pt.every((t) => qSet.has(t)); });
      const coverage = matched / tokens.length;
      let score = Math.min(1, coverage * 0.8 + (titleHits / tokens.length) * 0.2);
      if (exact) score = 1;
      score = Math.min(1, score + (r.boost as number) * 0.04);
      const hit = { sourceId: r.source_id as string, chunkId: Number(r.id), title: r.title as string, kind: r.kind as string, url: r.url as string | null, heading: r.heading as string | null,
        snippet: r.body as string, score: Math.round(score * 100) / 100, matched, tokens: tokens.length, exact, rank: Number(r.rank) };
      const cur = best.get(hit.sourceId);
      if (!cur || hit.score > cur.score || (hit.score === cur.score && hit.rank > cur.rank)) best.set(hit.sourceId, hit);
    }
    return [...best.values()].sort((a, b) => b.score - a.score || b.rank - a.rank).slice(0, opts.limit ?? 5).map(({ rank: _rank, ...h }) => h);
  }

  /** The answer the bot may give: only a confident match (coverage over a threshold and at least two matching words, or an exact FAQ question). */
  async answer(question: string, s: AnswerSettings, audience: 'bot' | 'staff' = 'bot', via: 'bot' | 'staff' = 'bot'): Promise<(Hit & { text: string }) | null> {
    const hits = await this.search(question, { audience, limit: 3 });
    const top = hits[0];
    const ok = !!top && top.score >= s.minScore && (top.exact || top.matched >= 2 || (top.tokens === 1 && top.score >= 0.9));
    await this.logQuery(question, via, ok, top?.score ?? null, ok ? top!.sourceId : null);
    if (!ok || !top) return null;
    await this.db.query('UPDATE kb_sources SET uses = uses + 1 WHERE id = $1', [top.sourceId]);
    const src = (await this.db.query('SELECT kind, body FROM kb_sources WHERE id = $1', [top.sourceId])).rows[0];
    // a FAQ answer is shown whole; documents give the most relevant passage
    const text = src?.kind === 'faq' && src.body ? src.body.slice(0, s.maxChars) : bestSnippet(top.snippet, queryTokens(question), s.maxChars);
    return { ...top, text };
  }

  async logQuery(text: string, via: 'bot' | 'staff' | 'test', answered: boolean, score: number | null, sourceId: string | null): Promise<void> {
    await this.db.query('INSERT INTO kb_queries (text, via, answered, score, source_id) VALUES ($1,$2,$3,$4,$5)', [text.replace(/\s+/g, ' ').trim().slice(0, 200), via, answered, score, sourceId]).catch(() => undefined);
  }

  async purgeOldQueries(days: number): Promise<number> {
    const r = await this.db.query(`DELETE FROM kb_queries WHERE created_at < now() - make_interval(days => $1)`, [days]);
    return r.rowCount ?? 0;
  }
}

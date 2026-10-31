import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import type { MediaService } from '../media/store.js';
import { matchOptionLexical } from '../flow/match.js';
import { checkUrl, FetchError, safeGet, type Fetched } from './fetch.js';
import { extract, kindFor, type DocKind } from './extract.js';
import { dot, fromBuffer, NO_EMBEDDER, toBuffer, type Embedder } from '../semantic/embedder.js';
import { bestSnippet, chunkText, indexTerms, queryTokens, variants, words } from './text.js';

export type Audience = 'bot' | 'staff' | 'both';
export interface Hit {
  sourceId: string; chunkId: number; title: string; kind: string; url: string | null; heading: string | null;
  snippet: string; score: number; matched: number; tokens: number; exact: boolean;
  /** meaning-match strength 0-1 (0 when semantic search is off) and the raw cosine behind it */
  sem: number; cos: number | null;
}
export interface AnswerSettings { minScore: number; maxChars: number }

/** Normalise a cosine similarity of the small multilingual model into 0-1 (its raw range is compressed: unrelated ~0.78-0.83). */
export const semScore = (cos: number, kind: 'q' | 'p'): number => Math.max(0, Math.min(1, (cos - (kind === 'q' ? 0.78 : 0.8)) / 0.12));

/**
 * Confident enough for the bot to answer. Keyword evidence (exact question, 2+ matching words) or strong meaning evidence
 * (semantic score over the threshold with a clear lead over the next different source).
 */
export function isConfident(top: Hit | undefined, next: Hit | undefined, minScore: number): boolean {
  if (!top || top.score < minScore) return false;
  const lexical = top.exact || top.matched >= 2 || (top.tokens === 1 && top.score >= 0.9 && top.matched >= 1);
  const semantic = top.sem >= minScore && top.sem >= (next?.sem ?? 0) + 0.04;
  return lexical || semantic;
}

const BINARY: DocKind[] = ['pdf', 'docx'];
const MAX_CHUNKS_TOTAL = 30_000;

export class KnowledgeBase {
  private chain: Promise<unknown> = Promise.resolve();
  private embedder: Embedder = NO_EMBEDDER;
  private vecs: { source: string[]; chunk: (number | null)[]; kind: ('q' | 'p')[]; vec: Float32Array[] } | null = null;
  setEmbedder(e: Embedder): void { this.embedder = e; this.vecs = null; }
  semanticStatus() { return this.embedder.status(); }
  private semReady = () => this.embedder.status().state === 'ready';
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
      await this.embedSource(id).catch(() => undefined);
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
    await this.embedSource(id).catch(() => undefined);
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

  // ---- meaning vectors ---------------------------------------------------------------------------------------------
  /** Compute and store vectors for one source (question phrases and passages). No-op until the model is ready; embedMissing() catches up later. */
  async embedSource(id: string): Promise<void> {
    if (!this.semReady()) return;
    const model = this.embedder.status().model ?? 'local';
    const src = (await this.db.query('SELECT kind, title, variants FROM kb_sources WHERE id = $1', [id])).rows[0];
    if (!src) return;
    const chunks = (await this.db.query('SELECT id, heading, body FROM kb_chunks WHERE source_id = $1 ORDER BY ord', [id])).rows;
    const qs: string[] = src.kind === 'faq' ? [src.title as string, ...(src.variants as string[])] : [];
    const ps = chunks.map((c) => `${src.title}. ${c.heading ? `${c.heading}. ` : ''}${c.body}`.slice(0, 900));
    const [qv, pv] = [qs.length ? await this.embedder.embed(qs, 'query') : [], ps.length ? await this.embedder.embed(ps, 'passage') : []];
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM kb_vectors WHERE source_id = $1', [id]);
      for (const v of qv) await client.query(`INSERT INTO kb_vectors (source_id, chunk_id, kind, model, vec) VALUES ($1, $2, 'q', $3, $4)`, [id, chunks[0]?.id ?? null, model, toBuffer(v)]);
      for (let i = 0; i < pv.length; i++) await client.query(`INSERT INTO kb_vectors (source_id, chunk_id, kind, model, vec) VALUES ($1, $2, 'p', $3, $4)`, [id, chunks[i]!.id, model, toBuffer(pv[i]!)]);
      await client.query('UPDATE kb_sources SET embedded_model = $2 WHERE id = $1', [id, model]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => undefined); throw e; } finally { client.release(); }
    this.vecs = null;
  }

  /** Embed everything that has no vectors for the current model (after enabling the feature, switching models or importing while it was loading). */
  async embedMissing(limit = 200): Promise<number> {
    if (!this.semReady()) return 0;
    const model = this.embedder.status().model ?? 'local';
    const { rows } = await this.db.query(`SELECT id FROM kb_sources WHERE status = 'ready' AND embedded_model IS DISTINCT FROM $1 LIMIT $2`, [model, limit]);
    for (const r of rows) await this.embedSource(r.id as string).catch(() => undefined);
    return rows.length;
  }

  private async loadVectors() {
    if (this.vecs) return this.vecs;
    const model = this.embedder.status().model ?? 'local';
    const { rows } = await this.db.query('SELECT source_id, chunk_id, kind, vec FROM kb_vectors WHERE model = $1', [model]);
    this.vecs = { source: rows.map((r) => r.source_id as string), chunk: rows.map((r) => (r.chunk_id === null ? null : Number(r.chunk_id))), kind: rows.map((r) => r.kind as 'q' | 'p'), vec: rows.map((r) => fromBuffer(r.vec as Buffer)) };
    return this.vecs;
  }

  /** Meaning matches for a question: best question-phrase and passage similarity per source. */
  private async semanticCandidates(question: string): Promise<Map<string, { q: number; p: number; chunkId: number | null }>> {
    const out = new Map<string, { q: number; p: number; chunkId: number | null }>();
    if (!this.semReady()) return out;
    const v = await this.loadVectors();
    if (!v.vec.length) return out;
    const [qv] = await this.embedder.embed([question.slice(0, 500)], 'query');
    for (let i = 0; i < v.vec.length; i++) {
      const cos = dot(qv!, v.vec[i]!);
      const cur = out.get(v.source[i]!) ?? { q: 0, p: 0, chunkId: null };
      if (v.kind[i] === 'q') cur.q = Math.max(cur.q, cos);
      else if (cos > cur.p) { cur.p = cos; cur.chunkId = v.chunk[i]!; }
      if (cur.chunkId === null && v.kind[i] === 'q') cur.chunkId = v.chunk[i]!;
      out.set(v.source[i]!, cur);
    }
    return out;
  }

  // ---- menu intent -------------------------------------------------------------------------------------------------
  private phraseCache = new Map<string, Float32Array>();
  /** Which option does the customer's free text mean (by meaning)? Needs the local model; a clear winner (>= 0.86 and ahead of the runner-up) or null. */
  async matchOption(text: string, options: { label: string; examples: string[] }[]): Promise<number | null> {
    const lexical = matchOptionLexical(text, options);
    if (lexical !== null) return lexical;
    if (!this.semReady()) return null;
    const phrases = options.flatMap((o, i) => [o.label, ...o.examples].map((p) => ({ i, p })));
    const missing = [...new Set(phrases.map((x) => x.p).filter((p) => !this.phraseCache.has(p)))];
    if (missing.length) {
      const vs = await this.embedder.embed(missing, 'query');
      missing.forEach((p, k) => this.phraseCache.set(p, vs[k]!));
      if (this.phraseCache.size > 2000) this.phraseCache.clear();
    }
    const [q] = await this.embedder.embed([text.slice(0, 300)], 'query');
    const per = new Map<number, number>();
    for (const { i, p } of phrases) per.set(i, Math.max(per.get(i) ?? 0, dot(q!, this.phraseCache.get(p) ?? new Float32Array(q!.length))));
    const ranked = [...per.entries()].sort((a, b) => b[1] - a[1]);
    const [best, second] = [ranked[0], ranked[1]];
    return best && best[1] >= 0.86 && best[1] - (second?.[1] ?? 0) >= 0.02 ? best[0] : null;
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
    const sem = await this.semanticCandidates(question).catch(() => new Map<string, { q: number; p: number; chunkId: number | null }>());
    if (tokens.length === 0 && sem.size === 0) return [];
    const groups = await this.synonymGroups();
    const alts: Set<string>[] = tokens.map((t) => {
      const set = new Set(variants(t));
      for (const g of groups) if (g.some((w) => variants(w).some((v) => set.has(v)))) for (const w of g) for (const v of variants(w)) set.add(v);
      return set;
    });
    const terms = [...new Set(alts.flatMap((s) => [...s]))].filter((x) => /^[\p{L}\p{N}]+$/u.test(x)).slice(0, 80);
    const { rows } = terms.length === 0 ? { rows: [] as Record<string, unknown>[] } : await this.db.query(
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
        snippet: r.body as string, score: Math.round(score * 100) / 100, matched, tokens: tokens.length, exact, sem: 0, cos: null as number | null, rank: Number(r.rank) };
      const cur = best.get(hit.sourceId);
      if (!cur || hit.score > cur.score || (hit.score === cur.score && hit.rank > cur.rank)) best.set(hit.sourceId, hit);
    }
    // meaning matches: raise the score of keyword hits and add sources the keywords missed
    const semIds = [...sem.entries()].map(([id, c]) => ({ id, c, ss: Math.max(semScore(c.q, 'q'), semScore(c.p, 'p')) })).filter((x) => x.ss > 0.15).sort((a, b) => b.ss - a.ss).slice(0, 12);
    if (semIds.length) {
      const meta = new Map((await this.db.query(
        `SELECT s.id, s.title, s.kind, s.url, s.boost FROM kb_sources s WHERE s.id = ANY($1::uuid[]) AND s.enabled AND s.status = 'ready'
            AND ($2::text = 'any' OR s.audience IN ('both', $2)) AND ($3::uuid IS NULL OR s.category_id = $3)`,
        [semIds.map((x) => x.id), opts.audience, opts.categoryId ?? null])).rows.map((r) => [r.id as string, r]));
      for (const { id, c, ss } of semIds) {
        const m = meta.get(id);
        if (!m) continue;
        const cos = Math.max(c.q, c.p);
        const cur = best.get(id);
        if (cur) {
          cur.sem = Math.round(ss * 100) / 100; cur.cos = Math.round(cos * 1000) / 1000;
          cur.score = Math.min(1, Math.round((Math.max(cur.score, ss) + 0.1 * Math.min(cur.score, ss)) * 100) / 100);
        } else {
          const ch = c.chunkId === null ? null : (await this.db.query('SELECT id, heading, body FROM kb_chunks WHERE id = $1', [c.chunkId])).rows[0];
          if (!ch) continue;
          best.set(id, { sourceId: id, chunkId: Number(ch.id), title: m.title as string, kind: m.kind as string, url: m.url as string | null, heading: ch.heading as string | null, snippet: ch.body as string,
            score: Math.round(Math.min(0.97, ss + (m.boost as number) * 0.04) * 100) / 100, matched: 0, tokens: tokens.length, exact: false, sem: Math.round(ss * 100) / 100, cos: Math.round(cos * 1000) / 1000, rank: 0 });
        }
      }
    }
    return [...best.values()].sort((a, b) => b.score - a.score || b.rank - a.rank).slice(0, opts.limit ?? 5).map(({ rank: _rank, ...h }) => h);
  }

  /** The answer the bot may give: only a confident match (coverage over a threshold and at least two matching words, or an exact FAQ question). */
  async answer(question: string, s: AnswerSettings, audience: 'bot' | 'staff' = 'bot', via: 'bot' | 'staff' | 'test' = 'bot'): Promise<(Hit & { text: string }) | null> {
    const hits = await this.search(question, { audience, limit: 3 });
    const top = hits[0];
    const ok = isConfident(top, hits[1], s.minScore);
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

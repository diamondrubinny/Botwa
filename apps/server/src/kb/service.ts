import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import type { MediaService } from '../media/store.js';
import { matchOptionLexical } from '../flow/match.js';
import { checkUrl, FetchError, safeGet, type Fetched } from './fetch.js';
import { extract, kindFor, type DocKind, type HtmlOpts } from './extract.js';
import type { Renderer, RendererStatus } from './browser.js';
import { canonicalOf, crawlCfgSchema, DEFAULT_CRAWL, inScope, isSoft404, looksClientRendered, MIN_PAGE_CHARS, normalizeUrl, parseRobots, parseSitemap, prefixOf, robotsAllows, type CrawlCfg, type CrawlReport, type Robots, type Scope } from './crawler.js';
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

export type Fetcher = (url: string, o?: { allow?: RegExp; accept?: string; maxBytes?: number }) => Promise<Fetched>;
const BINARY: DocKind[] = ['pdf', 'docx', 'xlsx'];
const MAX_CHUNKS_TOTAL = 30_000;

export class KnowledgeBase {
  private chain: Promise<unknown> = Promise.resolve();
  private embedder: Embedder = NO_EMBEDDER;
  private vecs: { source: string[]; chunk: (number | null)[]; kind: ('q' | 'p')[]; vec: Float32Array[] } | null = null;
  setEmbedder(e: Embedder): void { this.embedder = e; this.vecs = null; }
  semanticStatus() { return this.embedder.status(); }
  private semReady = () => this.embedder.status().state === 'ready';
  private fetcher: Fetcher = safeGet;
  /** Tests replace the network layer. */
  setFetcher(f: Fetcher): void { this.fetcher = f; }
  private renderer: Renderer | null = null;
  setRenderer(r: Renderer | null): void { this.renderer = r; }
  async closeRenderer(): Promise<void> { await this.renderer?.close?.(); }
  async rendererStatus(): Promise<RendererStatus> { return this.renderer ? this.renderer.status() : { mode: 'off', state: 'off' }; }
  /**
   * Fetch a page for reading. Plain fetch first; when the page looks like an empty shell built by scripts (or the source asks for it),
   * the headless browser renders it. If the browser is missing or fails, the plain page is used as before.
   */
  private async getPage(url: string, mode: CrawlCfg['render']): Promise<Fetched & { rendered: boolean }> {
    if (mode === 'never' || !this.renderer) return { ...(await this.fetcher(url)), rendered: false };
    if (mode === 'always') { try { return { ...(await this.renderer.render(url)), rendered: true }; } catch (e) { if ((e as Error).message === 'blocked_address') throw e; return { ...(await this.fetcher(url)), rendered: false }; } }
    const f = await this.fetcher(url);
    if (kindFor(f.url, f.contentType) !== 'html' || !looksClientRendered(f.body.toString('utf8', 0, 600_000))) return { ...f, rendered: false };
    try { return { ...(await this.renderer.render(url)), rendered: true }; } catch { return { ...f, rendered: false }; }
  }
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

  /** Antivirus check for an uploaded binary file (fail closed): 'clean' | 'infected' | 'unavailable'. */
  async scanBinary(buf: Buffer): Promise<'clean' | 'infected' | 'unavailable'> {
    const r = await this.media.scanBuffer(buf);
    return r.status === 'clean' ? 'clean' : r.status === 'infected' ? 'infected' : 'unavailable';
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

  /**
   * Index uploaded or fetched document bytes for a source (replacing earlier content). Returns false when content is unchanged.
   * `opts.html`: selectors for a web page's main content; `opts.minChars`: refuse near-empty pages ("thin_content") and error pages that
   * answer 200 ("soft_404"); `opts.storeLinks`: remember the links of the page (so a crawl can go on from pages that did not change).
   */
  async indexDocument(id: string, kind: DocKind, data: Buffer, nameForTitle: string, opts: { html?: HtmlOpts; minChars?: number; storeLinks?: boolean; hashText?: boolean } = {}): Promise<boolean> {
    let hash = createHash('sha256').update(data).update(kind === 'html' ? JSON.stringify(opts.html ?? {}) : '').digest('hex');
    const cur = (await this.db.query('SELECT content_hash, title, (SELECT count(*)::int FROM kb_chunks WHERE source_id = $1) AS chunks FROM kb_sources WHERE id = $1', [id])).rows[0];
    if (!cur) return false;
    let ex: Awaited<ReturnType<typeof extract>> | null = null;
    // a page rendered by a browser differs in every byte read (ids, times): what matters is whether its text changed
    if (kind === 'html' && opts.hashText) { ex = await extract(kind, data, 30_000, opts.html); hash = createHash('sha256').update(ex.text).update(JSON.stringify(opts.html ?? {})).digest('hex'); }
    if (cur.content_hash === hash && cur.chunks > 0) {   // nothing changed: keep the version
      if (ex && opts.storeLinks) await this.db.query(`UPDATE kb_sources SET meta = meta || jsonb_build_object('links', $2::jsonb) WHERE id = $1`, [id, JSON.stringify(ex.links.slice(0, 400))]);
      await this.setReady(id, {}); return false;
    }
    if (BINARY.includes(kind)) {
      const scan = await this.media.scanBuffer(data);
      if (scan.status === 'infected') throw new Error('infected');
      if (scan.status !== 'clean') throw new Error('scan_unavailable'); // fail closed, like attachments
    }
    ex ??= await extract(kind, data, 30_000, opts.html);
    if (kind === 'html' && opts.storeLinks) await this.db.query(`UPDATE kb_sources SET meta = meta || jsonb_build_object('links', $2::jsonb) WHERE id = $1`, [id, JSON.stringify(ex.links.slice(0, 400))]);
    if (!ex.text.trim()) throw new Error('empty_content');
    if (opts.minChars !== undefined && kind === 'html') {
      if (isSoft404(ex.title, ex.text)) throw new Error('soft_404');
      if (ex.text.length < opts.minChars) throw new Error('thin_content');
    }
    const title = cur.title && cur.title !== nameForTitle ? cur.title : (ex.title ?? nameForTitle).slice(0, 300);
    const n = await this.replaceChunks(id, title, [], ex.text);
    if (n === 0) throw new Error('empty_content');
    await this.db.query('UPDATE kb_sources SET version = version + 1 WHERE id = $1', [id]);
    await this.setReady(id, { title, hash });
    await this.embedSource(id).catch(() => undefined);
    return true;
  }

  /** Links stored for a page by an earlier read. */
  private async linksOf(id: string): Promise<string[]> {
    const v = (await this.db.query(`SELECT meta->'links' AS l FROM kb_sources WHERE id = $1`, [id])).rows[0]?.l as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  }

  private async crawlCfgOf(id: string): Promise<CrawlCfg> {
    const raw = (await this.db.query('SELECT crawl_cfg FROM kb_sources WHERE id = $1', [id])).rows[0]?.crawl_cfg;
    const p = crawlCfgSchema.safeParse(raw ?? {});
    return p.success ? p.data : DEFAULT_CRAWL;
  }
  private htmlOpts = (c: CrawlCfg): HtmlOpts => ({ select: c.selector || undefined, remove: c.remove.length ? c.remove : undefined });

  /** Fetch + index one link source; optionally crawl the site pages it links to. */
  private async process(id: string): Promise<void> {
    const { rows } = await this.db.query('SELECT id, kind, url, title, crawl_pages, parent_id FROM kb_sources WHERE id = $1', [id]);
    const s = rows[0];
    if (!s || s.kind !== 'link' || !s.url) return;
    try {
      const cfg = await this.crawlCfgOf(id);
      const f = await this.getPage(s.url, cfg.render);
      const kind = kindFor(f.url, f.contentType);
      if (!kind) throw new FetchError('unsupported_content_type');
      await this.indexDocument(id, kind, f.body, s.title, { html: this.htmlOpts(cfg), storeLinks: s.crawl_pages > 0, hashText: f.rendered });
      if (s.crawl_pages > 0 && !s.parent_id && kind === 'html') await this.crawl(id, f.url, s.crawl_pages, cfg);
    } catch (e) {
      await this.setError(id, e instanceof Error ? e.message : 'failed');
    }
  }

  private async readRobots(origin: string): Promise<Robots> {
    try { const f = await this.fetcher(`${origin}/robots.txt`, { allow: /^text\//i, accept: 'text/plain', maxBytes: 200_000 }); if (!/^text\/plain/i.test(f.contentType)) throw new Error('not_robots'); return parseRobots(f.body.toString('utf8')); } catch { return { allow: [], disallow: [], crawlDelay: null, sitemaps: [] }; }
  }
  /** Addresses from the sitemaps the site declares (robots.txt) or the default /sitemap.xml: at most five files, one index level deep. */
  private async readSitemaps(origin: string, declared: string[]): Promise<string[]> {
    const out: string[] = [];
    const todo = [...new Set([...declared, `${origin}/sitemap.xml`])].slice(0, 5);
    let files = 0;
    while (todo.length && files < 5) {
      const u = todo.shift()!;
      files++;
      try {
        const r = parseSitemap((await this.fetcher(u, { allow: /^(text|application)\/(xml|plain|x-xml)/i, accept: 'application/xml,text/xml', maxBytes: 3_000_000 })).body.toString('utf8'));
        out.push(...r.urls);
        for (const m of r.sitemaps) if (todo.length + files < 5) todo.push(m);
      } catch { /* a sitemap that is missing or unreadable is simply not used */ }
    }
    return out;
  }

  private async crawl(parentId: string, startUrl: string, limit: number, cfg: CrawlCfg): Promise<void> {
    const start = normalizeUrl(startUrl) ?? startUrl;
    const origin = new URL(start).origin;
    const scope: Scope = { origin, prefix: cfg.stayInPath ? prefixOf(start) : null, include: cfg.include, exclude: cfg.exclude, files: cfg.files };
    const rep: CrawlReport = { at: new Date().toISOString(), discovered: 0, indexed: 0, unchanged: 0, failed: 0, robots: 0, filtered: 0, duplicates: 0, thin: 0, gone: 0, limited: false, sitemap: 0, boilerplate: 0, rendered: 0 };
    const robots = await this.readRobots(origin);
    const delay = this.cfg.NODE_ENV === 'test' ? 0 : Math.min(5000, Math.max(400, (robots.crawlDelay ?? 0) * 1000)); // be polite to the site
    const seen = new Set<string>([start]);
    const queue: { url: string; depth: number }[] = [];
    const enqueue = (raw: string, base: string, depth: number): boolean => {
      const n = normalizeUrl(raw, base);
      if (!n || seen.has(n)) return false;
      seen.add(n);
      if (inScope(n, scope) === 'filtered') { rep.filtered++; return false; }
      const u = new URL(n);
      if (!robotsAllows(robots, u.pathname + u.search)) { rep.robots++; return false; }
      queue.push({ url: n, depth }); rep.discovered++;
      return true;
    };
    for (const h of await this.linksOf(parentId)) enqueue(h, start, 1);
    if (cfg.sitemap) for (const u of await this.readSitemaps(origin, robots.sitemaps)) if (enqueue(u, start, 1)) rep.sitemap++;

    const meta = (await this.db.query('SELECT category_id, audience, boost, created_by FROM kb_sources WHERE id = $1', [parentId])).rows[0];
    const touched = new Set<string>();
    const deadline = Date.now() + 15 * 60_000;
    let processed = 0;
    while (queue.length && processed < limit && Date.now() < deadline) {
      const { url, depth } = queue.shift()!;
      processed++;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      const ins = await this.db.query(
        `INSERT INTO kb_sources (kind, title, url, category_id, audience, boost, parent_id, created_by) VALUES ('link', $1, $1, $2, $3, $4, $5, $6)
         ON CONFLICT (url) WHERE kind = 'link' DO NOTHING RETURNING id`,
        [url, meta.category_id, meta.audience, meta.boost, parentId, meta.created_by],
      );
      const childId = (ins.rows[0]?.id ?? (await this.db.query(`SELECT id FROM kb_sources WHERE kind = 'link' AND url = $1 AND parent_id = $2`, [url, parentId])).rows[0]?.id) as string | undefined;
      if (!childId) continue; // already exists as an independent source
      touched.add(childId);
      try {
        const f = await this.getPage(url, cfg.render);
        if (f.rendered) rep.rendered++;
        const kind = kindFor(f.url, f.contentType);
        if (!kind) throw new FetchError('unsupported_content_type');
        if (kind === 'html') {
          // the page may say its real address is another one: read that one instead and do not keep two copies
          const finalUrl = normalizeUrl(f.url) ?? f.url;
          const canon = canonicalOf(f.body.toString('utf8', 0, 200_000), f.url);
          const real = canon && canon !== finalUrl && inScope(canon, scope) === 'ok' ? canon : finalUrl !== url ? finalUrl : null;
          if (real && real !== url) {
            await this.db.query('DELETE FROM kb_sources WHERE id = $1', [childId]); touched.delete(childId);
            rep.duplicates++;
            if (!seen.has(real)) { seen.add(real); if (inScope(real, scope) === 'ok') { queue.unshift({ url: real, depth }); rep.discovered++; processed--; } }
            continue;
          }
        }
        let changed: boolean;
        try {
          changed = await this.indexDocument(childId, kind, f.body, url, { html: this.htmlOpts(cfg), minChars: this.cfg.NODE_ENV === 'test' ? 50 : MIN_PAGE_CHARS, storeLinks: true, hashText: f.rendered });
        } catch (e) {
          const code = (e as Error).message;
          if (code === 'thin_content' || code === 'soft_404' || code === 'empty_content') {
            // an index page with little text is still followed; it just is not kept as an answer source
            if (kind === 'html' && depth < cfg.depth) for (const h of await this.linksOf(childId)) enqueue(h, f.url, depth + 1);
            await this.db.query('DELETE FROM kb_sources WHERE id = $1', [childId]); touched.delete(childId);
            rep.thin++;
            continue;
          }
          throw e;
        }
        if (changed) rep.indexed++; else rep.unchanged++;
        if (kind === 'html' && depth < cfg.depth) for (const h of await this.linksOf(childId)) enqueue(h, f.url, depth + 1);
      } catch (e) { rep.failed++; await this.setError(childId, e instanceof Error ? e.message : 'failed'); }
    }
    rep.limited = queue.length > 0;
    if (!rep.limited) {
      // pages of earlier crawls that are no longer reachable under these options are switched off, not silently kept answering
      const gone = await this.db.query(`UPDATE kb_sources SET enabled = false, status = 'error', error = 'gone' WHERE parent_id = $1 AND NOT (id = ANY($2::uuid[])) AND enabled RETURNING id`, [parentId, [...touched]]);
      rep.gone = gone.rowCount ?? 0;
    }
    const shared = await this.pruneShared(parentId);
    rep.boilerplate = shared.chunks; rep.thin += shared.pages;
    await this.db.query('UPDATE kb_sources SET crawl_report = $2 WHERE id = $1', [parentId, JSON.stringify(rep)]);
  }

  /**
   * Text that repeats on many pages of one crawl (a menu or footer built from ordinary elements, which no tag rule can tell from content)
   * would match every question and bury the real answers. Chunks whose text is identical on at least 30% of the pages (and 3+) are removed;
   * pages left with nothing of their own are dropped.
   */
  private async pruneShared(parentId: string): Promise<{ chunks: number; pages: number }> {
    const ids = (await this.db.query('SELECT id FROM kb_sources WHERE id = $1 OR parent_id = $1', [parentId])).rows.map((r) => r.id as string);
    if (ids.length < 4) return { chunks: 0, pages: 0 };
    const min = Math.max(3, Math.ceil(ids.length * 0.3));
    const hashes = (await this.db.query(`SELECT md5(body) AS h FROM kb_chunks WHERE source_id = ANY($1::uuid[]) GROUP BY md5(body) HAVING count(DISTINCT source_id) >= $2`, [ids, min])).rows.map((r) => r.h as string);
    if (!hashes.length) return { chunks: 0, pages: 0 };
    const del = await this.db.query(`DELETE FROM kb_chunks WHERE source_id = ANY($1::uuid[]) AND md5(body) = ANY($2::text[]) RETURNING id`, [ids, hashes]);
    await this.db.query('DELETE FROM kb_vectors WHERE chunk_id = ANY($1::bigint[])', [del.rows.map((r) => r.id)]);
    const empty = await this.db.query(`DELETE FROM kb_sources s WHERE s.parent_id = $1 AND NOT EXISTS (SELECT 1 FROM kb_chunks c WHERE c.source_id = s.id) RETURNING id`, [parentId]);
    this.vecs = null;
    return { chunks: del.rowCount ?? 0, pages: empty.rowCount ?? 0 };
  }

  /**
   * Dry run of a scrape for one address: what would be read, how the main text comes out with the given selectors, which links would be
   * followed and which refused (and why). Nothing is stored.
   */
  async previewScrape(rawUrl: string, cfg: CrawlCfg): Promise<{
    url: string; rendered: boolean; title: string | null; canonical: string | null; robotsAllowed: boolean; chars: number; thin: boolean; soft404: boolean;
    headings: string[]; excerpt: string; links: { total: number; accepted: string[]; filtered: number; robots: number; duplicates: number }; sitemap: { found: boolean; urls: number; sample: string[] };
  }> {
    const f = await this.getPage(KnowledgeBase.validateUrl(rawUrl), cfg.render);
    const kind = kindFor(f.url, f.contentType);
    if (!kind) throw new FetchError('unsupported_content_type');
    const final = normalizeUrl(f.url) ?? f.url;
    const origin = new URL(final).origin;
    const robots = await this.readRobots(origin);
    const ex = await extract(kind, f.body, 30_000, kind === 'html' ? this.htmlOpts(cfg) : undefined);
    const scope: Scope = { origin, prefix: cfg.stayInPath ? prefixOf(final) : null, include: cfg.include, exclude: cfg.exclude, files: cfg.files };
    const seen = new Set<string>([final]);
    const accepted: string[] = [];
    let filtered = 0, robotsN = 0, dup = 0;
    for (const h of ex.links) {
      const n = normalizeUrl(h, f.url);
      if (!n) continue;
      if (seen.has(n)) { dup++; continue; }
      seen.add(n);
      if (inScope(n, scope) === 'filtered') { filtered++; continue; }
      const u = new URL(n);
      if (!robotsAllows(robots, u.pathname + u.search)) { robotsN++; continue; }
      accepted.push(n);
    }
    let sm = { found: false, urls: 0, sample: [] as string[] };
    if (cfg.sitemap) { const urls = await this.readSitemaps(origin, robots.sitemaps); sm = { found: urls.length > 0, urls: urls.length, sample: urls.slice(0, 5) }; }
    const u = new URL(final);
    return {
      url: final, rendered: f.rendered, title: ex.title, canonical: kind === 'html' ? canonicalOf(f.body.toString('utf8', 0, 200_000), f.url) : null,
      robotsAllowed: robotsAllows(robots, u.pathname + u.search), chars: ex.text.length, thin: ex.text.length < MIN_PAGE_CHARS, soft404: isSoft404(ex.title, ex.text),
      headings: [...ex.text.matchAll(/^(#{1,4})\s+(.+)$/gm)].slice(0, 30).map((m) => `${'  '.repeat(m[1]!.length - 1)}${m[2]}`),
      excerpt: ex.text.slice(0, 2500), links: { total: ex.links.length, accepted: accepted.slice(0, 40), filtered, robots: robotsN, duplicates: dup }, sitemap: sm,
    };
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
          AND ($3::uuid IS NULL OR s.category_id = $3 OR EXISTS (SELECT 1 FROM kb_source_cats x WHERE x.source_id = s.id AND x.category_id = $3))
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
            AND ($2::text = 'any' OR s.audience IN ('both', $2)) AND ($3::uuid IS NULL OR s.category_id = $3 OR EXISTS (SELECT 1 FROM kb_source_cats x WHERE x.source_id = s.id AND x.category_id = $3))`,
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

  /** The formatted passage of one chosen source for a question (used when the customer picks a "did you mean" suggestion). */
  async answerFor(sourceId: string, question: string, s: AnswerSettings): Promise<(Hit & { text: string }) | null> {
    const hits = await this.search(question, { audience: 'bot', limit: 8 });
    const hit = hits.find((h) => h.sourceId === sourceId);
    if (!hit) return null;
    await this.db.query('UPDATE kb_sources SET uses = uses + 1 WHERE id = $1', [sourceId]);
    const src = (await this.db.query('SELECT kind, body FROM kb_sources WHERE id = $1', [sourceId])).rows[0];
    const text = src?.kind === 'faq' && src.body ? src.body.slice(0, s.maxChars) : bestSnippet(hit.snippet, queryTokens(question), s.maxChars);
    return { ...hit, text };
  }

  async logQuery(text: string, via: 'bot' | 'staff' | 'test', answered: boolean, score: number | null, sourceId: string | null): Promise<void> {
    await this.db.query('INSERT INTO kb_queries (text, via, answered, score, source_id) VALUES ($1,$2,$3,$4,$5)', [text.replace(/\s+/g, ' ').trim().slice(0, 200), via, answered, score, sourceId]).catch(() => undefined);
  }

  async purgeOldQueries(days: number): Promise<number> {
    const r = await this.db.query(`DELETE FROM kb_queries WHERE created_at < now() - make_interval(days => $1)`, [days]);
    return r.rowCount ?? 0;
  }
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { loadAccessible } from '../access.js';
import { audit } from '../audit.js';
import { requireAuth } from '../auth.js';
import { loadBot } from '../bot.js';
import type { Db } from '../db.js';
import { kindFor } from '../kb/extract.js';
import { FetchError } from '../kb/fetch.js';
import { isConfident, KnowledgeBase } from '../kb/service.js';
import { sanitizeFileName } from '../media/validate.js';
import { categorizeSource } from '../safety/importer.js';

const idParam = z.object({ id: z.string().uuid() });
const audience = z.enum(['bot', 'staff', 'both']);
const common = { categoryId: z.string().uuid().nullable().optional(), audience: audience.default('both'), boost: z.number().int().min(0).max(2).default(0) };
const SELECT = `s.id, s.kind, s.title, s.variants, s.url, s.file_name AS "fileName", s.category_id AS "categoryId", s.audience, s.boost, s.enabled, s.status, s.error,
  s.refresh_hours AS "refreshHours", s.crawl_pages AS "crawlPages", s.last_fetched_at AS "lastFetchedAt", s.parent_id AS "parentId", s.version,
  s.uses, s.helpful, s.unhelpful, s.updated_at AS "updatedAt", (SELECT count(*)::int FROM kb_chunks c WHERE c.source_id = s.id) AS chunks`;

export function kbRoutes(app: FastifyInstance, db: Db, kb: KnowledgeBase) {
  const manage = requireAuth(db, 'kb.manage');
  const any = requireAuth(db);
  const limit = { rateLimit: { max: 30, timeWindow: '1 minute' } };

  // Meaning-search status: model state and how many sources already have vectors.
  app.get('/kb/semantic', { preHandler: manage }, async () => {
    const c = (await db.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE embedded_model IS NOT NULL)::int AS embedded FROM kb_sources WHERE status = 'ready'`)).rows[0];
    return { ...kb.semanticStatus(), ...c };
  });

  app.get('/kb/sources', { preHandler: manage }, async () => (await db.query(`SELECT ${SELECT} FROM kb_sources s ORDER BY s.parent_id NULLS FIRST, s.created_at DESC LIMIT 1000`)).rows);

  app.get('/kb/sources/:id', { preHandler: manage }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const s = (await db.query(`SELECT ${SELECT}, s.body FROM kb_sources s WHERE s.id = $1`, [p.data.id])).rows[0];
    if (!s) return reply.code(404).send({ error: 'not_found' });
    const chunks = (await db.query('SELECT id, ord, heading, left(body, 600) AS body FROM kb_chunks WHERE source_id = $1 ORDER BY ord LIMIT 200', [p.data.id])).rows;
    return { ...s, preview: chunks };
  });

  // Written answers (question + answer): the most reliable source, an exact match is answered verbatim.
  app.post('/kb/sources/faq', { preHandler: manage, config: limit }, async (req, reply) => {
    const b = z.object({ title: z.string().trim().min(2).max(300), variants: z.array(z.string().trim().min(2).max(300)).max(20).default([]), body: z.string().trim().min(2).max(6000), ...common }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const { rows } = await db.query(
      `INSERT INTO kb_sources (kind, title, variants, body, category_id, audience, boost, created_by) VALUES ('faq',$1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [b.data.title, b.data.variants, b.data.body, b.data.categoryId ?? null, b.data.audience, b.data.boost, req.user!.id],
    );
    await kb.indexWritten(rows[0].id).catch(() => undefined);
    await audit(db, { actorId: req.user!.id, action: 'kb.create', target: rows[0].id, ip: req.ip, meta: { kind: 'faq' } });
    return reply.code(201).send({ id: rows[0].id });
  });

  // Pasted text / article.
  app.post('/kb/sources/text', { preHandler: manage, config: limit }, async (req, reply) => {
    const b = z.object({ title: z.string().trim().min(2).max(300), body: z.string().trim().min(10).max(200_000), ...common }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const { rows } = await db.query(
      `INSERT INTO kb_sources (kind, title, body, category_id, audience, boost, created_by) VALUES ('text',$1,$2,$3,$4,$5,$6) RETURNING id`,
      [b.data.title, b.data.body, b.data.categoryId ?? null, b.data.audience, b.data.boost, req.user!.id],
    );
    await kb.indexWritten(rows[0].id).catch(() => undefined);
    await audit(db, { actorId: req.user!.id, action: 'kb.create', target: rows[0].id, ip: req.ip, meta: { kind: 'text' } });
    return reply.code(201).send({ id: rows[0].id });
  });

  // A web page (optionally with the pages it links to on the same site); re-read automatically if refreshHours is set.
  app.post('/kb/sources/link', { preHandler: manage, config: limit }, async (req, reply) => {
    const b = z.object({ url: z.string().trim().max(1000), crawlPages: z.number().int().min(0).max(25).default(0), refreshHours: z.number().int().min(1).max(8760).nullable().default(null), ...common }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    let url: string;
    try { url = KnowledgeBase.validateUrl(b.data.url); } catch (e) { return reply.code(400).send({ error: e instanceof FetchError ? e.message : 'bad_url' }); }
    const dup = await db.query(`SELECT id FROM kb_sources WHERE kind = 'link' AND url = $1`, [url]);
    if (dup.rowCount) return reply.code(409).send({ error: 'already_exists', id: dup.rows[0].id });
    const { rows } = await db.query(
      `INSERT INTO kb_sources (kind, title, url, category_id, audience, boost, crawl_pages, refresh_hours, created_by) VALUES ('link',$1,$1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [url, b.data.categoryId ?? null, b.data.audience, b.data.boost, b.data.crawlPages, b.data.refreshHours, req.user!.id],
    );
    kb.enqueue(rows[0].id);
    await audit(db, { actorId: req.user!.id, action: 'kb.create', target: rows[0].id, ip: req.ip, meta: { kind: 'link', host: new URL(url).host } });
    return reply.code(202).send({ id: rows[0].id });
  });

  // Documents: txt, md, csv, html, pdf, docx. Binary formats are scanned by ClamAV (fail closed) and parsed in an isolated worker.
  app.post('/kb/sources/file', { preHandler: manage, config: limit }, async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'bad_request' });
    const fields = z.object({ title: z.string().trim().max(300).optional(), categoryId: z.string().uuid().optional(), audience: audience.default('both'), boost: z.coerce.number().int().min(0).max(2).default(0) })
      .safeParse(Object.fromEntries(Object.entries(file.fields).map(([k, v]) => [k, (v as { value?: unknown } | undefined)?.value]).filter(([, v]) => v !== '' && v !== undefined)));
    if (!fields.success) return reply.code(400).send({ error: 'bad_request' });
    const name = sanitizeFileName(file.filename, 'document');
    const kind = kindFor(name, file.mimetype);
    if (!kind) return reply.code(415).send({ error: 'unsupported_file_type' });
    let buf: Buffer;
    try { buf = await file.toBuffer(); } catch { return reply.code(413).send({ error: 'too_large' }); }
    if (file.file.truncated) return reply.code(413).send({ error: 'too_large' });
    const { rows } = await db.query(
      `INSERT INTO kb_sources (kind, title, file_name, mime, size, category_id, audience, boost, created_by) VALUES ('file',$1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [(fields.data.title || name).slice(0, 300), name, file.mimetype.slice(0, 100), buf.length, fields.data.categoryId ?? null, fields.data.audience, fields.data.boost, req.user!.id],
    );
    try {
      await kb.indexDocument(rows[0].id, kind, buf, fields.data.title || name);
    } catch (e) {
      const code = (e as Error).message;
      await db.query(`UPDATE kb_sources SET status = 'error', error = $2 WHERE id = $1`, [rows[0].id, code.slice(0, 120)]);
      await audit(db, { actorId: req.user!.id, action: 'kb.file_rejected', target: rows[0].id, ip: req.ip, meta: { reason: code } });
      return reply.code(422).send({ error: code === 'infected' ? 'file_infected' : code === 'scan_unavailable' ? 'scan_unavailable' : 'extract_failed', id: rows[0].id });
    }
    await categorizeSource(db, rows[0].id).catch(() => undefined); // puts the document under the safety topics its text is about
    await audit(db, { actorId: req.user!.id, action: 'kb.create', target: rows[0].id, ip: req.ip, meta: { kind: 'file', type: kind } });
    return reply.code(201).send({ id: rows[0].id });
  });

  app.patch('/kb/sources/:id', { preHandler: manage }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = z.object({
      title: z.string().trim().min(1).max(300).optional(), variants: z.array(z.string().trim().min(2).max(300)).max(20).optional(), body: z.string().trim().min(2).max(200_000).optional(),
      enabled: z.boolean().optional(), audience: audience.optional(), boost: z.number().int().min(0).max(2).optional(), categoryId: z.string().uuid().nullable().optional(),
      refreshHours: z.number().int().min(1).max(8760).nullable().optional(), crawlPages: z.number().int().min(0).max(25).optional(),
    }).safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    const cur = (await db.query('SELECT kind FROM kb_sources WHERE id = $1', [p.data.id])).rows[0];
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    const d = b.data;
    if ((d.body !== undefined || d.variants !== undefined) && !['faq', 'text'].includes(cur.kind)) return reply.code(400).send({ error: 'bad_request' });
    await db.query(
      `UPDATE kb_sources SET title = COALESCE($2, title), variants = COALESCE($3, variants), body = COALESCE($4, body), enabled = COALESCE($5, enabled), audience = COALESCE($6, audience),
              boost = COALESCE($7, boost), category_id = CASE WHEN $8::boolean THEN $9::uuid ELSE category_id END, refresh_hours = CASE WHEN $10::boolean THEN $11::int ELSE refresh_hours END,
              crawl_pages = COALESCE($12, crawl_pages), updated_at = now() WHERE id = $1`,
      [p.data.id, d.title ?? null, d.variants ?? null, d.body ?? null, d.enabled ?? null, d.audience ?? null, d.boost ?? null,
       d.categoryId !== undefined, d.categoryId ?? null, d.refreshHours !== undefined, d.refreshHours ?? null, d.crawlPages ?? null],
    );
    // faq/text content feeds the search index; for documents and links the title is only a label
    if ((d.title !== undefined || d.variants !== undefined || d.body !== undefined) && ['faq', 'text'].includes(cur.kind)) await kb.indexWritten(p.data.id).catch(() => undefined);
    // children of a crawled link inherit audience / enabled / boost / category from the parent
    await db.query(`UPDATE kb_sources c SET enabled = p.enabled, audience = p.audience, boost = p.boost, category_id = p.category_id FROM kb_sources p WHERE c.parent_id = p.id AND p.id = $1`, [p.data.id]);
    await audit(db, { actorId: req.user!.id, action: 'kb.update', target: p.data.id, ip: req.ip });
    return { ok: true };
  });

  app.post('/kb/sources/:id/reindex', { preHandler: manage, config: limit }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const s = (await db.query('SELECT kind FROM kb_sources WHERE id = $1', [p.data.id])).rows[0];
    if (!s) return reply.code(404).send({ error: 'not_found' });
    if (s.kind === 'link') { await db.query(`UPDATE kb_sources SET status = 'pending', error = NULL WHERE id = $1`, [p.data.id]); kb.enqueue(p.data.id); return reply.code(202).send({ ok: true }); }
    if (s.kind === 'file') return reply.code(400).send({ error: 'upload_new_version' });
    await kb.indexWritten(p.data.id).catch(() => undefined);
    return { ok: true };
  });

  app.delete('/kb/sources/:id', { preHandler: manage }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const r = await db.query('DELETE FROM kb_sources WHERE id = $1', [p.data.id]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(db, { actorId: req.user!.id, action: 'kb.delete', target: p.data.id, ip: req.ip });
    return { ok: true };
  });

  // ---- categories & synonyms -------------------------------------------------------------------------------------
  app.get('/kb/categories', { preHandler: manage }, async () => (await db.query(`SELECT id, name, (SELECT count(*)::int FROM kb_sources s WHERE s.category_id = c.id) AS sources FROM kb_categories c ORDER BY lower(name)`)).rows);
  app.post('/kb/categories', { preHandler: manage }, async (req, reply) => {
    const b = z.object({ name: z.string().trim().min(1).max(60) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const r = await db.query('INSERT INTO kb_categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING id', [b.data.name]);
    if (!r.rowCount) return reply.code(409).send({ error: 'already_exists' });
    return reply.code(201).send({ id: r.rows[0].id });
  });
  app.delete('/kb/categories/:id', { preHandler: manage }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    await db.query('DELETE FROM kb_categories WHERE id = $1', [p.data.id]);
    return { ok: true };
  });

  app.get('/kb/synonyms', { preHandler: manage }, async () => (await db.query('SELECT id, words FROM kb_synonyms ORDER BY id')).rows);
  app.post('/kb/synonyms', { preHandler: manage }, async (req, reply) => {
    const b = z.object({ words: z.array(z.string().trim().min(2).max(40)).min(2).max(20) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const r = await db.query('INSERT INTO kb_synonyms (words) VALUES ($1) RETURNING id', [b.data.words]);
    kb.invalidateSynonyms();
    return reply.code(201).send({ id: r.rows[0].id });
  });
  app.delete('/kb/synonyms/:id', { preHandler: manage }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    await db.query('DELETE FROM kb_synonyms WHERE id = $1', [p.data.id]);
    kb.invalidateSynonyms();
    return { ok: true };
  });

  // ---- testing, gaps, stats ----------------------------------------------------------------------------------------
  // Playground: shows what the bot would answer and why (scores). Logged as "test", not counted as customer questions.
  app.post('/kb/search', { preHandler: manage, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ q: z.string().trim().min(2).max(300), audience: z.enum(['bot', 'staff', 'any']).default('any') }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const bot = await loadBot(db);
    const hits = await kb.search(b.data.q, { audience: b.data.audience, limit: 6 });
    const top = hits[0];
    const wouldAnswer = isConfident(top, hits[1], bot.kb.minScore);
    return { minScore: bot.kb.minScore, wouldAnswer, semantic: kb.semanticStatus(), hits: hits.map((h) => ({ ...h, snippet: h.snippet.slice(0, 400) })) };
  });

  // Questions customers asked that the base could not answer (grouped), so staff know which answers to write.
  app.get('/kb/gaps', { preHandler: manage }, async () => (await db.query(
    `SELECT lower(text) AS text, count(*)::int AS times, max(created_at) AS "lastAt", round(max(score)::numeric, 2) AS "bestScore"
       FROM kb_queries WHERE NOT answered AND via IN ('bot','staff') AND created_at > now() - interval '30 days'
      GROUP BY lower(text) ORDER BY times DESC, "lastAt" DESC LIMIT 100`)).rows);
  app.post('/kb/gaps/dismiss', { preHandler: manage }, async (req, reply) => {
    const b = z.object({ text: z.string().min(1).max(200) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    await db.query(`DELETE FROM kb_queries WHERE NOT answered AND lower(text) = lower($1)`, [b.data.text]);
    return { ok: true };
  });

  app.get('/kb/stats', { preHandler: manage }, async () => {
    const q = (await db.query(
      `SELECT count(*) FILTER (WHERE via = 'bot')::int AS "botQuestions", count(*) FILTER (WHERE via = 'bot' AND answered)::int AS "botAnswered",
              count(*) FILTER (WHERE via = 'staff')::int AS "staffLookups", count(*) FILTER (WHERE via = 'staff' AND answered)::int AS "staffAnswered"
         FROM kb_queries WHERE created_at > now() - interval '30 days' AND via IN ('bot','staff')`)).rows[0];
    const totals = (await db.query(`SELECT count(*)::int AS sources, count(*) FILTER (WHERE status = 'error')::int AS errors, (SELECT count(*)::int FROM kb_chunks) AS chunks FROM kb_sources`)).rows[0];
    const top = (await db.query(`SELECT id, title, uses, helpful, unhelpful FROM kb_sources WHERE uses > 0 ORDER BY uses DESC LIMIT 8`)).rows;
    return { ...q, ...totals, top };
  });

  // ---- for agents (any signed-in staff) --------------------------------------------------------------------------
  // Suggested answers for the latest customer message of a conversation the caller may access.
  app.get('/conversations/:id/kb-suggestions', { preHandler: any, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    if (!(await loadAccessible(db, req.user!, p.data.id))) return reply.code(404).send({ error: 'not_found' });
    const m = (await db.query(`SELECT body FROM messages WHERE conversation_id = $1 AND direction = 'in' AND NOT auto AND body <> '' ORDER BY created_at DESC LIMIT 1`, [p.data.id])).rows[0];
    if (!m) return { question: null, hits: [] };
    const hits = (await kb.search(m.body as string, { audience: 'staff', limit: 3 })).filter((h) => h.score >= 0.4);
    const out = [];
    for (const h of hits) {
      const src = (await db.query('SELECT kind, body FROM kb_sources WHERE id = $1', [h.sourceId])).rows[0];
      out.push({ sourceId: h.sourceId, title: h.title, url: h.url, score: h.score, text: src?.kind === 'faq' && src.body ? String(src.body).slice(0, 1500) : h.snippet.slice(0, 900) });
    }
    return { question: (m.body as string).slice(0, 200), hits: out };
  });

  app.post('/kb/feedback', { preHandler: any, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ sourceId: z.string().uuid(), action: z.enum(['used', 'helpful', 'unhelpful']) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const col = { used: 'uses', helpful: 'helpful', unhelpful: 'unhelpful' }[b.data.action];
    const r = await db.query(`UPDATE kb_sources SET ${col} = ${col} + 1 WHERE id = $1`, [b.data.sourceId]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    if (b.data.action !== 'used') await db.query('INSERT INTO kb_feedback (source_id, user_id, helpful) VALUES ($1,$2,$3)', [b.data.sourceId, req.user!.id, b.data.action === 'helpful']);
    return { ok: true };
  });
}

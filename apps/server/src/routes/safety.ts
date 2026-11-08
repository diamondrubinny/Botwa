import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { loadAccessible } from '../access.js';
import { audit } from '../audit.js';
import { requireAuth } from '../auth.js';
import type { Db } from '../db.js';
import type { KnowledgeBase } from '../kb/service.js';
import { sanitizeFileName } from '../media/validate.js';
import { boardCategories, ensureBoardCategories } from '../safety/categories.js';
import { importWorkbook, reapplyCategories } from '../safety/importer.js';
import { areasTemplate, importAreas } from '../safety/areasImport.js';
import { cleanTopics, importOfficers, listOfficers, normalizePhone, officersTemplate } from '../safety/officers.js';
import { TEMPLATE_TAGS } from '../flow/safetyTemplate.js';

const idParam = z.object({ id: z.string().uuid() });

/** Short, plain excerpt around the start of a text (the full text is fetched on demand). */
const excerpt = (s: string | null, n = 320) => { const t = (s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n).replace(/\s\S*$/, '')}…` : t; };
const instrumentOf = (meta: Record<string, string> | null): string => meta?.instrument || 'אחר';

/**
 * SafetyBoard: search the imported standards and answers by topic, with exact citations. Nothing is paraphrased or invented:
 * every result is a stored provision or answer, shown with its reference and, for answers, a link to the original page.
 */
export function safetyRoutes(app: FastifyInstance, db: Db, kb: KnowledgeBase) {
  const view = requireAuth(db, 'safety.view');
  const manage = requireAuth(db, 'kb.manage');

  app.post('/kb/import/xlsx', { preHandler: manage, config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'bad_request' });
    const f = z.object({ audience: z.enum(['bot', 'staff', 'both']).default('staff') }).safeParse(Object.fromEntries(Object.entries(file.fields).map(([k, v]) => [k, (v as { value?: unknown } | undefined)?.value]).filter(([, v]) => v !== '' && v !== undefined)));
    if (!f.success) return reply.code(400).send({ error: 'bad_request' });
    if (!/\.xlsx$/i.test(sanitizeFileName(file.filename, 'x'))) return reply.code(415).send({ error: 'unsupported_file_type' });
    let buf: Buffer;
    try { buf = await file.toBuffer(); } catch { return reply.code(413).send({ error: 'too_large' }); }
    if (file.file.truncated) return reply.code(413).send({ error: 'too_large' });
    try {
      const r = await importWorkbook(db, kb, buf, { audience: f.data.audience, userId: req.user!.id });
      await audit(db, { actorId: req.user!.id, action: 'safety.import', ip: req.ip, meta: { ...r } });
      return r;
    } catch (e) {
      const code = (e as Error).message;
      const status = code === 'unknown_workbook' || code === 'empty_content' || code === 'too_many_rows' ? 422 : code === 'infected' ? 422 : code === 'scan_unavailable' ? 503 : 422;
      await audit(db, { actorId: req.user!.id, action: 'safety.import_failed', ip: req.ip, meta: { reason: code } });
      return reply.code(status).send({ error: ['unknown_workbook', 'empty_content', 'too_many_rows', 'infected', 'scan_unavailable'].includes(code) ? (code === 'infected' ? 'file_infected' : code) : 'extract_failed' });
    }
  });

  app.get('/safety/categories', { preHandler: view }, async () => {
    await ensureBoardCategories(db);
    const rows = (await db.query(
      `SELECT c.id, c.name, c.keywords, c.sort, c.origin, (SELECT count(*)::int FROM kb_source_cats x JOIN kb_sources s ON s.id = x.source_id WHERE x.category_id = c.id AND s.enabled AND s.status = 'ready') AS count
         FROM kb_categories c WHERE c.board ORDER BY c.sort, c.name`)).rows;
    const t = (await db.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM kb_source_cats x WHERE x.source_id = s.id))::int AS uncategorized FROM kb_sources s WHERE s.origin IS NOT NULL AND s.enabled AND s.status = 'ready'`)).rows[0];
    return { categories: rows, total: t.total as number, uncategorized: t.uncategorized as number };
  });

  app.put('/safety/categories/:id', { preHandler: manage }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = z.object({ keywords: z.array(z.string().trim().min(2).max(40)).max(40) }).safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    const r = await db.query('UPDATE kb_categories SET keywords = $2 WHERE id = $1 AND board', [p.data.id, [...new Set(b.data.keywords)]]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(db, { actorId: req.user!.id, action: 'safety.category_keywords', target: p.data.id, ip: req.ip });
    return { ok: true };
  });

  app.post('/safety/categories/reapply', { preHandler: manage, config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req) => {
    const r = await reapplyCategories(db);
    await audit(db, { actorId: req.user!.id, action: 'safety.reapply', ip: req.ip, meta: { ...r } });
    return r;
  });

  // Free-text question, optionally inside one topic. Results are grouped by kind of source, each with its citation.
  app.post('/safety/ask', { preHandler: view, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ q: z.string().trim().min(2).max(400), categoryId: z.string().uuid().nullable().optional() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const hits = await kb.search(b.data.q, { audience: 'any', limit: 14, categoryId: b.data.categoryId ?? undefined });
    const good = hits.filter((h) => h.score >= 0.12); // a long question matches a provision on one or two words: rank them, do not drop them
    await kb.logQuery(b.data.q, 'staff', good.length > 0, good[0]?.score ?? null, good[0]?.sourceId ?? null);
    const meta = new Map((await db.query('SELECT id, reference, origin, meta, url, kind, body FROM kb_sources WHERE id = ANY($1::uuid[])', [good.map((h) => h.sourceId)])).rows.map((r) => [r.id as string, r]));
    const items = good.map((h) => {
      const m = meta.get(h.sourceId);
      const md = (m?.meta ?? {}) as Record<string, string>;
      return { sourceId: h.sourceId, title: h.title, score: h.score, instrument: instrumentOf(md), reference: (m?.reference as string | null) || null, url: (m?.url as string | null) || null, excerpt: excerpt(h.snippet, 420), related: md.related || null, difference: md.difference || null, subtopic: md.subtopic || null, date: md.date || null };
    });
    const groups = new Map<string, typeof items>();
    for (const it of items) groups.set(it.instrument, [...(groups.get(it.instrument) ?? []), it]);
    return { question: b.data.q, total: items.length, groups: [...groups.entries()].map(([instrument, list]) => ({ instrument, items: list })), instruments: [...groups.keys()] };
  });

  // Everything the base holds about one topic, as one organised list (the "integration" view).
  app.get('/safety/category/:id/items', { preHandler: view }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const cat = (await db.query('SELECT id, name FROM kb_categories WHERE id = $1 AND board', [p.data.id])).rows[0];
    if (!cat) return reply.code(404).send({ error: 'not_found' });
    const rows = (await db.query(
      `SELECT s.id, s.title, s.reference, s.url, s.body, s.meta FROM kb_sources s JOIN kb_source_cats x ON x.source_id = s.id
        WHERE x.category_id = $1 AND s.enabled AND s.status = 'ready' ORDER BY s.meta->>'instrument', s.reference NULLS LAST, s.title LIMIT 600`, [p.data.id])).rows;
    const byInstrument = new Map<string, unknown[]>();
    for (const r of rows) {
      const md = (r.meta ?? {}) as Record<string, string>;
      const list = byInstrument.get(instrumentOf(md)) ?? [];
      list.push({ id: r.id, title: r.title, reference: r.reference, url: r.url, excerpt: excerpt(r.body), related: md.related || null, difference: md.difference || null, type: md.type || null, subtopic: md.subtopic || null, date: md.date || null });
      byInstrument.set(instrumentOf(md), list);
    }
    return { category: cat, total: rows.length, groups: [...byInstrument.entries()].map(([instrument, items]) => ({ instrument, items })) };
  });

  // "Jump" to the safety officer: standards that fit the topic the bot tagged on the conversation, from what the customer wrote.
  app.get('/conversations/:id/safety-suggestions', { preHandler: view, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    if (!(await loadAccessible(db, req.user!, p.data.id))) return reply.code(404).send({ error: 'not_found' });
    const cats = (await db.query(
      `SELECT c.id, c.name FROM conversation_tags ct JOIN tags t ON t.id = ct.tag_id JOIN kb_categories c ON c.board AND lower(c.name) = lower(t.name) WHERE ct.conversation_id = $1 ORDER BY c.sort LIMIT 3`, [p.data.id])).rows as { id: string; name: string }[];
    if (cats.length === 0) return { topics: [], hits: [] };
    const text = (await db.query(`SELECT body FROM messages WHERE conversation_id = $1 AND direction = 'in' AND NOT auto AND length(body) > 2 ORDER BY created_at DESC LIMIT 3`, [p.data.id])).rows.map((r) => r.body as string).join(' ').slice(0, 600);
    if (!text.trim()) return { topics: cats.map((c) => c.name), hits: [] };
    const out: { topic: string; sourceId: string; title: string; reference: string | null; url: string | null; excerpt: string; instrument: string; score: number }[] = [];
    for (const c of cats) {
      const hits = (await kb.search(text, { audience: 'any', limit: 4, categoryId: c.id })).filter((h) => h.score >= 0.12);
      const meta = new Map((await db.query('SELECT id, reference, url, meta FROM kb_sources WHERE id = ANY($1::uuid[])', [hits.map((h) => h.sourceId)])).rows.map((r) => [r.id as string, r]));
      for (const h of hits) { const m = meta.get(h.sourceId); out.push({ topic: c.name, sourceId: h.sourceId, title: h.title, reference: (m?.reference as string) || null, url: (m?.url as string) || null, excerpt: excerpt(h.snippet, 280), instrument: instrumentOf((m?.meta ?? {}) as Record<string, string>), score: h.score }); }
    }
    return { topics: cats.map((c) => c.name), hits: out.slice(0, 6) };
  });

  // ---- responsibility areas: which officer answers for which building / place ----
  const areaView = requireAuth(db, 'bot.view');
  const areaManage = requireAuth(db, 'bot.manage');
  const areaBody = z.object({ name: z.string().trim().min(1).max(80), keywords: z.array(z.string().trim().min(1).max(60)).min(1).max(30), userId: z.string().uuid() });

  app.get('/safety/areas', { preHandler: areaView }, async () => (await db.query(
    `SELECT a.id, a.name, a.keywords, a.user_id AS "userId", u.name AS "userName", u.active AS "userActive" FROM responsibility_areas a JOIN users u ON u.id = a.user_id ORDER BY a.sort, a.created_at`)).rows);

  app.get('/safety/areas/template.xlsx', { preHandler: areaView }, async (_req, reply) => reply
    .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .header('content-disposition', 'attachment; filename="areas-template.xlsx"').send(await areasTemplate()));

  app.post('/safety/areas/import', { preHandler: areaManage, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'bad_request' });
    if (!/\.xlsx$/i.test(sanitizeFileName(file.filename, 'x'))) return reply.code(415).send({ error: 'unsupported_file_type' });
    let buf: Buffer;
    try { buf = await file.toBuffer(); } catch { return reply.code(413).send({ error: 'too_large' }); }
    if (file.file.truncated) return reply.code(413).send({ error: 'too_large' });
    const scan = await kb.scanBinary(buf);
    if (scan === 'infected') return reply.code(422).send({ error: 'file_infected' });
    if (scan === 'unavailable') return reply.code(503).send({ error: 'scan_unavailable' });
    try {
      const r = await importAreas(db, buf);
      await audit(db, { actorId: req.user!.id, action: 'safety.areas_import', ip: req.ip, meta: { created: r.created, updated: r.updated, skipped: r.skipped.length } });
      return r;
    } catch (e) {
      return reply.code(422).send({ error: (e as Error).message === 'unknown_workbook' ? 'unknown_workbook' : 'extract_failed' });
    }
  });

  app.post('/safety/areas', { preHandler: areaManage }, async (req, reply) => {
    const b = areaBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    if (!(await db.query('SELECT 1 FROM users WHERE id = $1 AND active', [b.data.userId])).rowCount) return reply.code(400).send({ error: 'unknown_user' });
    if ((await db.query('SELECT count(*)::int AS n FROM responsibility_areas')).rows[0].n >= 200) return reply.code(409).send({ error: 'too_many' });
    const r = await db.query(`INSERT INTO responsibility_areas (name, keywords, user_id, sort) VALUES ($1,$2,$3, COALESCE((SELECT max(sort) + 1 FROM responsibility_areas), 0)) RETURNING id`, [b.data.name, [...new Set(b.data.keywords)], b.data.userId]);
    await audit(db, { actorId: req.user!.id, action: 'safety.area_create', target: r.rows[0].id, ip: req.ip });
    return reply.code(201).send({ id: r.rows[0].id });
  });

  app.put('/safety/areas/:id', { preHandler: areaManage }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = areaBody.safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    if (!(await db.query('SELECT 1 FROM users WHERE id = $1 AND active', [b.data.userId])).rowCount) return reply.code(400).send({ error: 'unknown_user' });
    const r = await db.query('UPDATE responsibility_areas SET name = $2, keywords = $3, user_id = $4 WHERE id = $1', [p.data.id, b.data.name, [...new Set(b.data.keywords)], b.data.userId]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(db, { actorId: req.user!.id, action: 'safety.area_update', target: p.data.id, ip: req.ip });
    return { ok: true };
  });

  app.delete('/safety/areas/:id', { preHandler: areaManage }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const r = await db.query('DELETE FROM responsibility_areas WHERE id = $1', [p.data.id]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(db, { actorId: req.user!.id, action: 'safety.area_delete', target: p.data.id, ip: req.ip });
    return { ok: true };
  });

  // ---- officers by topic: names, e-mails, WhatsApp numbers, the topics they answer for, and optionally their account ----
  const officerBody = z.object({
    name: z.string().trim().min(1).max(100),
    email: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), z.string().trim().toLowerCase().email().max(254).nullable().default(null)),
    phone: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), z.string().trim().max(30).nullable().default(null)),
    userId: z.string().uuid().nullable().default(null),
    topics: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
    notes: z.string().trim().max(300).default(''),
    active: z.boolean().default(true),
  });
  async function officerFields(b: z.infer<typeof officerBody>): Promise<{ phone: string | null } | { error: string }> {
    let phone: string | null = null;
    if (b.phone) { phone = normalizePhone(b.phone); if (!phone) return { error: 'bad_phone' }; }
    if (b.userId && !(await db.query('SELECT 1 FROM users WHERE id = $1 AND active', [b.userId])).rowCount) return { error: 'unknown_user' };
    return { phone };
  }
  async function setTopics(id: string, topics: string[]) {
    await db.query('DELETE FROM officer_topics WHERE officer_id = $1', [id]);
    for (const t of cleanTopics(topics)) await db.query('INSERT INTO officer_topics (officer_id, topic) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, t]);
  }

  app.get('/safety/officers', { preHandler: areaView }, async () => listOfficers(db));

  /** Topic names to pick from: the board topics, the flow template's topics, and the ones already used. */
  app.get('/safety/officer-topics', { preHandler: areaView }, async () => {
    const used = (await db.query('SELECT DISTINCT topic FROM officer_topics')).rows.map((r) => r.topic as string);
    const board = (await db.query('SELECT name FROM kb_categories WHERE board ORDER BY sort, name')).rows.map((r) => r.name as string);
    return [...new Set([...TEMPLATE_TAGS, ...board, ...used])];
  });

  app.get('/safety/officers/template.xlsx', { preHandler: areaView }, async (_req, reply) => reply
    .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .header('content-disposition', 'attachment; filename="officers-template.xlsx"').send(await officersTemplate()));

  app.post('/safety/officers/import', { preHandler: areaManage, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'bad_request' });
    if (!/\.xlsx$/i.test(sanitizeFileName(file.filename, 'x'))) return reply.code(415).send({ error: 'unsupported_file_type' });
    let buf: Buffer;
    try { buf = await file.toBuffer(); } catch { return reply.code(413).send({ error: 'too_large' }); }
    if (file.file.truncated) return reply.code(413).send({ error: 'too_large' });
    const scan = await kb.scanBinary(buf);
    if (scan === 'infected') return reply.code(422).send({ error: 'file_infected' });
    if (scan === 'unavailable') return reply.code(503).send({ error: 'scan_unavailable' });
    try {
      const r = await importOfficers(db, buf);
      await audit(db, { actorId: req.user!.id, action: 'safety.officers_import', ip: req.ip, meta: { created: r.created, updated: r.updated, skipped: r.skipped.length } });
      return r;
    } catch (e) { return reply.code(422).send({ error: (e as Error).message === 'unknown_workbook' ? 'unknown_workbook' : 'extract_failed' }); }
  });

  app.post('/safety/officers', { preHandler: areaManage }, async (req, reply) => {
    const b = officerBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const f = await officerFields(b.data);
    if ('error' in f) return reply.code(400).send({ error: f.error });
    if ((await db.query('SELECT count(*)::int AS n FROM officers')).rows[0].n >= 300) return reply.code(409).send({ error: 'too_many' });
    const r = await db.query(`INSERT INTO officers (name, email, phone, user_id, notes, active, sort) VALUES ($1,$2,$3,$4,$5,$6, COALESCE((SELECT max(sort) + 1 FROM officers), 0)) RETURNING id`, [b.data.name, b.data.email, f.phone, b.data.userId, b.data.notes, b.data.active]);
    await setTopics(r.rows[0].id, b.data.topics);
    await audit(db, { actorId: req.user!.id, action: 'safety.officer_create', target: r.rows[0].id, ip: req.ip });
    return reply.code(201).send({ id: r.rows[0].id });
  });

  app.put('/safety/officers/:id', { preHandler: areaManage }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = officerBody.safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    const f = await officerFields(b.data);
    if ('error' in f) return reply.code(400).send({ error: f.error });
    const r = await db.query('UPDATE officers SET name = $2, email = $3, phone = $4, user_id = $5, notes = $6, active = $7 WHERE id = $1', [p.data.id, b.data.name, b.data.email, f.phone, b.data.userId, b.data.notes, b.data.active]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await setTopics(p.data.id, b.data.topics);
    await audit(db, { actorId: req.user!.id, action: 'safety.officer_update', target: p.data.id, ip: req.ip });
    return { ok: true };
  });

  app.delete('/safety/officers/:id', { preHandler: areaManage }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const r = await db.query('DELETE FROM officers WHERE id = $1', [p.data.id]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(db, { actorId: req.user!.id, action: 'safety.officer_delete', target: p.data.id, ip: req.ip });
    return { ok: true };
  });

  app.get('/safety/source/:id', { preHandler: view }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const r = (await db.query(`SELECT id, title, body, reference, url, meta FROM kb_sources WHERE id = $1 AND origin IS NOT NULL AND enabled`, [p.data.id])).rows[0];
    return r ?? reply.code(404).send({ error: 'not_found' });
  });
}

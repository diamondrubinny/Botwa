import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { sendBlock, type AccessibleConversation } from '../access.js';
import type { ChannelManager } from '../channels/manager.js';
import { loadSending, PolicyRejected, SendError } from '../channels/sender.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { openApiDocument } from '../integrations/openapi.js';
import { computeSummary } from './reports.js';

export const SCOPES = ['read', 'send', 'manage'] as const;
export type Scope = (typeof SCOPES)[number];
export const sha = (s: string) => createHash('sha256').update(s).digest('hex');

declare module 'fastify' { interface FastifyRequest { apiKey?: { id: string; name: string; scopes: string[] } } }

/**
 * Public REST API for other systems. Authentication is a bearer API key only (never the browser session cookie), scoped:
 * read = look at conversations and messages, send = reply in an existing conversation, manage = status, assignment, tags.
 * There is deliberately no "message anyone" endpoint: replies go through the same blocking, opt-out and reply-window rules as staff.
 */
export function apiRoutes(app: FastifyInstance, db: Db, mgr: ChannelManager, cfg: Config) {
  const need = (scope: Scope) => async (req: FastifyRequest, reply: FastifyReply) => {
    const h = req.headers.authorization;
    const key = h?.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (!/^bk_[\w-]{6,12}_[\w-]{30,80}$/.test(key)) return reply.code(401).send({ error: 'unauthorized' });
    const { rows } = await db.query('SELECT id, name, scopes, last_used_at FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL', [sha(key)]);
    const k = rows[0];
    if (!k) return reply.code(401).send({ error: 'unauthorized' });
    if (!k.scopes.includes(scope)) return reply.code(403).send({ error: 'insufficient_scope', required: scope });
    req.apiKey = { id: k.id, name: k.name, scopes: k.scopes };
    if (!k.last_used_at || Date.now() - new Date(k.last_used_at).getTime() > 60_000) void db.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [k.id]).catch(() => undefined);
  };
  const limit = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute', keyGenerator: (r: FastifyRequest) => sha(r.headers.authorization ?? r.ip) } });
  const idParam = z.object({ id: z.string().uuid() });

  const LIST = `SELECT c.id, c.status, c.assigned_to AS "assignedTo", c.unread_count AS "unread", c.last_message_at AS "lastMessageAt", c.created_at AS "createdAt",
      ch.id AS "channelId", ch.type AS "channelType", ct.id AS "contactId", ct.display_name AS "contactName", ct.blocked,
      COALESCE((SELECT json_agg(t.name ORDER BY lower(t.name)) FROM conversation_tags x JOIN tags t ON t.id = x.tag_id WHERE x.conversation_id = c.id), '[]'::json) AS tags
    FROM conversations c JOIN channels ch ON ch.id = c.channel_id JOIN contacts ct ON ct.id = c.contact_id`;
  const shape = (r: Record<string, unknown>) => ({ id: r.id, status: r.status, assignedTo: r.assignedTo, unread: r.unread, lastMessageAt: r.lastMessageAt, createdAt: r.createdAt, tags: r.tags,
    channel: { id: r.channelId, type: r.channelType }, contact: { id: r.contactId, name: r.contactName, blocked: r.blocked } });

  app.get('/api/v1/me', { preHandler: need('read'), config: limit(60) }, async (req) => ({ name: req.apiKey!.name, scopes: req.apiKey!.scopes }));

  // The API description (OpenAPI 2.0 / Swagger, the format Power Apps / Power Automate custom connectors import). Public: it holds no data or keys.
  app.get('/api/v1/openapi.json', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (_req, reply) =>
    reply.header('cache-control', 'public, max-age=300').header('content-disposition', 'inline; filename="botwa-openapi.json"').send(openApiDocument(cfg)));

  // ---- read-only data for dashboards and apps (Power Apps, Power BI, Excel) ----
  app.get('/api/v1/stats', { preHandler: need('read'), config: limit(30) }, async (req, reply) => {
    const q = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'bad_request' });
    const r = await computeSummary(db, cfg, q.data.days);
    return {
      days: r.days, newConversations: r.totals.newConversations, inbound: r.totals.inbound, outbound: r.totals.outbound, openNow: r.totals.openNow, unassignedNow: r.totals.unassignedNow,
      answered: r.responseTime.answered, unanswered: r.responseTime.unanswered, avgFirstResponseSeconds: r.responseTime.avgSeconds, medianFirstResponseSeconds: r.responseTime.medianSeconds,
      slaCompliancePercent: r.sla.enabled ? r.sla.compliancePercent : null,
      daily: r.daily, topTags: r.topTags,
    };
  });

  app.get('/api/v1/contacts', { preHandler: need('read'), config: limit(60) }, async (req, reply) => {
    const q = z.object({ q: z.string().trim().max(100).optional(), limit: z.coerce.number().int().min(1).max(200).default(100), offset: z.coerce.number().int().min(0).max(1000000).default(0) }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'bad_request' });
    const like = q.data.q ? `%${q.data.q.replace(/[\\%_]/g, '\\$&')}%` : null;
    const { rows } = await db.query(
      `SELECT ct.id, ct.display_name AS name, regexp_replace(ct.external_id, '@s\\.whatsapp\\.net$', '') AS "externalId", ch.type AS "channelType", ch.label AS "channelLabel",
              ct.blocked, ct.opted_out AS "optedOut", ct.created_at AS "createdAt", c.id AS "conversationId", c.status AS "conversationStatus", c.last_message_at AS "lastMessageAt"
         FROM contacts ct JOIN channels ch ON ch.id = ct.channel_id LEFT JOIN conversations c ON c.contact_id = ct.id
        WHERE ($1::text IS NULL OR ct.display_name ILIKE $1 OR ct.external_id ILIKE $1)
        ORDER BY COALESCE(c.last_message_at, ct.created_at) DESC LIMIT $2 OFFSET $3`, [like, q.data.limit, q.data.offset]);
    await audit(db, { action: 'api.contacts_read', meta: { key: req.apiKey!.name, count: rows.length } }).catch(() => undefined);
    return { items: rows, limit: q.data.limit, offset: q.data.offset };
  });

  app.get('/api/v1/faq', { preHandler: need('read'), config: limit(60) }, async () => {
    const { rows } = await db.query(
      `SELECT s.id, s.title AS question, s.body AS answer, s.variants, s.audience, s.uses, s.updated_at AS "updatedAt"
         FROM kb_sources s WHERE s.kind = 'faq' AND s.enabled ORDER BY lower(s.title) LIMIT 2000`);
    return { items: rows };
  });

  app.get('/api/v1/conversations', { preHandler: need('read'), config: limit(120) }, async (req, reply) => {
    const q = z.object({ status: z.enum(['open', 'closed']).optional(), updated_since: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(100000).default(0) }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'bad_request' });
    const { rows } = await db.query(`${LIST} WHERE ($1::text IS NULL OR c.status = $1) AND ($2::timestamptz IS NULL OR c.last_message_at >= $2) ORDER BY c.last_message_at DESC LIMIT $3 OFFSET $4`,
      [q.data.status ?? null, q.data.updated_since ?? null, q.data.limit, q.data.offset]);
    return { items: rows.map(shape), limit: q.data.limit, offset: q.data.offset };
  });

  app.get('/api/v1/conversations/:id', { preHandler: need('read'), config: limit(120) }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const r = (await db.query(`${LIST} WHERE c.id = $1`, [p.data.id])).rows[0];
    return r ? shape(r) : reply.code(404).send({ error: 'not_found' });
  });

  app.get('/api/v1/conversations/:id/messages', { preHandler: need('read'), config: limit(120) }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const q = z.object({ after_seq: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(200).default(100) }).safeParse(req.query);
    if (!p.success || !q.success) return reply.code(400).send({ error: 'bad_request' });
    if (!(await db.query('SELECT 1 FROM conversations WHERE id = $1', [p.data.id])).rowCount) return reply.code(404).send({ error: 'not_found' });
    const { rows } = await db.query(
      `SELECT m.id, m.seq, m.direction, m.body AS text, m.auto, m.created_at AS "createdAt", m.sender_user_id AS "senderUserId" FROM messages m WHERE m.conversation_id = $1 AND m.seq > $2 ORDER BY m.seq LIMIT $3`,
      [p.data.id, q.data.after_seq, q.data.limit]);
    return { items: rows.map((r) => ({ ...r, seq: Number(r.seq) })), nextAfterSeq: rows.length ? Number(rows[rows.length - 1]!.seq) : q.data.after_seq };
  });

  app.post('/api/v1/conversations/:id/messages', { preHandler: need('send'), config: limit(60) }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = z.object({ text: z.string().trim().min(1).max(4000) }).safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    const conv = (await db.query(
      `SELECT c.id, c.channel_id, c.assigned_to, c.status, ct.external_id, ct.blocked, ct.opted_out, ch.type AS channel_type
         FROM conversations c JOIN contacts ct ON ct.id = c.contact_id JOIN channels ch ON ch.id = c.channel_id WHERE c.id = $1`, [p.data.id])).rows[0] as AccessibleConversation | undefined;
    if (!conv) return reply.code(404).send({ error: 'not_found' });
    const blocked = await sendBlock(db, conv, (await loadSending(db)).replyWindowHours);
    if (blocked) return reply.code(409).send({ error: blocked });
    let sent: { externalMessageId?: string };
    try { sent = await mgr.sendText(conv.channel_id, conv.external_id, b.data.text); } catch (e) {
      if ((e as Error).message === 'channel_not_connected') return reply.code(409).send({ error: 'channel_not_connected' });
      if (e instanceof SendError) return reply.code(429).send({ error: e.code });
      if (e instanceof PolicyRejected) return reply.code(409).send({ error: e.code });
      req.log.error({ err: e }, 'api send failed');
      return reply.code(502).send({ error: 'send_failed' });
    }
    const { rows } = await db.query(`INSERT INTO messages (conversation_id, direction, body, external_id) VALUES ($1,'out',$2,$3) RETURNING id, seq, created_at AS "createdAt"`, [conv.id, b.data.text, sent.externalMessageId ?? null]);
    await db.query(`UPDATE conversations SET last_message_at = now(), bot_state = 'human' WHERE id = $1`, [conv.id]);
    mgr.notifyMessage(conv.channel_id, conv.id, rows[0].id);
    mgr.hookMessage('message.sent', conv.id, rows[0].id);
    await audit(db, { action: 'api.message_sent', target: conv.id, meta: { key: req.apiKey!.name } });
    return reply.code(201).send({ id: rows[0].id, seq: Number(rows[0].seq), createdAt: rows[0].createdAt });
  });

  app.post('/api/v1/conversations/:id/status', { preHandler: need('manage'), config: limit(60) }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = z.object({ status: z.enum(['open', 'closed']) }).safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    const r = await db.query(`UPDATE conversations SET status = $2, bot_state = CASE WHEN $2 = 'closed' THEN NULL ELSE bot_state END, bot_invalid = CASE WHEN $2 = 'closed' THEN 0 ELSE bot_invalid END WHERE id = $1`, [p.data.id, b.data.status]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    mgr.hookConversation('conversation.status_changed', p.data.id);
    await audit(db, { action: 'api.status', target: p.data.id, meta: { key: req.apiKey!.name, status: b.data.status } });
    return { ok: true };
  });

  app.post('/api/v1/conversations/:id/assign', { preHandler: need('manage'), config: limit(60) }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = z.object({ userId: z.string().uuid().nullable() }).safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    if (b.data.userId && !(await db.query('SELECT 1 FROM users WHERE id = $1 AND active', [b.data.userId])).rowCount) return reply.code(400).send({ error: 'invalid_user' });
    const r = await db.query(`UPDATE conversations SET assigned_to = $2, bot_state = CASE WHEN $2::uuid IS NOT NULL THEN 'human' ELSE bot_state END WHERE id = $1`, [p.data.id, b.data.userId]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    mgr.hookConversation('conversation.assigned', p.data.id);
    await audit(db, { action: 'api.assign', target: p.data.id, meta: { key: req.apiKey!.name, to: b.data.userId } });
    return { ok: true };
  });

  // Tags must already exist (managed in the panel); unknown names are rejected so integrations cannot flood the tag list.
  app.post('/api/v1/conversations/:id/tags', { preHandler: need('manage'), config: limit(60) }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = z.object({ names: z.array(z.string().trim().min(1).max(40)).min(1).max(10) }).safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    if (!(await db.query('SELECT 1 FROM conversations WHERE id = $1', [p.data.id])).rowCount) return reply.code(404).send({ error: 'not_found' });
    const tags = (await db.query('SELECT id, name FROM tags WHERE lower(name) = ANY($1::text[])', [b.data.names.map((n) => n.toLowerCase())])).rows;
    if (tags.length !== new Set(b.data.names.map((n) => n.toLowerCase())).size) return reply.code(400).send({ error: 'unknown_tag' });
    for (const t of tags) await db.query('INSERT INTO conversation_tags (conversation_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [p.data.id, t.id]);
    return { ok: true, tags: tags.map((t) => t.name) };
  });

  app.get('/api/v1/tags', { preHandler: need('read'), config: limit(60) }, async () => ({ items: (await db.query('SELECT id, name FROM tags ORDER BY lower(name)')).rows }));
  app.get('/api/v1/users', { preHandler: need('read'), config: limit(60) }, async () => ({ items: (await db.query('SELECT id, name FROM users WHERE active ORDER BY lower(name)')).rows }));
}

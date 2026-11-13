import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isManager, loadAccessible } from '../access.js';
import { audit } from '../audit.js';
import { requireAuth } from '../auth.js';
import type { Db } from '../db.js';

const idParam = z.object({ id: z.string().uuid() });
const MAX_AHEAD_DAYS = 30;
const MAX_PENDING_PER_CONVERSATION = 10;

/** Scheduled messages. Creating one needs access to the conversation; sending later re-checks block / opt-out / reply window / rate caps. */
export function scheduledRoutes(app: FastifyInstance, db: Db) {
  const any = requireAuth(db);

  app.get('/conversations/:id/scheduled', { preHandler: any }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    if (!(await loadAccessible(db, req.user!, p.data.id))) return reply.code(404).send({ error: 'not_found' });
    const { rows } = await db.query(
      `SELECT s.id, s.body, s.send_at AS "sendAt", s.status, s.error, u.name AS "createdByName", s.created_by AS "createdBy"
         FROM scheduled_messages s LEFT JOIN users u ON u.id = s.created_by
        WHERE s.conversation_id = $1 AND (s.status = 'pending' OR s.created_at > now() - interval '7 days') ORDER BY s.send_at DESC LIMIT 30`, [p.data.id]);
    return rows;
  });

  app.post('/conversations/:id/scheduled', { preHandler: any, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = z.object({ text: z.string().trim().min(1).max(4000), sendAt: z.string().datetime({ offset: true }) }).safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    const when = new Date(b.data.sendAt).getTime();
    if (when < Date.now() + 30_000) return reply.code(400).send({ error: 'time_in_past' });
    if (when > Date.now() + MAX_AHEAD_DAYS * 86400_000) return reply.code(400).send({ error: 'too_far_ahead' });
    const conv = await loadAccessible(db, req.user!, p.data.id);
    if (!conv) return reply.code(404).send({ error: 'not_found' });
    if (conv.blocked) return reply.code(409).send({ error: 'contact_blocked' });
    if (conv.opted_out) return reply.code(409).send({ error: 'contact_opted_out' });
    const n = (await db.query(`SELECT count(*)::int AS n FROM scheduled_messages WHERE conversation_id = $1 AND status = 'pending'`, [conv.id])).rows[0].n;
    if (n >= MAX_PENDING_PER_CONVERSATION) return reply.code(409).send({ error: 'too_many_scheduled' });
    const { rows } = await db.query(
      `INSERT INTO scheduled_messages (conversation_id, body, send_at, created_by) VALUES ($1,$2,$3,$4) RETURNING id, body, send_at AS "sendAt", status`,
      [conv.id, b.data.text, new Date(when).toISOString(), req.user!.id]);
    await audit(db, { actorId: req.user!.id, action: 'scheduled.create', target: conv.id, ip: req.ip, meta: { sendAt: rows[0].sendAt } });
    return reply.code(201).send(rows[0]);
  });

  app.delete('/scheduled/:id', { preHandler: any }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const s = (await db.query(`SELECT id, conversation_id, created_by, status FROM scheduled_messages WHERE id = $1`, [p.data.id])).rows[0];
    if (!s || !(await loadAccessible(db, req.user!, s.conversation_id))) return reply.code(404).send({ error: 'not_found' });
    if (s.created_by !== req.user!.id && !isManager(req.user!)) return reply.code(403).send({ error: 'forbidden' });
    const r = await db.query(`UPDATE scheduled_messages SET status = 'cancelled' WHERE id = $1 AND status = 'pending'`, [s.id]);
    if (!r.rowCount) return reply.code(409).send({ error: 'not_pending' });
    await audit(db, { actorId: req.user!.id, action: 'scheduled.cancel', target: s.conversation_id, ip: req.ip });
    return { ok: true };
  });
}

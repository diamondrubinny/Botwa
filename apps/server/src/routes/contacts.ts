import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireAuth } from '../auth.js';
import type { Db } from '../db.js';

const idParam = z.object({ id: z.string().uuid() });

/** Blocking a customer (abuse/spam): supervisors and admins. The conversation is closed; new messages are stored silently. */
export function contactRoutes(app: FastifyInstance, db: Db) {
  const managers = requireAuth(db, ['admin', 'supervisor']);

  app.post('/contacts/:id/block', { preHandler: managers }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = z.object({ reason: z.string().trim().max(200).optional() }).safeParse(req.body ?? {});
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    const r = await db.query(
      `UPDATE contacts SET blocked = true, blocked_at = now(), blocked_by = $2, blocked_reason = $3 WHERE id = $1 RETURNING id`,
      [p.data.id, req.user!.id, b.data.reason ?? null],
    );
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await db.query(`UPDATE conversations SET status = 'closed', unread_count = 0, bot_state = NULL WHERE contact_id = $1`, [p.data.id]);
    await audit(db, { actorId: req.user!.id, action: 'contact.block', target: p.data.id, ip: req.ip, meta: { reason: b.data.reason ?? null } });
    return { ok: true };
  });

  app.post('/contacts/:id/unblock', { preHandler: managers }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const r = await db.query(`UPDATE contacts SET blocked = false, blocked_at = NULL, blocked_by = NULL, blocked_reason = NULL WHERE id = $1`, [p.data.id]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(db, { actorId: req.user!.id, action: 'contact.unblock', target: p.data.id, ip: req.ip });
    return { ok: true };
  });
}

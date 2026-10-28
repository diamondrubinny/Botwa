import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireAuth } from '../auth.js';
import type { Db } from '../db.js';
import { hashPassword, PASSWORD_MIN } from '../password.js';

const role = z.enum(['admin', 'supervisor', 'agent']);
const idParam = z.object({ id: z.string().uuid() });
const publicCols = 'id, email, name, role, active, available, totp_enabled AS "mfaEnabled", created_at AS "createdAt"';

export function userRoutes(app: FastifyInstance, db: Db) {
  const adminOnly = requireAuth(db, ['admin']);

  app.get('/users', { preHandler: requireAuth(db, ['admin', 'supervisor']) }, async () => {
    const { rows } = await db.query(`SELECT ${publicCols} FROM users ORDER BY created_at`);
    return rows;
  });

  app.post('/users', { preHandler: adminOnly }, async (req, reply) => {
    const body = z
      .object({
        email: z.string().email().max(254).transform((s) => s.toLowerCase()),
        name: z.string().min(1).max(100),
        role,
        password: z.string().min(PASSWORD_MIN).max(256),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const b = body.data;
    try {
      const { rows } = await db.query(
        `INSERT INTO users (email, name, role, password_hash) VALUES ($1,$2,$3,$4) RETURNING ${publicCols}`,
        [b.email, b.name, b.role, await hashPassword(b.password)],
      );
      await audit(db, { actorId: req.user!.id, action: 'user.create', target: rows[0].id, ip: req.ip, meta: { role: b.role } });
      return reply.code(201).send(rows[0]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return reply.code(409).send({ error: 'email_taken' });
      throw e;
    }
  });

  app.patch('/users/:id', { preHandler: adminOnly }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const body = z
      .object({ name: z.string().min(1).max(100), role, active: z.boolean() })
      .partial()
      .refine((o) => Object.keys(o).length > 0)
      .safeParse(req.body);
    if (!p.success || !body.success) return reply.code(400).send({ error: 'bad_request' });
    const { id } = p.data;
    const b = body.data;

    if (id === req.user!.id && (b.active === false || (b.role && b.role !== 'admin'))) {
      return reply.code(409).send({ error: 'cannot_demote_self' });
    }
    const { rows } = await db.query(
      `UPDATE users SET name = COALESCE($2, name), role = COALESCE($3, role), active = COALESCE($4, active), updated_at = now()
        WHERE id = $1 RETURNING ${publicCols}`,
      [id, b.name ?? null, b.role ?? null, b.active ?? null],
    );
    if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (b.active === false || b.role) await db.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    await audit(db, { actorId: req.user!.id, action: 'user.update', target: id, ip: req.ip, meta: b });
    return rows[0];
  });

  app.post('/users/:id/reset-mfa', { preHandler: adminOnly }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const r = await db.query('UPDATE users SET totp_enabled = false, totp_secret_enc = NULL WHERE id = $1', [p.data.id]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await db.query('DELETE FROM sessions WHERE user_id = $1', [p.data.id]);
    await audit(db, { actorId: req.user!.id, action: 'user.mfa_reset', target: p.data.id, ip: req.ip });
    return { ok: true };
  });

  app.get('/audit', { preHandler: adminOnly }, async (req, reply) => {
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        before: z.coerce.number().int().positive().optional(), // keyset pagination: rows with id < before
        action: z.string().max(60).regex(/^[a-z_.]*$/).optional(), // prefix filter, e.g. "login" or "user."
      })
      .safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'bad_request' });
    const { rows } = await db.query(
      `SELECT a.id, a.actor_id AS "actorId", u.name AS "actorName", a.action, a.target, a.ip, a.created_at AS "createdAt"
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
        WHERE ($2::bigint IS NULL OR a.id < $2) AND ($3::text IS NULL OR a.action LIKE $3 || '%')
        ORDER BY a.id DESC LIMIT $1`,
      [q.data.limit, q.data.before ?? null, q.data.action ?? null],
    );
    return rows;
  });
}

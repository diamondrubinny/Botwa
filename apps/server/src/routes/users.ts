import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireAuth, type AuthUser } from '../auth.js';
import type { Db } from '../db.js';
import { hashPassword, PASSWORD_MIN } from '../password.js';
import { BUILTIN_ROLES, cleanPermissions, isSubset } from '../permissions.js';

const idParam = z.object({ id: z.string().uuid() });
const publicCols = 'id, email, name, role, active, available, totp_enabled AS "mfaEnabled", created_at AS "createdAt"';

export async function permissionsOfRole(db: Db, key: string): Promise<string[] | null> {
  const { rows } = await db.query('SELECT permissions, builtin FROM roles WHERE key = $1', [key]);
  if (!rows[0]) return null;
  return rows[0].builtin && BUILTIN_ROLES[key] ? BUILTIN_ROLES[key]!.permissions : cleanPermissions(rows[0].permissions);
}

/** Nobody can hand out (or take away) more than they hold themselves. */
async function mayUseRole(db: Db, actor: AuthUser, roleKey: string): Promise<boolean> {
  const perms = await permissionsOfRole(db, roleKey);
  return perms !== null && isSubset(perms, actor.permissions);
}

async function activeAdmins(db: Db, exceptUserId?: string): Promise<number> {
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND active AND ($1::uuid IS NULL OR id <> $1)`, [exceptUserId ?? null]);
  return rows[0].n;
}

export function userRoutes(app: FastifyInstance, db: Db) {
  const manage = requireAuth(db, 'users.manage');

  app.get('/users', { preHandler: requireAuth(db, 'users.view') }, async () => {
    const { rows } = await db.query(`SELECT ${publicCols} FROM users ORDER BY created_at`);
    return rows;
  });

  app.post('/users', { preHandler: manage }, async (req, reply) => {
    const body = z
      .object({
        email: z.string().email().max(254).transform((s) => s.toLowerCase()),
        name: z.string().min(1).max(100),
        role: z.string().min(1).max(41),
        password: z.string().min(PASSWORD_MIN).max(256),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const b = body.data;
    if ((await permissionsOfRole(db, b.role)) === null) return reply.code(400).send({ error: 'unknown_role' });
    if (!(await mayUseRole(db, req.user!, b.role))) return reply.code(403).send({ error: 'role_exceeds_permissions' });
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

  app.patch('/users/:id', { preHandler: manage }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const body = z
      .object({ name: z.string().min(1).max(100), role: z.string().min(1).max(41), active: z.boolean() })
      .partial()
      .refine((o) => Object.keys(o).length > 0)
      .safeParse(req.body);
    if (!p.success || !body.success) return reply.code(400).send({ error: 'bad_request' });
    const { id } = p.data;
    const b = body.data;
    const actor = req.user!;

    const cur = (await db.query('SELECT role FROM users WHERE id = $1', [id])).rows[0];
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    if (id === actor.id && (b.active === false || (b.role && b.role !== cur.role))) return reply.code(409).send({ error: 'cannot_demote_self' });
    // may only touch people whose current role is within your own permissions, and only assign roles within them
    if (!(await mayUseRole(db, actor, cur.role))) return reply.code(403).send({ error: 'role_exceeds_permissions' });
    if (b.role) {
      if ((await permissionsOfRole(db, b.role)) === null) return reply.code(400).send({ error: 'unknown_role' });
      if (!(await mayUseRole(db, actor, b.role))) return reply.code(403).send({ error: 'role_exceeds_permissions' });
    }
    // never leave the system without an active administrator
    const losesAdmin = cur.role === 'admin' && (b.active === false || (b.role !== undefined && b.role !== 'admin'));
    if (losesAdmin && (await activeAdmins(db, id)) === 0) return reply.code(409).send({ error: 'last_admin' });

    const { rows } = await db.query(
      `UPDATE users SET name = COALESCE($2, name), role = COALESCE($3, role), active = COALESCE($4, active), updated_at = now()
        WHERE id = $1 RETURNING ${publicCols}`,
      [id, b.name ?? null, b.role ?? null, b.active ?? null],
    );
    if (b.active === false || b.role) await db.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    await audit(db, { actorId: actor.id, action: 'user.update', target: id, ip: req.ip, meta: b });
    return rows[0];
  });

  // Account recovery: removes the second factor (TOTP and passkeys) and signs the user out everywhere.
  app.post('/users/:id/reset-mfa', { preHandler: manage }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const cur = (await db.query('SELECT role FROM users WHERE id = $1', [p.data.id])).rows[0];
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    if (!(await mayUseRole(db, req.user!, cur.role))) return reply.code(403).send({ error: 'role_exceeds_permissions' });
    await db.query('UPDATE users SET totp_enabled = false, totp_secret_enc = NULL WHERE id = $1', [p.data.id]);
    await db.query('DELETE FROM passkeys WHERE user_id = $1', [p.data.id]);
    await db.query('DELETE FROM sessions WHERE user_id = $1', [p.data.id]);
    await audit(db, { actorId: req.user!.id, action: 'user.mfa_reset', target: p.data.id, ip: req.ip });
    return { ok: true };
  });

  app.get('/audit', { preHandler: requireAuth(db, 'audit.view') }, async (req, reply) => {
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

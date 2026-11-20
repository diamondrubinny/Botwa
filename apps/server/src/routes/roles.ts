import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireAuth } from '../auth.js';
import type { Db } from '../db.js';
import { BUILTIN_ROLES, PERMISSIONS, cleanPermissions, isSubset } from '../permissions.js';

const roleBody = z.object({
  name: z.string().trim().min(1).max(40),
  permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length),
  mfaRequired: z.boolean(),
});

/** Custom roles: a named set of permissions. Built-in roles (admin/supervisor/agent) are fixed. */
export function roleRoutes(app: FastifyInstance, db: Db) {
  const manage = requireAuth(db, 'roles.manage');

  app.get('/roles', { preHandler: requireAuth(db, 'users.view') }, async () => {
    const { rows } = await db.query(
      `SELECT r.key, r.name, r.permissions, r.builtin, r.mfa_required AS "mfaRequired", (SELECT count(*)::int FROM users u WHERE u.role = r.key) AS "userCount"
         FROM roles r ORDER BY r.builtin DESC, r.created_at`,
    );
    return { permissions: PERMISSIONS, roles: rows.map((r) => (r.builtin && BUILTIN_ROLES[r.key] ? { ...r, permissions: BUILTIN_ROLES[r.key]!.permissions, mfaRequired: BUILTIN_ROLES[r.key]!.mfaRequired } : { ...r, permissions: cleanPermissions(r.permissions) })) };
  });

  app.post('/roles', { preHandler: manage }, async (req, reply) => {
    const b = roleBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    if (!isSubset(b.data.permissions, req.user!.permissions)) return reply.code(403).send({ error: 'role_exceeds_permissions' });
    const key = `r_${randomBytes(5).toString('hex')}`;
    await db.query('INSERT INTO roles (key, name, permissions, mfa_required) VALUES ($1,$2,$3,$4)', [key, b.data.name, b.data.permissions, b.data.mfaRequired]);
    await audit(db, { actorId: req.user!.id, action: 'role.create', target: key, ip: req.ip, meta: { name: b.data.name, permissions: b.data.permissions } });
    return reply.code(201).send({ key, ...b.data, builtin: false, userCount: 0 });
  });

  app.patch('/roles/:key', { preHandler: manage }, async (req, reply) => {
    const key = (req.params as { key: string }).key;
    const b = roleBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const cur = (await db.query('SELECT builtin, permissions FROM roles WHERE key = $1', [key])).rows[0];
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    if (cur.builtin) return reply.code(409).send({ error: 'builtin_role' });
    // may not edit a role that holds more than you do, nor grant more than you hold
    if (!isSubset(cleanPermissions(cur.permissions), req.user!.permissions) || !isSubset(b.data.permissions, req.user!.permissions)) {
      return reply.code(403).send({ error: 'role_exceeds_permissions' });
    }
    await db.query('UPDATE roles SET name = $2, permissions = $3, mfa_required = $4 WHERE key = $1', [key, b.data.name, b.data.permissions, b.data.mfaRequired]);
    await audit(db, { actorId: req.user!.id, action: 'role.update', target: key, ip: req.ip, meta: { name: b.data.name, permissions: b.data.permissions } });
    return { key, ...b.data, builtin: false };
  });

  app.delete('/roles/:key', { preHandler: manage }, async (req, reply) => {
    const key = (req.params as { key: string }).key;
    const cur = (await db.query('SELECT builtin FROM roles WHERE key = $1', [key])).rows[0];
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    if (cur.builtin) return reply.code(409).send({ error: 'builtin_role' });
    const used = (await db.query('SELECT count(*)::int AS n FROM users WHERE role = $1', [key])).rows[0].n;
    if (used > 0) return reply.code(409).send({ error: 'role_in_use' });
    await db.query('DELETE FROM roles WHERE key = $1', [key]);
    await audit(db, { actorId: req.user!.id, action: 'role.delete', target: key, ip: req.ip });
    return { ok: true };
  });
}

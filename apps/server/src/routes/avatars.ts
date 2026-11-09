import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireAuth } from '../auth.js';
import { MAX_AVATAR_BYTES, stripImageMetadata } from '../avatars.js';
import type { Db } from '../db.js';
import type { KnowledgeBase } from '../kb/service.js';
import { isSubset } from '../permissions.js';
import { permissionsOfRole } from './users.js';

const idParam = z.object({ id: z.string().uuid() });

/** Profile pictures: everyone changes their own; people with users.manage change others' (within their own permissions). Seen by signed-in staff only. */
export function avatarRoutes(app: FastifyInstance, db: Db, kb: KnowledgeBase) {
  const any = requireAuth(db);
  const manage = requireAuth(db, 'users.manage');
  const limit = { rateLimit: { max: 10, timeWindow: '10 minutes' } };

  app.get('/users/:id/avatar', { preHandler: any }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const r = (await db.query('SELECT mime, data FROM user_avatars WHERE user_id = $1', [p.data.id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'not_found' });
    return reply.header('content-type', r.mime).header('x-content-type-options', 'nosniff').header('content-security-policy', "default-src 'none'; sandbox")
      .header('cache-control', 'private, max-age=86400').send(r.data);
  });

  async function store(req: FastifyRequest, reply: FastifyReply, userId: string) {
    const file = await req.file({ limits: { fileSize: MAX_AVATAR_BYTES + 1 } });
    if (!file) return reply.code(400).send({ error: 'bad_request' });
    let buf: Buffer;
    try { buf = await file.toBuffer(); } catch { return reply.code(413).send({ error: 'too_large' }); }
    if (file.file.truncated || buf.length > MAX_AVATAR_BYTES) return reply.code(413).send({ error: 'too_large' });
    const img = stripImageMetadata(buf);
    if (!img) return reply.code(415).send({ error: 'unsupported_image' });
    const scan = await kb.scanBinary(img.data);
    if (scan === 'infected') return reply.code(422).send({ error: 'file_infected' });
    if (scan === 'unavailable') return reply.code(503).send({ error: 'scan_unavailable' });
    await db.query(`INSERT INTO user_avatars (user_id, mime, data) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data, updated_at = now()`, [userId, img.mime, img.data]);
    await audit(db, { actorId: req.user!.id, action: 'user.avatar', target: userId, ip: req.ip, meta: { bytes: img.data.length } });
    return { ok: true, avatarV: Math.floor(Date.now() / 1000) };
  }
  async function remove(req: FastifyRequest, userId: string) {
    await db.query('DELETE FROM user_avatars WHERE user_id = $1', [userId]);
    await audit(db, { actorId: req.user!.id, action: 'user.avatar_remove', target: userId, ip: req.ip });
    return { ok: true };
  }
  async function mayEdit(req: FastifyRequest, userId: string): Promise<boolean | null> {
    const cur = (await db.query('SELECT role FROM users WHERE id = $1', [userId])).rows[0];
    if (!cur) return null;
    const perms = await permissionsOfRole(db, cur.role);
    return perms !== null && isSubset(perms, req.user!.permissions);
  }

  app.post('/me/avatar', { preHandler: any, config: limit }, (req, reply) => store(req, reply, req.user!.id));
  app.delete('/me/avatar', { preHandler: any }, (req) => remove(req, req.user!.id));

  app.post('/users/:id/avatar', { preHandler: manage, config: limit }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const ok = await mayEdit(req, p.data.id);
    if (ok === null) return reply.code(404).send({ error: 'not_found' });
    if (!ok) return reply.code(403).send({ error: 'role_exceeds_permissions' });
    return store(req, reply, p.data.id);
  });
  app.delete('/users/:id/avatar', { preHandler: manage }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const ok = await mayEdit(req, p.data.id);
    if (ok === null) return reply.code(404).send({ error: 'not_found' });
    if (!ok) return reply.code(403).send({ error: 'role_exceeds_permissions' });
    return remove(req, p.data.id);
  });
}

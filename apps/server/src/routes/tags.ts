import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { loadAccessible } from '../access.js';
import { audit } from '../audit.js';
import { requireAuth } from '../auth.js';
import type { Db } from '../db.js';

const idParam = z.object({ id: z.string().uuid() });

/** Tags: supervisors/admins curate the list; any staff member can label conversations they can access. */
export function tagRoutes(app: FastifyInstance, db: Db) {
  const any = requireAuth(db);
  const curators = requireAuth(db, ['admin', 'supervisor']);

  app.get('/tags', { preHandler: any }, async () => {
    const { rows } = await db.query('SELECT id, name FROM tags ORDER BY lower(name)');
    return rows;
  });

  app.post('/tags', { preHandler: curators }, async (req, reply) => {
    const b = z.object({ name: z.string().trim().min(1).max(40) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    try {
      const { rows } = await db.query('INSERT INTO tags (name) VALUES ($1) RETURNING id, name', [b.data.name]);
      return reply.code(201).send(rows[0]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return reply.code(409).send({ error: 'tag_exists' });
      throw e;
    }
  });

  app.delete('/tags/:id', { preHandler: curators }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const r = await db.query('DELETE FROM tags WHERE id = $1', [p.data.id]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(db, { actorId: req.user!.id, action: 'tag.delete', target: p.data.id, ip: req.ip });
    return { ok: true };
  });

  app.post('/conversations/:id/tags', { preHandler: any }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = z.object({ tagId: z.string().uuid() }).safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    if (!(await loadAccessible(db, req.user!, p.data.id))) return reply.code(404).send({ error: 'not_found' });
    const exists = await db.query('SELECT 1 FROM tags WHERE id = $1', [b.data.tagId]);
    if (!exists.rowCount) return reply.code(400).send({ error: 'invalid_tag' });
    await db.query('INSERT INTO conversation_tags (conversation_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [p.data.id, b.data.tagId]);
    return { ok: true };
  });

  app.delete('/conversations/:id/tags/:tagId', { preHandler: any }, async (req, reply) => {
    const p = z.object({ id: z.string().uuid(), tagId: z.string().uuid() }).safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    if (!(await loadAccessible(db, req.user!, p.data.id))) return reply.code(404).send({ error: 'not_found' });
    await db.query('DELETE FROM conversation_tags WHERE conversation_id = $1 AND tag_id = $2', [p.data.id, p.data.tagId]);
    return { ok: true };
  });
}

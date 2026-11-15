import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import type { Db } from '../db.js';
import { can } from '../permissions.js';

/**
 * Global search (the panel's Ctrl+K): what the user may see, a few results of each kind. Conversations are searched by the
 * conversations list itself (its own visibility rules); this covers the rest. Titles and short labels only.
 */
export function searchRoutes(app: FastifyInstance, db: Db) {
  const any = requireAuth(db);
  app.get('/search', { preHandler: any, config: { rateLimit: { max: 90, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = z.object({ q: z.string().trim().min(2).max(80) }).safeParse(req.query);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const like = `%${p.data.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const u = req.user!;
    const run = async (sql: string) => (await db.query(sql, [like])).rows as { id: string; title: string; sub?: string | null }[];
    const [kb, canned, forms, officers, users, tags] = await Promise.all([
      can(u, 'kb.manage') ? run(`SELECT id, title, kind AS sub FROM kb_sources WHERE parent_id IS NULL AND (title ILIKE $1 OR EXISTS (SELECT 1 FROM unnest(variants) v WHERE v ILIKE $1)) ORDER BY enabled DESC, uses DESC LIMIT 6`) : [],
      run(`SELECT id, title, left(body, 80) AS sub FROM canned_replies WHERE title ILIKE $1 OR body ILIKE $1 ORDER BY title LIMIT 5`),
      run(`SELECT id, title, NULL AS sub FROM form_templates WHERE active AND title ILIKE $1 ORDER BY title LIMIT 5`),
      can(u, 'bot.view') || can(u, 'safety.view') ? run(`SELECT o.id, o.name AS title, (SELECT string_agg(t.topic, ', ') FROM officer_topics t WHERE t.officer_id = o.id) AS sub FROM officers o
          WHERE o.name ILIKE $1 OR EXISTS (SELECT 1 FROM officer_topics t WHERE t.officer_id = o.id AND t.topic ILIKE $1) ORDER BY o.sort LIMIT 5`) : [],
      can(u, 'users.view') ? run(`SELECT id, COALESCE(name_he, name) AS title, job_title AS sub FROM users WHERE active AND (name ILIKE $1 OR name_he ILIKE $1 OR email ILIKE $1 OR username ILIKE $1 OR job_title ILIKE $1) ORDER BY name LIMIT 5`) : [],
      can(u, 'tags.manage') || can(u, 'canned.manage') ? run(`SELECT id, name AS title, NULL AS sub FROM tags WHERE name ILIKE $1 ORDER BY name LIMIT 5`) : [],
    ]);
    return { kb, canned, forms, officers, users, tags };
  });
}

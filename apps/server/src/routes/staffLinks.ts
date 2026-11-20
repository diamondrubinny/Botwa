import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireAuth } from '../auth.js';
import type { Db } from '../db.js';
import { mayAsk, newLinkCode } from '../staff/assistant.js';

const masked = (ext: string) => { const id = ext.split('@')[0] ?? ''; return /^\d+$/.test(id) ? `•••${id.slice(-4)}` : '•••'; };

/** "Betty on WhatsApp" for managers: a one-time linking code, the user's own links, and removing one. */
export function staffLinkRoutes(app: FastifyInstance, db: Db) {
  const any = requireAuth(db);
  app.get('/me/whatsapp-links', { preHandler: any }, async (req) => {
    const allowed = await mayAsk(db, req.user!.id);
    const links = (await db.query(`SELECT l.id, l.external_id, l.created_at AS "createdAt", l.last_used_at AS "lastUsedAt", ch.label AS "channel"
        FROM staff_links l JOIN channels ch ON ch.id = l.channel_id WHERE l.user_id = $1 ORDER BY l.created_at`, [req.user!.id])).rows;
    const channels = (await db.query(`SELECT label FROM channels WHERE type IN ('whatsapp', 'whatsapp_cloud', 'telegram') ORDER BY created_at`)).rows.map((r) => r.label as string);
    const weekly = (await db.query('SELECT weekly_summary FROM users WHERE id = $1', [req.user!.id])).rows[0]?.weekly_summary !== false;
    return { allowed, channels, weekly, links: links.map(({ external_id, ...l }) => ({ ...l, account: masked(external_id) })) };
  });
  /** the weekly safety summary on WhatsApp (Sunday morning): on by default, each user switches it off for themselves */
  app.put('/me/weekly-summary', { preHandler: any }, async (req, reply) => {
    const b = z.object({ enabled: z.boolean() }).strict().safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    await db.query('UPDATE users SET weekly_summary = $2 WHERE id = $1', [req.user!.id, b.data.enabled]);
    await audit(db, { actorId: req.user!.id, action: 'staff.weekly_summary_setting', ip: req.ip, meta: { enabled: b.data.enabled } });
    return { ok: true, enabled: b.data.enabled };
  });
  app.post('/me/whatsapp-links/code', { preHandler: any, config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
    if (!(await mayAsk(db, req.user!.id))) return reply.code(403).send({ error: 'forbidden' });
    const c = await newLinkCode(db, req.user!.id);
    await audit(db, { actorId: req.user!.id, action: 'staff.whatsapp_code', ip: req.ip });
    return c;
  });
  app.delete('/me/whatsapp-links/:id', { preHandler: any }, async (req, reply) => {
    const p = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const r = await db.query('DELETE FROM staff_links WHERE id = $1 AND user_id = $2', [p.data.id, req.user!.id]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(db, { actorId: req.user!.id, action: 'staff.whatsapp_unlink', ip: req.ip, meta: { by: 'panel' } });
    return { ok: true };
  });
}

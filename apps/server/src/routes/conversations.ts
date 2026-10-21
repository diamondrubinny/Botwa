import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { isManager, loadAccessible } from '../access.js';
import { requireAuth } from '../auth.js';
import type { ChannelManager } from '../channels/manager.js';
import type { Db } from '../db.js';
import { MediaService } from '../media/store.js';

const idParam = z.object({ id: z.string().uuid() });
export function conversationRoutes(app: FastifyInstance, db: Db, mgr: ChannelManager, media: MediaService) {
  const any = requireAuth(db);

  app.get('/conversations', { preHandler: any }, async (req) => {
    const q = z
      .object({
        status: z.enum(['open', 'closed']).optional(),
        q: z.string().trim().min(1).max(100).optional(),
        mine: z.enum(['true', 'false']).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    const u = req.user!;
    const { rows } = await db.query(
      `SELECT c.id, c.channel_id AS "channelId", c.status, c.assigned_to AS "assignedTo", c.unread_count AS "unreadCount",
              c.last_message_at AS "lastMessageAt", ct.display_name AS "contactName", ct.external_id AS "contactId",
              ch.label AS "channelLabel", ch.type AS "channelType", au.name AS "assignedName",
              (SELECT COALESCE(NULLIF(m.body, ''), '[קובץ מצורף]') FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS "lastMessage"
         FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
              JOIN channels ch ON ch.id = c.channel_id LEFT JOIN users au ON au.id = c.assigned_to
        WHERE ($1::text IS NULL OR c.status = $1)
          AND ($2::boolean IS NOT TRUE OR c.assigned_to = $3)
          AND ($4::boolean OR c.assigned_to IS NULL OR c.assigned_to = $3)
          AND ($7::text IS NULL OR ct.display_name ILIKE $7 OR ct.external_id ILIKE $7
               OR EXISTS (SELECT 1 FROM messages sm WHERE sm.conversation_id = c.id AND sm.body ILIKE $7))
        ORDER BY c.last_message_at DESC LIMIT $5 OFFSET $6`,
      [q.status ?? null, q.mine === 'true', u.id, isManager(u), q.limit, q.offset, q.q ? `%${q.q.replace(/[\\%_]/g, '\\$&')}%` : null],
    );
    return rows;
  });

  app.get('/conversations/:id/messages', { preHandler: any }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.string().datetime().optional() }).safeParse(req.query);
    if (!p.success || !q.success) return reply.code(400).send({ error: 'bad_request' });
    if (!(await loadAccessible(db, req.user!, p.data.id))) return reply.code(404).send({ error: 'not_found' });
    const { rows } = await db.query(
      `SELECT m.id, m.direction, m.body, m.sender_user_id AS "senderUserId", u.name AS "senderName", m.created_at AS "createdAt",
              CASE WHEN a.id IS NULL THEN NULL ELSE json_build_object('id', a.id, 'kind', a.kind, 'mime', a.mime, 'size', a.size,
                'fileName', a.file_name, 'status', a.status, 'detail', a.detail) END AS attachment
         FROM messages m LEFT JOIN users u ON u.id = m.sender_user_id LEFT JOIN attachments a ON a.message_id = m.id
        WHERE m.conversation_id = $1 AND ($2::timestamptz IS NULL OR m.created_at < $2)
        ORDER BY m.created_at DESC LIMIT $3`,
      [p.data.id, q.data.before ?? null, q.data.limit],
    );
    return rows.reverse();
  });

  app.post('/conversations/:id/read', { preHandler: any }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    if (!(await loadAccessible(db, req.user!, p.data.id))) return reply.code(404).send({ error: 'not_found' });
    await db.query('UPDATE conversations SET unread_count = 0 WHERE id = $1', [p.data.id]);
    return { ok: true };
  });

  app.post('/conversations/:id/messages', { preHandler: any, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = z.object({ text: z.string().trim().min(1).max(4000) }).safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    const u = req.user!;
    const conv = await loadAccessible(db, u, p.data.id);
    if (!conv) return reply.code(404).send({ error: 'not_found' });
    let sent: { externalMessageId?: string };
    try {
      sent = await mgr.sendText(conv.channel_id, conv.external_id, b.data.text);
    } catch (e) {
      if ((e as Error).message === 'channel_not_connected') return reply.code(409).send({ error: 'channel_not_connected' });
      req.log.error({ err: e }, 'send failed');
      return reply.code(502).send({ error: 'send_failed' });
    }
    const { rows } = await db.query(
      `INSERT INTO messages (conversation_id, direction, body, external_id, sender_user_id) VALUES ($1,'out',$2,$3,$4)
       RETURNING id, direction, body, created_at AS "createdAt"`,
      [conv.id, b.data.text, sent.externalMessageId ?? null, u.id],
    );
    // Replying claims an unassigned conversation.
    await db.query(
      `UPDATE conversations SET last_message_at = now(), assigned_to = COALESCE(assigned_to, $2) WHERE id = $1`,
      [conv.id, u.id],
    );
    return reply.code(201).send(rows[0]);
  });

  app.post('/conversations/:id/assign', { preHandler: any }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = z.object({ userId: z.string().uuid().nullable() }).safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    const u = req.user!;
    const conv = await loadAccessible(db, u, p.data.id);
    if (!conv) return reply.code(404).send({ error: 'not_found' });
    const target = b.data.userId;
    if (!isManager(u)) {
      const claim = target === u.id && conv.assigned_to === null;
      const release = target === null && conv.assigned_to === u.id;
      if (!claim && !release) return reply.code(403).send({ error: 'forbidden' });
    }
    if (target) {
      const ok = await db.query('SELECT 1 FROM users WHERE id=$1 AND active', [target]);
      if (!ok.rowCount) return reply.code(400).send({ error: 'invalid_user' });
    }
    // Non-managers may only change the assignment they validated above: compare-and-set against a concurrent change.
    const upd = isManager(u)
      ? await db.query('UPDATE conversations SET assigned_to = $2 WHERE id = $1', [conv.id, target])
      : await db.query('UPDATE conversations SET assigned_to = $2 WHERE id = $1 AND assigned_to IS NOT DISTINCT FROM $3', [conv.id, target, conv.assigned_to]);
    if (!upd.rowCount) return reply.code(409).send({ error: 'conflict' });
    await audit(db, { actorId: u.id, action: 'conversation.assign', target: conv.id, ip: req.ip, meta: { to: target } });
    return { ok: true };
  });

  app.post('/conversations/:id/status', { preHandler: any }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = z.object({ status: z.enum(['open', 'closed']) }).safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    if (!(await loadAccessible(db, req.user!, p.data.id))) return reply.code(404).send({ error: 'not_found' });
    await db.query('UPDATE conversations SET status = $2 WHERE id = $1', [p.data.id, b.data.status]);
    return { ok: true };
  });

  // Internal notes: visible to staff who can access the conversation, never sent to the customer.
  app.get('/conversations/:id/notes', { preHandler: any }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    if (!(await loadAccessible(db, req.user!, p.data.id))) return reply.code(404).send({ error: 'not_found' });
    const { rows } = await db.query(
      `SELECT n.id, n.body, u.name AS "authorName", n.created_at AS "createdAt"
         FROM conversation_notes n LEFT JOIN users u ON u.id = n.author_id WHERE n.conversation_id = $1 ORDER BY n.created_at`,
      [p.data.id],
    );
    return rows;
  });

  app.post('/conversations/:id/notes', { preHandler: any }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = z.object({ body: z.string().trim().min(1).max(2000) }).safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    if (!(await loadAccessible(db, req.user!, p.data.id))) return reply.code(404).send({ error: 'not_found' });
    const { rows } = await db.query(
      `INSERT INTO conversation_notes (conversation_id, author_id, body) VALUES ($1,$2,$3)
       RETURNING id, body, created_at AS "createdAt"`,
      [p.data.id, req.user!.id, b.data.body],
    );
    return reply.code(201).send(rows[0]);
  });

  // Canned replies: everyone reads, supervisors/admins curate.
  const curators = requireAuth(db, ['admin', 'supervisor']);
  app.get('/canned-replies', { preHandler: any }, async () => {
    const { rows } = await db.query('SELECT id, title, body FROM canned_replies ORDER BY title');
    return rows;
  });
  app.post('/canned-replies', { preHandler: curators }, async (req, reply) => {
    const b = z.object({ title: z.string().trim().min(1).max(80), body: z.string().trim().min(1).max(4000) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const { rows } = await db.query('INSERT INTO canned_replies (title, body, created_by) VALUES ($1,$2,$3) RETURNING id, title, body', [
      b.data.title, b.data.body, req.user!.id,
    ]);
    return reply.code(201).send(rows[0]);
  });
  app.delete('/canned-replies/:id', { preHandler: curators }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const r = await db.query('DELETE FROM canned_replies WHERE id=$1', [p.data.id]);
    return r.rowCount ? { ok: true } : reply.code(404).send({ error: 'not_found' });
  });

  // Privacy: data-subject export / erasure for one contact (admin only, audited).
  const adminOnly = requireAuth(db, ['admin']);
  app.get('/contacts/:id/export', { preHandler: adminOnly }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const c = await db.query('SELECT id, channel_id, external_id, display_name, created_at FROM contacts WHERE id=$1', [p.data.id]);
    if (!c.rows[0]) return reply.code(404).send({ error: 'not_found' });
    const m = await db.query(
      `SELECT m.direction, m.body, m.created_at, a.file_name AS "attachmentName", a.status AS "attachmentStatus"
         FROM messages m JOIN conversations v ON v.id = m.conversation_id LEFT JOIN attachments a ON a.message_id = m.id
        WHERE v.contact_id = $1 ORDER BY m.created_at`,
      [p.data.id],
    );
    await audit(db, { actorId: req.user!.id, action: 'contact.export', target: p.data.id, ip: req.ip });
    return { contact: c.rows[0], messages: m.rows };
  });

  app.delete('/contacts/:id', { preHandler: adminOnly }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    await media.purgeFiles('v.contact_id = $1', [p.data.id]);
    const r = await db.query('DELETE FROM contacts WHERE id=$1', [p.data.id]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(db, { actorId: req.user!.id, action: 'contact.erase', target: p.data.id, ip: req.ip });
    return { ok: true };
  });
}

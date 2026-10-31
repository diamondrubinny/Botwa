import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { isManager, loadAccessible, sendBlock } from '../access.js';
import { requireAuth } from '../auth.js';
import type { ChannelManager } from '../channels/manager.js';
import { loadSending, PolicyRejected, SendError } from '../channels/sender.js';
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
        tag: z.string().uuid().optional(),
        id: z.string().uuid().optional(),
        blocked: z.enum(['true', 'false']).default('false'),
        mine: z.enum(['true', 'false']).optional(),
        snoozed: z.enum(['true', 'false']).default('false'),
        starred: z.enum(['true', 'false']).default('false'),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    const u = req.user!;
    const { rows } = await db.query(
      `SELECT c.id, c.channel_id AS "channelId", c.status, c.assigned_to AS "assignedTo", c.unread_count AS "unreadCount",
              c.last_message_at AS "lastMessageAt", ct.display_name AS "contactName", ct.external_id AS "contactId", ct.id AS "contactRowId", ct.blocked AS "blocked", ct.opted_out AS "optedOut", ct.blocked_reason AS "blockedReason",
              ch.label AS "channelLabel", c.last_message_at AS "lastActivity",
              c.bot_state AS "botState", c.snoozed_until AS "snoozedUntil",
              EXISTS (SELECT 1 FROM conversation_stars cs WHERE cs.conversation_id = c.id AND cs.user_id = $3) AS "starred",
              (SELECT CASE WHEN lm.direction = 'in' AND c.status = 'open' AND c.bot_state IS DISTINCT FROM 'menu' THEN lm.created_at END
                 FROM messages lm WHERE lm.conversation_id = c.id AND NOT lm.auto ORDER BY lm.created_at DESC LIMIT 1) AS "waitingSince",
              COALESCE((SELECT json_agg(json_build_object('id', t.id, 'name', t.name) ORDER BY lower(t.name)) FROM conversation_tags ctg JOIN tags t ON t.id = ctg.tag_id WHERE ctg.conversation_id = c.id), '[]'::json) AS tags, ch.type AS "channelType", au.name AS "assignedName",
              (SELECT COALESCE(NULLIF(m.body, ''), '[קובץ מצורף]') FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS "lastMessage"
         FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
              JOIN channels ch ON ch.id = c.channel_id LEFT JOIN users au ON au.id = c.assigned_to
        WHERE ($1::text IS NULL OR c.status = $1)
          AND ($2::boolean IS NOT TRUE OR c.assigned_to = $3)
          AND ($4::boolean OR c.assigned_to = $3 OR (c.assigned_to IS NULL AND c.bot_state IS DISTINCT FROM 'menu'))
          AND ($9::uuid IS NULL OR c.id = $9)
          AND ct.blocked = $10::boolean
          AND (($11::boolean AND c.snoozed_until > now()) OR (NOT $11::boolean AND (c.snoozed_until IS NULL OR c.snoozed_until <= now())))
          AND (NOT $12::boolean OR EXISTS (SELECT 1 FROM conversation_stars fs WHERE fs.conversation_id = c.id AND fs.user_id = $3))
          AND ($8::uuid IS NULL OR EXISTS (SELECT 1 FROM conversation_tags xt WHERE xt.conversation_id = c.id AND xt.tag_id = $8))
          AND ($7::text IS NULL OR ct.display_name ILIKE $7 OR ct.external_id ILIKE $7
               OR EXISTS (SELECT 1 FROM messages sm WHERE sm.conversation_id = c.id AND sm.body ILIKE $7))
        ORDER BY c.last_message_at DESC LIMIT $5 OFFSET $6`,
      [q.status ?? null, q.mine === 'true', u.id, isManager(u), q.limit, q.offset, q.q ? `%${q.q.replace(/[\\%_]/g, '\\$&')}%` : null, q.tag ?? null, q.id ?? null, q.blocked === 'true' && isManager(u), q.snoozed === 'true', q.starred === 'true'],
    );
    return rows;
  });

  // Total unread customer messages in open conversations the caller may see (badge on the navigation / app icon).
  app.get('/conversations/unread', { preHandler: any }, async (req) => {
    const u = req.user!;
    const { rows } = await db.query(
      `SELECT COALESCE(sum(c.unread_count), 0)::int AS count
         FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
        WHERE c.status = 'open' AND NOT ct.blocked AND (c.snoozed_until IS NULL OR c.snoozed_until <= now())
          AND ($1::boolean OR c.assigned_to = $2 OR (c.assigned_to IS NULL AND c.bot_state IS DISTINCT FROM 'menu'))`,
      [isManager(u), u.id],
    );
    return { count: rows[0].count as number };
  });

  app.get('/conversations/:id/messages', { preHandler: any }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.string().datetime().optional(), q: z.string().trim().min(1).max(100).optional() }).safeParse(req.query);
    if (!p.success || !q.success) return reply.code(400).send({ error: 'bad_request' });
    if (!(await loadAccessible(db, req.user!, p.data.id))) return reply.code(404).send({ error: 'not_found' });
    const { rows } = await db.query(
      `SELECT m.id, m.direction, m.body, m.sender_user_id AS "senderUserId", u.name AS "senderName", m.created_at AS "createdAt", m.auto,
              CASE WHEN a.id IS NULL THEN NULL ELSE json_build_object('id', a.id, 'kind', a.kind, 'mime', a.mime, 'size', a.size,
                'fileName', a.file_name, 'status', a.status, 'detail', a.detail) END AS attachment
         FROM messages m LEFT JOIN users u ON u.id = m.sender_user_id LEFT JOIN attachments a ON a.message_id = m.id
        WHERE m.conversation_id = $1 AND ($2::timestamptz IS NULL OR m.created_at < $2)
          AND ($4::text IS NULL OR m.body ILIKE $4 OR a.file_name ILIKE $4)
        ORDER BY m.created_at DESC LIMIT $3`,
      [p.data.id, q.data.before ?? null, q.data.limit, q.data.q ? `%${q.data.q.replace(/[\\%_]/g, '\\$&')}%` : null],
    );
    return rows.reverse();
  });

  // Same customer on other channels: contacts sharing a phone number (WhatsApp ids look like <digits>@s.whatsapp.net).
  // Only conversations the caller may access are returned.
  app.get('/conversations/:id/related', { preHandler: any }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const u = req.user!;
    if (!(await loadAccessible(db, u, p.data.id))) return reply.code(404).send({ error: 'not_found' });
    const { rows } = await db.query(
      `WITH me AS (
         SELECT regexp_replace(split_part(ct.external_id, '@', 1), '\D', '', 'g') AS phone
           FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
          WHERE c.id = $1 AND ct.external_id LIKE '%@s.whatsapp.net'
       )
       SELECT c.id, c.status, c.last_message_at AS "lastMessageAt", ch.label AS "channelLabel", ch.type AS "channelType",
              ct.display_name AS "contactName", au.name AS "assignedName",
              (SELECT COALESCE(NULLIF(m.body, ''), '[קובץ מצורף]') FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS "lastMessage"
         FROM me, conversations c
         JOIN contacts ct ON ct.id = c.contact_id JOIN channels ch ON ch.id = c.channel_id LEFT JOIN users au ON au.id = c.assigned_to
        WHERE c.id <> $1 AND ct.external_id LIKE '%@s.whatsapp.net' AND me.phone <> ''
          AND regexp_replace(split_part(ct.external_id, '@', 1), '\D', '', 'g') = me.phone
          AND ($2::boolean OR c.assigned_to IS NULL OR c.assigned_to = $3)
        ORDER BY c.last_message_at DESC LIMIT 20`,
      [p.data.id, isManager(u), u.id],
    );
    return rows;
  });

  app.post('/conversations/:id/read', { preHandler: any }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const conv = await loadAccessible(db, req.user!, p.data.id);
    if (!conv) return reply.code(404).send({ error: 'not_found' });
    await db.query('UPDATE conversations SET unread_count = 0 WHERE id = $1', [p.data.id]);
    if (!conv.blocked) await mgr.markRead(conv.channel_id, conv.id, conv.external_id); // "seen" receipts, like a person opening the chat
    return { ok: true };
  });

  app.post('/conversations/:id/messages', { preHandler: any, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = z.object({ text: z.string().trim().min(1).max(4000) }).safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    const u = req.user!;
    const conv = await loadAccessible(db, u, p.data.id);
    if (!conv) return reply.code(404).send({ error: 'not_found' });
    const blockedBy = await sendBlock(db, conv, (await loadSending(db)).replyWindowHours);
    if (blockedBy) return reply.code(409).send({ error: blockedBy });
    let sent: { externalMessageId?: string };
    try {
      sent = await mgr.sendText(conv.channel_id, conv.external_id, b.data.text);
    } catch (e) {
      if ((e as Error).message === 'channel_not_connected') return reply.code(409).send({ error: 'channel_not_connected' });
      if (e instanceof SendError) return reply.code(429).send({ error: e.code });
      if (e instanceof PolicyRejected) return reply.code(409).send({ error: e.code });
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
      `UPDATE conversations SET last_message_at = now(), assigned_to = COALESCE(assigned_to, $2), bot_state = 'human' WHERE id = $1`,
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
    if (target) await db.query(`UPDATE conversations SET bot_state = 'human' WHERE id = $1`, [conv.id]);
    await audit(db, { actorId: u.id, action: 'conversation.assign', target: conv.id, ip: req.ip, meta: { to: target } });
    return { ok: true };
  });

  app.post('/conversations/:id/status', { preHandler: any }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = z.object({ status: z.enum(['open', 'closed']) }).safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    if (!(await loadAccessible(db, req.user!, p.data.id))) return reply.code(404).send({ error: 'not_found' });
    await db.query(
      `UPDATE conversations SET status = $2, bot_state = CASE WHEN $2 = 'closed' THEN NULL ELSE bot_state END, bot_invalid = CASE WHEN $2 = 'closed' THEN 0 ELSE bot_invalid END WHERE id = $1`,
      [p.data.id, b.data.status],
    );
    return { ok: true };
  });

  // Snooze: hide until a time (minutes from now, max 30 days) or wake now with minutes = 0. A new customer message wakes it automatically.
  app.post('/conversations/:id/snooze', { preHandler: any }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = z.object({ minutes: z.number().int().min(0).max(43200) }).safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    if (!(await loadAccessible(db, req.user!, p.data.id))) return reply.code(404).send({ error: 'not_found' });
    const { rows } = await db.query(
      `UPDATE conversations SET snoozed_until = CASE WHEN $2 = 0 THEN NULL ELSE now() + make_interval(mins => $2) END WHERE id = $1 RETURNING snoozed_until AS "snoozedUntil"`,
      [p.data.id, b.data.minutes],
    );
    return rows[0];
  });

  // Personal star (visible only to the person who set it).
  app.post('/conversations/:id/star', { preHandler: any }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = z.object({ starred: z.boolean() }).safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    if (!(await loadAccessible(db, req.user!, p.data.id))) return reply.code(404).send({ error: 'not_found' });
    if (b.data.starred) await db.query('INSERT INTO conversation_stars (user_id, conversation_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.user!.id, p.data.id]);
    else await db.query('DELETE FROM conversation_stars WHERE user_id = $1 AND conversation_id = $2', [req.user!.id, p.data.id]);
    return { starred: b.data.starred };
  });

  // "Mark as unread": bring the conversation back to the top of attention (shared counter, like the customer wrote again).
  app.post('/conversations/:id/unread', { preHandler: any }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    if (!(await loadAccessible(db, req.user!, p.data.id))) return reply.code(404).send({ error: 'not_found' });
    await db.query('UPDATE conversations SET unread_count = GREATEST(unread_count, 1) WHERE id = $1', [p.data.id]);
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
  const curators = requireAuth(db, 'canned.manage');
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
  const adminOnly = requireAuth(db, 'privacy.manage');
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

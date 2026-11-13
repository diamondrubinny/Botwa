import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { isManager, loadAccessible, sendBlock } from '../access.js';
import { requireAuth } from '../auth.js';
import { learnFromStaff } from '../learn.js';
import { CANNED_VARIABLES, renderCanned, unknownVariables } from '../canned.js';
import { loadBusinessHours } from './settings.js';
import type { ChannelManager } from '../channels/manager.js';
import { loadSending, PolicyRejected, SendError } from '../channels/sender.js';
import type { Db } from '../db.js';
import { MediaService } from '../media/store.js';
import { isCommentContact } from '../channels/meta-messaging.js';
import { askFeedback, sendClosingMessage } from '../automations.js';
import { isSingleEmoji } from '../bot.js';

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
        bot: z.enum(['true', 'false']).default('false'),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    const u = req.user!;
    const { rows } = await db.query(
      `SELECT c.id, c.channel_id AS "channelId", c.status, c.assigned_to AS "assignedTo", c.unread_count AS "unreadCount",
              c.last_message_at AS "lastMessageAt", ct.display_name AS "contactName", ct.external_id AS "contactId", ct.id AS "contactRowId", ct.blocked AS "blocked", ct.opted_out AS "optedOut", ct.blocked_reason AS "blockedReason",
              ch.label AS "channelLabel", c.last_message_at AS "lastActivity",
              c.bot_state AS "botState", c.snoozed_until AS "snoozedUntil", c.assigned_at AS "assignedAt",
              EXISTS (SELECT 1 FROM conversation_stars cs WHERE cs.conversation_id = c.id AND cs.user_id = $3) AS "starred",
              (SELECT CASE WHEN lm.direction = 'in' AND c.status = 'open' AND c.bot_state IS DISTINCT FROM 'menu' THEN lm.created_at END
                 FROM messages lm WHERE lm.conversation_id = c.id AND NOT lm.auto ORDER BY lm.created_at DESC LIMIT 1) AS "waitingSince",
              COALESCE((SELECT json_agg(json_build_object('id', t.id, 'name', t.name) ORDER BY lower(t.name)) FROM conversation_tags ctg JOIN tags t ON t.id = ctg.tag_id WHERE ctg.conversation_id = c.id), '[]'::json) AS tags, ch.type AS "channelType", COALESCE(au.name_he, au.name) AS "assignedName",
              (SELECT COALESCE(NULLIF(m.body, ''), '[קובץ מצורף]') FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS "lastMessage"
         FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
              JOIN channels ch ON ch.id = c.channel_id LEFT JOIN users au ON au.id = c.assigned_to
        WHERE ($1::text IS NULL OR c.status = $1)
          AND ($2::boolean IS NOT TRUE OR c.assigned_to = $3)
          AND ($4::boolean OR c.assigned_to = $3 OR (c.assigned_to IS NULL AND c.bot_state IS DISTINCT FROM 'menu'))
          AND ($9::uuid IS NULL OR c.id = $9)
          AND ct.blocked = $10::boolean
          AND (($11::boolean AND c.snoozed_until > now()) OR (NOT $11::boolean AND (c.snoozed_until IS NULL OR c.snoozed_until <= now())))
          AND (NOT $13::boolean OR c.bot_state IN ('menu', 'area'))
          AND (NOT $12::boolean OR EXISTS (SELECT 1 FROM conversation_stars fs WHERE fs.conversation_id = c.id AND fs.user_id = $3))
          AND ($8::uuid IS NULL OR EXISTS (SELECT 1 FROM conversation_tags xt WHERE xt.conversation_id = c.id AND xt.tag_id = $8))
          AND ($7::text IS NULL OR ct.display_name ILIKE $7 OR ct.external_id ILIKE $7
               OR EXISTS (SELECT 1 FROM messages sm WHERE sm.conversation_id = c.id AND sm.body ILIKE $7))
        ORDER BY c.last_message_at DESC LIMIT $5 OFFSET $6`,
      [q.status ?? null, q.mine === 'true', u.id, isManager(u), q.limit, q.offset, q.q ? `%${q.q.replace(/[\\%_]/g, '\\$&')}%` : null, q.tag ?? null, q.id ?? null, q.blocked === 'true' && isManager(u), q.snoozed === 'true', q.starred === 'true', q.bot === 'true'],
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
      `SELECT m.id, m.direction, m.body, m.sender_user_id AS "senderUserId", COALESCE(u.name_he, u.name) AS "senderName", m.created_at AS "createdAt", m.auto, m.reply_mode AS "replyMode",
              m.our_reaction AS "ourReaction", CASE WHEN m.our_reaction IS NULL THEN NULL ELSE COALESCE(ru.name_he, ru.name, 'אוטומטית') END AS "ourReactionBy",
              CASE WHEN a.id IS NULL THEN NULL ELSE json_build_object('id', a.id, 'kind', a.kind, 'mime', a.mime, 'size', a.size,
                'fileName', a.file_name, 'status', a.status, 'detail', a.detail) END AS attachment
         FROM messages m LEFT JOIN users u ON u.id = m.sender_user_id LEFT JOIN users ru ON ru.id = m.our_reaction_by LEFT JOIN attachments a ON a.message_id = m.id
        WHERE m.conversation_id = $1 AND ($2::timestamptz IS NULL OR m.created_at < $2)
          AND ($4::text IS NULL OR m.body ILIKE $4 OR a.file_name ILIKE $4)
        ORDER BY m.created_at DESC LIMIT $3`,
      [p.data.id, q.data.before ?? null, q.data.limit, q.data.q ? `%${q.data.q.replace(/[\\%_]/g, '\\$&')}%` : null],
    );
    return rows.reverse();
  });

  // Same customer on other channels: contacts sharing a phone number (WhatsApp ids look like <digits>@s.whatsapp.net).
  // Only conversations the caller may access are returned.
  app.post('/conversations/:id/read', { preHandler: any }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const conv = await loadAccessible(db, req.user!, p.data.id);
    if (!conv) return reply.code(404).send({ error: 'not_found' });
    await db.query('UPDATE conversations SET unread_count = 0 WHERE id = $1', [p.data.id]);
    if (!conv.blocked) await mgr.markRead(conv.channel_id, conv.id, conv.external_id); // "seen" receipts, like a person opening the chat
    return { ok: true };
  });

  // Our emoji on one of the customer's messages (empty removes it). Sent to the platform where it has reactions.
  app.post('/conversations/:id/messages/:messageId/reaction', { preHandler: any, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = z.object({ id: z.string().uuid(), messageId: z.string().uuid() }).safeParse(req.params);
    const b = z.object({ emoji: z.string().refine(isSingleEmoji) }).safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    const conv = await loadAccessible(db, req.user!, p.data.id);
    if (!conv) return reply.code(404).send({ error: 'not_found' });
    const owns = (await db.query(`SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $2 AND direction = 'in'`, [p.data.messageId, conv.id])).rowCount;
    if (!owns) return reply.code(404).send({ error: 'not_found' });
    const blockedBy = await sendBlock(db, conv, (await loadSending(db)).replyWindowHours);
    if (blockedBy) return reply.code(409).send({ error: blockedBy });
    const out = await mgr.setOurReaction(p.data.messageId, b.data.emoji, req.user!.id);
    if (out === 'ok') return { ok: true, emoji: b.data.emoji || null };
    if (out === 'not_found') return reply.code(404).send({ error: 'not_found' });
    return reply.code(409).send({ error: out === 'no_support' ? 'reaction_not_supported' : out === 'error' ? 'reaction_failed' : `reaction_${out}` });
  });

  app.post('/conversations/:id/messages', { preHandler: any, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = z.object({ text: z.string().trim().min(1).max(4000), commentReply: z.enum(['public', 'private']).optional() }).safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    const u = req.user!;
    const conv = await loadAccessible(db, u, p.data.id);
    if (!conv) return reply.code(404).send({ error: 'not_found' });
    // a public comment thread: the person must choose, every time, whether the answer is public or private
    const comment = isCommentContact(conv.external_id);
    if (comment && !b.data.commentReply) return reply.code(400).send({ error: 'comment_reply_mode_required' });
    const blockedBy = await sendBlock(db, conv, (await loadSending(db)).replyWindowHours);
    if (blockedBy) return reply.code(409).send({ error: blockedBy });
    let sent: { externalMessageId?: string };
    try {
      if (comment) {
        const target = (await db.query(`SELECT external_id FROM messages WHERE conversation_id = $1 AND direction = 'in' AND external_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [conv.id])).rows[0]?.external_id as string | undefined;
        if (!target) return reply.code(409).send({ error: 'comment_not_found' });
        sent = await mgr.replyComment(conv.channel_id, target, b.data.text, b.data.commentReply!);
        await audit(db, { actorId: u.id, action: `comment.reply_${b.data.commentReply}`, target: conv.id, ip: req.ip });
      } else {
        sent = await mgr.sendText(conv.channel_id, conv.external_id, b.data.text);
      }
    } catch (e) {
      if ((e as Error).message === 'channel_not_connected') return reply.code(409).send({ error: 'channel_not_connected' });
      if (e instanceof SendError) return reply.code(429).send({ error: e.code });
      if (e instanceof PolicyRejected) return reply.code(409).send({ error: e.code });
      req.log.error({ err: e }, 'send failed');
      return reply.code(502).send({ error: 'send_failed' });
    }
    const { rows } = await db.query(
      `INSERT INTO messages (conversation_id, direction, body, external_id, sender_user_id, reply_mode) VALUES ($1,'out',$2,$3,$4,$5)
       RETURNING id, direction, body, created_at AS "createdAt", reply_mode AS "replyMode"`,
      [conv.id, b.data.text, sent.externalMessageId ?? null, u.id, comment ? b.data.commentReply : null],
    );
    mgr.notifyMessage(conv.channel_id, conv.id, rows[0].id);
    mgr.hookMessage('message.sent', conv.id, rows[0].id);
    if (!comment) void learnFromStaff(db, mgr.kb, conv.id, b.data.text).catch(() => undefined);   // a question the bot could not answer: a draft FAQ for approval
    // Replying claims an unassigned conversation.
    await db.query(
      `UPDATE conversations SET last_message_at = now(), assigned_to = COALESCE(assigned_to, $2), bot_state = 'human' WHERE id = $1`,
      [conv.id, u.id],
    );
    return reply.code(201).send(rows[0]);
  });

  // Hide the customer's latest comment from the public (e.g. it exposes personal details). Audited.
  app.post('/conversations/:id/comment/hide', { preHandler: any, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const conv = await loadAccessible(db, req.user!, p.data.id);
    if (!conv || !isCommentContact(conv.external_id)) return reply.code(404).send({ error: 'not_found' });
    const target = (await db.query(`SELECT external_id FROM messages WHERE conversation_id = $1 AND direction = 'in' AND external_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [conv.id])).rows[0]?.external_id as string | undefined;
    const a = mgr.metaAdapter(conv.channel_id);
    if (!target || !a) return reply.code(409).send({ error: !a ? 'channel_not_connected' : 'comment_not_found' });
    try { await a.hideComment(target); } catch { return reply.code(502).send({ error: 'comment_hide_failed' }); }
    await db.query(`INSERT INTO conversation_notes (conversation_id, author_id, body) VALUES ($1, $2, 'התגובה הוסתרה מהציבור.')`, [conv.id, req.user!.id]).catch(() => undefined);
    await audit(db, { actorId: req.user!.id, action: 'comment.hide', target: conv.id, ip: req.ip });
    return { ok: true };
  });

  // Colleagues a conversation can be handed to (id + name only; the full user list needs users.view).
  app.get('/handover-targets', { preHandler: any }, async (req) => {
    const { rows } = await db.query('SELECT id, name, username FROM users WHERE active AND id <> $1 ORDER BY lower(name)', [req.user!.id]);
    return rows;
  });

  app.post('/conversations/:id/assign', { preHandler: any }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = z.object({ userId: z.string().uuid().nullable(), note: z.string().trim().max(1000).optional() }).safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    const u = req.user!;
    const conv = await loadAccessible(db, u, p.data.id);
    if (!conv) return reply.code(404).send({ error: 'not_found' });
    const target = b.data.userId;
    // A handover = moving a conversation that someone already holds to a different person. It needs a note so the next agent has context.
    const handover = target !== null && conv.assigned_to !== null && conv.assigned_to !== target;
    if (!isManager(u)) {
      const claim = target === u.id && conv.assigned_to === null;
      const release = target === null && conv.assigned_to === u.id;
      const handOff = handover && conv.assigned_to === u.id;   // the current holder may hand over to a colleague
      if (!claim && !release && !handOff) return reply.code(403).send({ error: 'forbidden' });
    }
    if (handover && !b.data.note) return reply.code(400).send({ error: 'note_required' });
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
    if (handover) {
      const names = await db.query('SELECT id, name FROM users WHERE id = ANY($1::uuid[])', [[conv.assigned_to, target]]);
      const nm = (id: string | null) => (names.rows.find((r) => r.id === id)?.name as string | undefined) ?? 'משתמש';
      await db.query(`INSERT INTO conversation_notes (conversation_id, author_id, body) VALUES ($1,$2,$3)`,
        [conv.id, u.id, `↪ הועברה מ${nm(conv.assigned_to)} אל ${nm(target)}: ${b.data.note}`]);
    }
    await audit(db, { actorId: u.id, action: handover ? 'conversation.handover' : 'conversation.assign', target: conv.id, ip: req.ip, meta: { to: target, from: handover ? conv.assigned_to : undefined } });
    mgr.hookConversation('conversation.assigned', conv.id);
    if (target && target !== u.id) mgr.onAssigned?.(conv.id, target, handover ? 'handover' : 'assigned');
    const introduced = target ? await mgr.introduce(conv.id) : false;   // "שלום, כאן <name>, <role>. אני אטפל בפנייתך"
    return { ok: true, introduced };
  });

  app.post('/conversations/:id/status', { preHandler: any }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = z.object({ status: z.enum(['open', 'closed']), closingMessage: z.boolean().optional() }).safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    if (!(await loadAccessible(db, req.user!, p.data.id))) return reply.code(404).send({ error: 'not_found' });
    // the closing message goes out before the status changes (a closed conversation is still the same chat for the customer)
    const closingSent = b.data.status === 'closed' && b.data.closingMessage ? await sendClosingMessage(db, mgr, p.data.id) : undefined;
    await db.query(
      `UPDATE conversations SET status = $2, close_kind = CASE WHEN $2 = 'closed' THEN 'staff' ELSE close_kind END, closed_by = CASE WHEN $2 = 'closed' THEN $3::uuid ELSE closed_by END,
              bot_state = CASE WHEN $2 = 'closed' THEN NULL ELSE bot_state END, flow_state = CASE WHEN $2 = 'closed' THEN NULL ELSE flow_state END, bot_invalid = CASE WHEN $2 = 'closed' THEN 0 ELSE bot_invalid END WHERE id = $1`,
      [p.data.id, b.data.status, req.user!.id],
    );
    if (b.data.status === 'closed') await askFeedback(db, mgr, p.data.id, 'staff').catch(() => false);
    mgr.hookConversation('conversation.status_changed', p.data.id);
    return { ok: true, ...(closingSent !== undefined ? { closingSent } : {}) };
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

  // Canned replies: everyone reads, supervisors/admins curate. Variables ({שם} {נציג} {שעות} {תאריך} {ערוץ}) are filled when one is used.
  const curators = requireAuth(db, 'canned.manage');
  const cannedBody = z.object({ title: z.string().trim().min(1).max(80), body: z.string().trim().min(1).max(4000), folder: z.string().trim().max(40).default('') });
  app.get('/canned-replies', { preHandler: any }, async () => {
    const { rows } = await db.query('SELECT id, title, body, folder FROM canned_replies ORDER BY folder = \'\', lower(folder), lower(title)');
    return rows;
  });
  app.get('/canned-replies/variables', { preHandler: any }, async () => CANNED_VARIABLES.map(([name, meaning]) => ({ name, meaning })));
  app.post('/canned-replies', { preHandler: curators }, async (req, reply) => {
    const b = cannedBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const { rows } = await db.query('INSERT INTO canned_replies (title, body, folder, created_by) VALUES ($1,$2,$3,$4) RETURNING id, title, body, folder', [b.data.title, b.data.body, b.data.folder, req.user!.id]);
    return reply.code(201).send({ ...rows[0], unknownVariables: unknownVariables(b.data.body) });
  });
  app.put('/canned-replies/:id', { preHandler: curators }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = cannedBody.safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    const r = await db.query('UPDATE canned_replies SET title=$2, body=$3, folder=$4, updated_at=now() WHERE id=$1 RETURNING id, title, body, folder', [p.data.id, b.data.title, b.data.body, b.data.folder]);
    if (!r.rows[0]) return reply.code(404).send({ error: 'not_found' });
    await audit(db, { actorId: req.user!.id, action: 'canned.update', target: p.data.id, ip: req.ip });
    return { ...r.rows[0], unknownVariables: unknownVariables(b.data.body) };
  });
  app.delete('/canned-replies/:id', { preHandler: curators }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const r = await db.query('DELETE FROM canned_replies WHERE id=$1', [p.data.id]);
    return r.rowCount ? { ok: true } : reply.code(404).send({ error: 'not_found' });
  });
  /** A canned reply with its variables filled for this conversation and the person sending it. */
  app.post('/canned-replies/:id/render', { preHandler: any, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = z.object({ conversationId: z.string().uuid() }).safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    const conv = await loadAccessible(db, req.user!, b.data.conversationId);
    if (!conv) return reply.code(404).send({ error: 'not_found' });
    const c = (await db.query('SELECT body FROM canned_replies WHERE id = $1', [p.data.id])).rows[0];
    if (!c) return reply.code(404).send({ error: 'not_found' });
    const info = (await db.query(`SELECT ct.display_name AS name, ch.label FROM conversations v JOIN contacts ct ON ct.id = v.contact_id JOIN channels ch ON ch.id = v.channel_id WHERE v.id = $1`, [conv.id])).rows[0];
    const me = (await db.query('SELECT job_title, intro_phone, name_he FROM users WHERE id = $1', [req.user!.id])).rows[0];
    return { text: renderCanned(c.body, { customerName: info?.name, agentName: me?.name_he || req.user!.name, agentTitle: me?.job_title, agentPhone: me?.intro_phone, hours: await loadBusinessHours(db), channelLabel: info?.label }) };
  });

  // Privacy: data-subject export / erasure for one contact (admin only, audited).
  const adminOnly = requireAuth(db, 'privacy.manage');
  app.get('/contacts/:id/export', { preHandler: adminOnly }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const fields = 'id, channel_id, external_id, display_name, profile, claimed_phone, claimed_email, person_id, created_at';
    const c = await db.query(`SELECT ${fields} FROM contacts WHERE id=$1`, [p.data.id]);
    if (!c.rows[0]) return reply.code(404).send({ error: 'not_found' });
    const msgs = async (contactId: string) => (await db.query(
      `SELECT m.direction, m.body, m.created_at, a.file_name AS "attachmentName", a.status AS "attachmentStatus"
         FROM messages m JOIN conversations v ON v.id = m.conversation_id LEFT JOIN attachments a ON a.message_id = m.id
        WHERE v.contact_id = $1 ORDER BY m.created_at`,
      [contactId],
    )).rows;
    // the same person on other channels (contacts staff linked): their data belongs in the same request
    const linked = c.rows[0].person_id ? (await db.query(`SELECT ${fields} FROM contacts WHERE person_id = $1 AND id <> $2`, [c.rows[0].person_id, p.data.id])).rows : [];
    await audit(db, { actorId: req.user!.id, action: 'contact.export', target: p.data.id, ip: req.ip, meta: { linked: linked.length } });
    return { contact: c.rows[0], messages: await msgs(p.data.id), linkedContacts: await Promise.all(linked.map(async (l) => ({ contact: l, messages: await msgs(l.id) }))) };
  });

  app.delete('/contacts/:id', { preHandler: adminOnly }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    // ?linked=true: the same person on every linked channel too (one erasure request covers the person)
    const withLinked = (req.query as { linked?: string }).linked === 'true';
    const cur = (await db.query('SELECT person_id FROM contacts WHERE id = $1', [p.data.id])).rows[0];
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    const ids: string[] = withLinked && cur.person_id ? (await db.query('SELECT id FROM contacts WHERE person_id = $1', [cur.person_id])).rows.map((r) => r.id) : [p.data.id];
    await media.purgeFiles('v.contact_id = ANY($1::uuid[])', [ids]);
    const r = await db.query('DELETE FROM contacts WHERE id = ANY($1::uuid[])', [ids]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    if (cur.person_id && !withLinked) await db.query('UPDATE contacts SET person_id = NULL WHERE person_id = $1 AND (SELECT count(*) FROM contacts WHERE person_id = $1) = 1', [cur.person_id]);
    await audit(db, { actorId: req.user!.id, action: 'contact.erase', target: p.data.id, ip: req.ip, meta: { contacts: ids.length } });
    return { ok: true, erased: ids.length };
  });
}

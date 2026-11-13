import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isManager, loadAccessible } from '../access.js';
import { audit } from '../audit.js';
import { requireAuth } from '../auth.js';
import { EMAIL_OF, PHONE_OF } from '../contacts/identity.js';
import type { Db } from '../db.js';

const idParam = z.object({ id: z.string().uuid() });
const MAX_GROUP = 20;
/** an agent sees conversations assigned to them or unassigned; managers see all (same rule as the inbox) */
const VISIBLE = (t: string) => `($2::boolean OR ${t}.assigned_to IS NULL OR ${t}.assigned_to = $3)`;

const ROW = `c.id, c.status, c.last_message_at AS "lastMessageAt", ch.label AS "channelLabel", ch.type AS "channelType",
  ct.id AS "contactRowId", ct.display_name AS "contactName", au.name AS "assignedName",
  (SELECT COALESCE(NULLIF(m.body, ''), '[קובץ מצורף]') FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS "lastMessage"`;
const JOINS = `JOIN contacts ct ON ct.id = c.contact_id JOIN channels ch ON ch.id = c.channel_id LEFT JOIN users au ON au.id = c.assigned_to`;

/**
 * One person across channels. Two kinds of connection:
 *  - linked: staff joined the contacts (person_id), or both are WhatsApp ids with the same number (verified by WhatsApp)
 *  - suggested: the same phone or e-mail that a customer TYPED (unverified): shown only as a suggestion that a person confirms,
 *    because a wrong link would show one person's history next to another's.
 */
export function peopleRoutes(app: FastifyInstance, db: Db) {
  const any = requireAuth(db);

  /** may this user act on this contact? through its conversation's access rule; a contact without a conversation: managers only */
  async function mayUse(req: FastifyRequest, contactId: string): Promise<boolean> {
    const conv = (await db.query('SELECT id FROM conversations WHERE contact_id = $1', [contactId])).rows[0];
    if (!conv) return isManager(req.user!) && (await db.query('SELECT 1 FROM contacts WHERE id = $1', [contactId])).rowCount === 1;
    return !!(await loadAccessible(db, req.user!, conv.id));
  }

  app.get('/conversations/:id/related', { preHandler: any }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const u = req.user!;
    if (!(await loadAccessible(db, u, p.data.id))) return reply.code(404).send({ error: 'not_found' });
    const { rows } = await db.query(
      `WITH me AS (SELECT ct.id, ct.person_id, ct.external_id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = $1)
       SELECT ${ROW}, CASE WHEN ct.person_id IS NOT NULL AND ct.person_id = me.person_id THEN 'linked' ELSE 'same_phone' END AS reason
         FROM me, conversations c ${JOINS}
        WHERE c.id <> $1 AND ${VISIBLE('c')}
          AND ((me.person_id IS NOT NULL AND ct.person_id = me.person_id)
            OR (me.external_id LIKE '%@s.whatsapp.net' AND ct.external_id LIKE '%@s.whatsapp.net'
                AND split_part(ct.external_id, '@', 1) = split_part(me.external_id, '@', 1)))
        ORDER BY c.last_message_at DESC LIMIT 20`,
      [p.data.id, isManager(u), u.id],
    );
    return rows;
  });

  /**
   * The customer's inquiries: every case of this conversation and of the same person's other conversations (linked contacts, or
   * the same WhatsApp number), newest first, only from conversations this user may open.
   */
  app.get('/conversations/:id/cases', { preHandler: any }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const u = req.user!;
    if (!(await loadAccessible(db, u, p.data.id))) return reply.code(404).send({ error: 'not_found' });
    const { rows } = await db.query(
      `WITH me AS (SELECT ct.id, ct.person_id, ct.external_id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = $1),
       convs AS (
         SELECT c.id FROM me, conversations c JOIN contacts ct ON ct.id = c.contact_id
          WHERE (c.id = $1 OR (me.person_id IS NOT NULL AND ct.person_id = me.person_id)
                 OR (me.external_id LIKE '%@s.whatsapp.net' AND ct.external_id LIKE '%@s.whatsapp.net' AND split_part(ct.external_id, '@', 1) = split_part(me.external_id, '@', 1)))
            AND ${VISIBLE('c')})
       SELECT k.id, k.number, k.conversation_id AS "conversationId", k.opened_at AS "openedAt", k.closed_at AS "closedAt", k.close_kind AS "closeKind",
              k.first_message AS "firstMessage", k.rating, cb.name AS "closedByName", au.name AS "assignedName", ch.label AS "channelLabel", ch.type AS "channelType",
              (SELECT count(*)::int FROM messages m WHERE m.conversation_id = k.conversation_id AND m.created_at >= k.opened_at - interval '1 second' AND (k.closed_at IS NULL OR m.created_at <= k.closed_at)) AS messages
         FROM cases k JOIN convs ON convs.id = k.conversation_id JOIN conversations c ON c.id = k.conversation_id JOIN channels ch ON ch.id = c.channel_id
         LEFT JOIN users cb ON cb.id = k.closed_by LEFT JOIN users au ON au.id = COALESCE(k.assigned_to, CASE WHEN k.closed_at IS NULL THEN c.assigned_to END)
        ORDER BY k.opened_at DESC LIMIT 100`,
      [p.data.id, isManager(u), u.id],
    );
    return rows;
  });

  // the messages of one past inquiry (read-only view)
  app.get('/cases/:id/messages', { preHandler: any }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const k = (await db.query('SELECT conversation_id, opened_at, closed_at FROM cases WHERE id = $1', [p.data.id])).rows[0];
    if (!k || !(await loadAccessible(db, req.user!, k.conversation_id))) return reply.code(404).send({ error: 'not_found' });
    const { rows } = await db.query(
      `SELECT m.id, m.direction, m.body, m.created_at AS "createdAt", m.auto, u.name AS "senderName"
         FROM messages m LEFT JOIN users u ON u.id = m.sender_user_id
        WHERE m.conversation_id = $1 AND m.created_at >= $2::timestamptz - interval '1 second' AND ($3::timestamptz IS NULL OR m.created_at <= $3::timestamptz + interval '1 second')
        ORDER BY m.created_at LIMIT 500`,
      [k.conversation_id, k.opened_at, k.closed_at],
    );
    return rows;
  });

  // other conversations whose typed-in phone or e-mail matches this one: suggestions to link, never linked automatically
  app.get('/conversations/:id/link-suggestions', { preHandler: any }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const u = req.user!;
    if (!(await loadAccessible(db, u, p.data.id))) return reply.code(404).send({ error: 'not_found' });
    const { rows } = await db.query(
      `WITH me AS (SELECT ct.id, ct.person_id, ${PHONE_OF('ct')} AS phone, ${EMAIL_OF('ct')} AS email, ct.claimed_phone, ct.external_id
                     FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = $1)
       SELECT ${ROW}, CASE WHEN me.email IS NOT NULL AND ${EMAIL_OF('ct')} = me.email THEN 'email' ELSE 'phone' END AS reason
         FROM me, conversations c ${JOINS}
        WHERE c.id <> $1 AND ct.id <> me.id AND ${VISIBLE('c')}
          AND (me.person_id IS NULL OR ct.person_id IS DISTINCT FROM me.person_id)
          AND NOT (me.external_id LIKE '%@s.whatsapp.net' AND ct.external_id LIKE '%@s.whatsapp.net' AND split_part(ct.external_id, '@', 1) = split_part(me.external_id, '@', 1))
          AND ((me.email IS NOT NULL AND ${EMAIL_OF('ct')} = me.email)
            OR (me.phone IS NOT NULL AND ${PHONE_OF('ct')} = me.phone AND (me.claimed_phone IS NOT NULL OR ct.claimed_phone IS NOT NULL)))
        ORDER BY c.last_message_at DESC LIMIT 10`,
      [p.data.id, isManager(u), u.id],
    );
    return rows;
  });

  // find a contact to link by hand (name, number or e-mail), among the conversations this user may see
  app.get('/contacts/search', { preHandler: any, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const q = z.object({ q: z.string().trim().min(2).max(60), not: z.string().uuid().optional() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'bad_request' });
    const u = req.user!;
    const like = `%${q.data.q.replace(/[\\%_]/g, '\\$&')}%`;
    const digits = q.data.q.replace(/\D/g, '');
    const { rows } = await db.query(
      `SELECT ${ROW} FROM conversations c ${JOINS}
        WHERE ${VISIBLE('c')} AND ($5::uuid IS NULL OR c.id <> $5)
          AND (ct.display_name ILIKE $1 OR ${EMAIL_OF('ct')} LIKE lower($1) OR ($4 <> '' AND length($4) >= 4 AND (${PHONE_OF('ct')} LIKE '%' || $4 || '%')))
        ORDER BY c.last_message_at DESC LIMIT 15`,
      [like, isManager(u), u.id, digits, q.data.not ?? null],
    );
    return rows;
  });

  app.post('/contacts/:id/link', { preHandler: any, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = z.object({ with: z.string().uuid() }).safeParse(req.body);
    if (!p.success || !b.success || p.data.id === b.data.with) return reply.code(400).send({ error: 'bad_request' });
    if (!(await mayUse(req, p.data.id)) || !(await mayUse(req, b.data.with))) return reply.code(404).send({ error: 'not_found' });
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const both = (await client.query('SELECT id, person_id FROM contacts WHERE id = ANY($1::uuid[]) FOR UPDATE', [[p.data.id, b.data.with]])).rows as { id: string; person_id: string | null }[];
      const a = both.find((r) => r.id === p.data.id)!, o = both.find((r) => r.id === b.data.with)!;
      const groups = [a.person_id, o.person_id].filter((x): x is string => !!x);
      const size = (await client.query('SELECT count(*)::int AS n FROM contacts WHERE id = ANY($1::uuid[]) OR person_id = ANY($2::uuid[])', [[a.id, o.id], groups])).rows[0].n as number;
      if (size > MAX_GROUP) { await client.query('ROLLBACK'); return reply.code(409).send({ error: 'person_too_large' }); }
      const pid = a.person_id ?? o.person_id ?? (await client.query('SELECT gen_random_uuid() AS id')).rows[0].id;
      await client.query('UPDATE contacts SET person_id = $1 WHERE id = ANY($2::uuid[]) OR person_id = ANY($3::uuid[])', [pid, [a.id, o.id], groups]);
      await client.query('COMMIT');
      await audit(db, { actorId: req.user!.id, action: 'contact.link', target: a.id, ip: req.ip, meta: { with: o.id } });
      return { ok: true, personId: pid, size };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally { client.release(); }
  });

  app.post('/contacts/:id/unlink', { preHandler: any, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    if (!(await mayUse(req, p.data.id))) return reply.code(404).send({ error: 'not_found' });
    const old = (await db.query('UPDATE contacts c SET person_id = NULL FROM contacts prev WHERE c.id = $1 AND prev.id = c.id RETURNING prev.person_id', [p.data.id])).rows[0]?.person_id as string | null;
    if (old) await db.query('UPDATE contacts SET person_id = NULL WHERE person_id = $1 AND (SELECT count(*) FROM contacts WHERE person_id = $1) = 1', [old]);   // a group of one is no group
    await audit(db, { actorId: req.user!.id, action: 'contact.unlink', target: p.data.id, ip: req.ip });
    return { ok: true };
  });
}

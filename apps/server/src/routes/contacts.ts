import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireAuth } from '../auth.js';
import type { Db } from '../db.js';
import { cleanName, findColumns, MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, normalizePhone, parseCsv } from '../contacts-csv.js';
import { toCsv } from './reports.js';

const idParam = z.object({ id: z.string().uuid() });

/** Blocking a customer (abuse/spam): supervisors and admins. The conversation is closed; new messages are stored silently. */
export function contactRoutes(app: FastifyInstance, db: Db) {
  const managers = requireAuth(db, 'contacts.block');

  app.post('/contacts/:id/block', { preHandler: managers }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = z.object({ reason: z.string().trim().max(200).optional() }).safeParse(req.body ?? {});
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    const r = await db.query(
      `UPDATE contacts SET blocked = true, blocked_at = now(), blocked_by = $2, blocked_reason = $3 WHERE id = $1 RETURNING id`,
      [p.data.id, req.user!.id, b.data.reason ?? null],
    );
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await db.query(`UPDATE conversations SET status = 'closed', unread_count = 0, bot_state = NULL WHERE contact_id = $1`, [p.data.id]);
    await audit(db, { actorId: req.user!.id, action: 'contact.block', target: p.data.id, ip: req.ip, meta: { reason: b.data.reason ?? null } });
    return { ok: true };
  });

  app.post('/contacts/:id/unblock', { preHandler: managers }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const r = await db.query(`UPDATE contacts SET blocked = false, blocked_at = NULL, blocked_by = NULL, blocked_reason = NULL WHERE id = $1`, [p.data.id]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(db, { actorId: req.user!.id, action: 'contact.unblock', target: p.data.id, ip: req.ip });
    return { ok: true };
  });

  // The customer asked to stop (or a message was misread as "stop"): a manager can restore contact.
  app.post('/contacts/:id/opt-in', { preHandler: managers }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const r = await db.query('UPDATE contacts SET opted_out = false, opted_out_at = NULL WHERE id = $1', [p.data.id]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(db, { actorId: req.user!.id, action: 'contact.opt_in', target: p.data.id, ip: req.ip });
    return { ok: true };
  });

  // ---- contacts CSV (personal data: its own permission, audited, never cached) ----
  const csvManagers = requireAuth(db, 'contacts.manage');

  app.get('/contacts/export.csv', { preHandler: csvManagers }, async (req, reply) => {
    const { rows } = await db.query(
      `SELECT ch.label AS channel, ct.external_id, ct.display_name, ct.created_at, ct.blocked, ct.opted_out,
              c.status, (SELECT max(m.created_at) FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'in') AS last_inbound
         FROM contacts ct JOIN channels ch ON ch.id = ct.channel_id LEFT JOIN conversations c ON c.contact_id = ct.id
        ORDER BY ct.created_at, ct.id LIMIT 100000`);
    await audit(db, { actorId: req.user!.id, action: 'contacts.export', ip: req.ip, meta: { count: rows.length } });
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="botwa-contacts.csv"')
      .header('cache-control', 'private, no-store')
      .send(toCsv([
        ['channel', 'phone_or_id', 'name', 'created_at', 'blocked', 'opted_out', 'conversation_status', 'last_inbound_at'],
        ...rows.map((r) => [r.channel, String(r.external_id).replace(/@s\.whatsapp\.net$/, ''), r.display_name ?? '', r.created_at.toISOString(), r.blocked ? 'yes' : 'no', r.opted_out ? 'yes' : 'no', r.status ?? '', r.last_inbound ? r.last_inbound.toISOString() : '']),
      ]));
  });

  // Import adds names for WhatsApp numbers. It never opens a conversation and never grants permission to message anyone:
  // a person who has not written to you stays outside the reply window, so nothing can be sent to them.
  app.post('/contacts/import', { preHandler: csvManagers, bodyLimit: MAX_IMPORT_BYTES + 4096, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ channelId: z.string().uuid(), csv: z.string().min(1).max(MAX_IMPORT_BYTES), dryRun: z.boolean().default(false) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const ch = (await db.query(`SELECT type FROM channels WHERE id = $1`, [b.data.channelId])).rows[0];
    if (!ch) return reply.code(404).send({ error: 'not_found' });
    if (ch.type !== 'whatsapp' && ch.type !== 'whatsapp_cloud') return reply.code(400).send({ error: 'unsupported_channel' });
    const rows = parseCsv(b.data.csv);
    const cols = rows[0] ? findColumns(rows[0]) : null;
    if (!cols) return reply.code(400).send({ error: 'missing_phone_column' });
    const data = rows.slice(1);
    if (data.length > MAX_IMPORT_ROWS) return reply.code(413).send({ error: 'too_many_rows', max: MAX_IMPORT_ROWS });
    const seen = new Set<string>();
    const invalid: { row: number; reason: string }[] = [];
    const items: { jid: string; name: string }[] = [];
    let duplicates = 0;
    data.forEach((r, i) => {
      const phone = normalizePhone(r[cols.phone] ?? '');
      if (!phone) { invalid.push({ row: i + 2, reason: 'bad_phone' }); return; }
      if (seen.has(phone)) { duplicates++; return; }
      seen.add(phone);
      items.push({ jid: `${phone}@s.whatsapp.net`, name: cols.name >= 0 ? cleanName(r[cols.name] ?? '') : '' });
    });
    let created = 0, named = 0;
    if (items.length) {
      const existing = await db.query(`SELECT external_id, display_name FROM contacts WHERE channel_id = $1 AND external_id = ANY($2::text[])`, [b.data.channelId, items.map((x) => x.jid)]);
      const byJid = new Map(existing.rows.map((r) => [r.external_id as string, r.display_name as string | null]));
      for (const it of items) {
        if (!byJid.has(it.jid)) created++; else if (it.name && !byJid.get(it.jid)) named++;
      }
      if (!b.data.dryRun) {
        await db.query(
          `INSERT INTO contacts (channel_id, external_id, display_name) SELECT $1, j, NULLIF(n, '') FROM unnest($2::text[], $3::text[]) AS t(j, n)
           ON CONFLICT (channel_id, external_id) DO UPDATE SET display_name = COALESCE(NULLIF(contacts.display_name, ''), EXCLUDED.display_name)`,
          [b.data.channelId, items.map((x) => x.jid), items.map((x) => x.name)]);
      }
    }
    if (!b.data.dryRun) await audit(db, { actorId: req.user!.id, action: 'contacts.import', ip: req.ip, meta: { created, named, invalid: invalid.length, duplicates } });
    return { dryRun: b.data.dryRun, rows: data.length, created, named, unchanged: items.length - created - named, duplicates, invalid: invalid.slice(0, 50), invalidCount: invalid.length };
  });
}

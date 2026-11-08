import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { loadAccessible } from '../access.js';
import { audit } from '../audit.js';
import { requireAuth } from '../auth.js';
import type { ChannelManager } from '../channels/manager.js';
import { forwardText, GROUP_JID, type ForwardRule } from '../channels/forward.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';

const idParam = z.object({ id: z.string().uuid() });
const ruleBody = z.object({
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(true),
  channelId: z.string().uuid(),
  groupJid: z.string().trim().regex(GROUP_JID),
  groupName: z.string().trim().max(120).default(''),
  onHandoff: z.boolean().default(false),
  tagIds: z.array(z.string().uuid()).max(20).default([]),
  includeMessages: z.number().int().min(0).max(10).default(3),
  includePhone: z.boolean().default(false),
});
const SELECT = `SELECT r.id, r.name, r.enabled, r.channel_id AS "channelId", ch.label AS "channelLabel", r.group_jid AS "groupJid", r.group_name AS "groupName", r.on_handoff AS "onHandoff",
  r.tag_ids AS "tagIds", r.include_messages AS "includeMessages", r.include_phone AS "includePhone",
  COALESCE((SELECT array_agg(t.name ORDER BY lower(t.name)) FROM tags t WHERE t.id = ANY(r.tag_ids)), '{}') AS "tagNames"
  FROM forward_rules r JOIN channels ch ON ch.id = r.channel_id`;

/**
 * Forwarding conversations into a WhatsApp group, through a linked WhatsApp (QR) number that is a member of the group: automatically when
 * the bot hands a conversation to people (optionally only for some topics/tags), or by hand from a conversation. Rules are managed with
 * `settings.manage`; any staff member can forward a conversation they can open. Replies written in the group are not read by the system.
 */
export function forwardRoutes(app: FastifyInstance, db: Db, mgr: ChannelManager, cfg: Config) {
  const view = requireAuth(db, 'settings.view');
  const manage = requireAuth(db, 'settings.manage');
  const any = requireAuth(db);

  async function checkChannel(id: string): Promise<boolean> {
    return !!(await db.query(`SELECT 1 FROM channels WHERE id = $1 AND type = 'whatsapp'`, [id])).rowCount;
  }

  app.get('/forward/rules', { preHandler: view }, async () => (await db.query(`${SELECT} ORDER BY r.created_at`)).rows);

  app.post('/forward/rules', { preHandler: manage }, async (req, reply) => {
    const b = ruleBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    if (!(await checkChannel(b.data.channelId))) return reply.code(400).send({ error: 'channel_not_whatsapp' });
    if ((await db.query('SELECT count(*)::int AS n FROM forward_rules')).rows[0].n >= 50) return reply.code(409).send({ error: 'too_many' });
    const r = await db.query(`INSERT INTO forward_rules (name, enabled, channel_id, group_jid, group_name, on_handoff, tag_ids, include_messages, include_phone, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [b.data.name, b.data.enabled, b.data.channelId, b.data.groupJid, b.data.groupName, b.data.onHandoff, b.data.tagIds, b.data.includeMessages, b.data.includePhone, req.user!.id]);
    await audit(db, { actorId: req.user!.id, action: 'forward.rule_create', target: r.rows[0].id, ip: req.ip });
    return reply.code(201).send({ id: r.rows[0].id });
  });

  app.put('/forward/rules/:id', { preHandler: manage }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = ruleBody.safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    if (!(await checkChannel(b.data.channelId))) return reply.code(400).send({ error: 'channel_not_whatsapp' });
    const r = await db.query(`UPDATE forward_rules SET name=$2, enabled=$3, channel_id=$4, group_jid=$5, group_name=$6, on_handoff=$7, tag_ids=$8, include_messages=$9, include_phone=$10 WHERE id = $1`,
      [p.data.id, b.data.name, b.data.enabled, b.data.channelId, b.data.groupJid, b.data.groupName, b.data.onHandoff, b.data.tagIds, b.data.includeMessages, b.data.includePhone]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(db, { actorId: req.user!.id, action: 'forward.rule_update', target: p.data.id, ip: req.ip });
    return { ok: true };
  });

  app.delete('/forward/rules/:id', { preHandler: manage }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const r = await db.query('DELETE FROM forward_rules WHERE id = $1', [p.data.id]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(db, { actorId: req.user!.id, action: 'forward.rule_delete', target: p.data.id, ip: req.ip });
    return { ok: true };
  });

  /** The groups of a linked number, to choose from (the channel must be connected). */
  app.get('/channels/:id/groups', { preHandler: manage, config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const q = z.object({ refresh: z.enum(['1']).optional() }).safeParse(req.query);
    if (!p.success || !q.success) return reply.code(400).send({ error: 'bad_request' });
    if (!(await checkChannel(p.data.id))) return reply.code(400).send({ error: 'channel_not_whatsapp' });
    try { return await mgr.listGroups(p.data.id, !!q.data.refresh); } catch { return reply.code(409).send({ error: 'channel_not_connected' }); }
  });

  app.post('/forward/rules/:id/test', { preHandler: manage, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const r = (await db.query('SELECT * FROM forward_rules WHERE id = $1', [p.data.id])).rows[0] as ForwardRule | undefined;
    if (!r) return reply.code(404).send({ error: 'not_found' });
    const ok = await mgr.forwardToGroup({ ruleId: r.id, convId: null, channelId: r.channel_id, jid: r.group_jid, text: `✅ בדיקת חיבור: הקבוצה "${r.group_name || r.name}" מחוברת להעברת שיחות.`, trigger: 'test', by: req.user!.id });
    if (!ok) { await db.query(`UPDATE forward_log SET status = 'failed' WHERE rule_id = $1 AND trigger = 'test' AND status = 'pending'`, [r.id]); return reply.code(409).send({ error: 'send_failed' }); }
    return { ok: true };
  });

  app.get('/forward/log', { preHandler: view }, async () => (await db.query(
    `SELECT l.id, l.status, l.trigger, l.tries, l.created_at AS "createdAt", r.name AS "ruleName", u.name AS "byName", l.conversation_id AS "conversationId"
       FROM forward_log l LEFT JOIN forward_rules r ON r.id = l.rule_id LEFT JOIN users u ON u.id = l.by_user ORDER BY l.id DESC LIMIT 50`)).rows);

  /** Where a staff member can send a conversation (names only). */
  app.get('/forward/targets', { preHandler: any }, async () => (await db.query(`SELECT id, name, group_name AS "groupName" FROM forward_rules WHERE enabled ORDER BY name`)).rows);

  app.post('/conversations/:id/forward', { preHandler: any, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = z.object({ ruleId: z.string().uuid(), note: z.string().trim().max(400).optional() }).safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    const conv = await loadAccessible(db, req.user!, p.data.id);
    if (!conv) return reply.code(404).send({ error: 'not_found' });
    const rule = (await db.query('SELECT * FROM forward_rules WHERE id = $1 AND enabled', [b.data.ruleId])).rows[0] as ForwardRule | undefined;
    if (!rule) return reply.code(404).send({ error: 'rule_not_found' });
    const text = await forwardText(db, p.data.id, rule, cfg.APP_ORIGIN, { note: b.data.note, by: req.user!.name });
    if (!text) return reply.code(404).send({ error: 'not_found' });
    const ok = await mgr.forwardToGroup({ ruleId: rule.id, convId: p.data.id, channelId: rule.channel_id, jid: rule.group_jid, text, trigger: 'manual', by: req.user!.id });
    await db.query('INSERT INTO conversation_notes (conversation_id, author_id, body) VALUES ($1,$2,$3)', [p.data.id, req.user!.id, `הועברה לקבוצת ווצאפ "${rule.group_name || rule.name}"${ok ? '' : ' (השליחה ממתינה: הערוץ מנותק, תישלח כשיחזור)'}.`]);
    await audit(db, { actorId: req.user!.id, action: 'conversation.forward', target: p.data.id, ip: req.ip, meta: { rule: rule.id } });
    return reply.code(ok ? 200 : 202).send({ ok, queued: !ok });
  });
}

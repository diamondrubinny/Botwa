import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { loadAccessible } from '../access.js';
import { audit } from '../audit.js';
import { requireAuth } from '../auth.js';
import { renderTemplateBody, TEMPLATE_CATEGORIES, TEMPLATE_LANGS, TEMPLATE_NAME } from '../channels/cloud-messages.js';
import type { ChannelManager } from '../channels/manager.js';
import { PolicyRejected, SendError } from '../channels/sender.js';
import type { Db } from '../db.js';

const idParam = z.object({ id: z.string().uuid() });

/**
 * Message templates of the official WhatsApp channel: seeing them with their approval status, submitting new ones for Meta's approval,
 * and sending an approved one to a customer (the only way to write to someone outside the 24-hour window). Seeing and creating templates
 * needs `channels.manage`; any staff member can send an approved template in a conversation they can open. A blocked customer or one who
 * asked to stop gets nothing, templates included.
 */
export function templateRoutes(app: FastifyInstance, db: Db, mgr: ChannelManager) {
  const manage = requireAuth(db, 'channels.manage');
  const any = requireAuth(db);

  const fail = (reply: import('fastify').FastifyReply, e: unknown) => {
    const m = (e as Error).message;
    if (m === 'channel_not_connected') return reply.code(409).send({ error: 'channel_not_connected' });
    if (m === 'waba_not_configured') return reply.code(409).send({ error: 'waba_not_configured' });
    if (m.startsWith('template_rejected:')) return reply.code(422).send({ error: 'template_rejected', detail: m.slice(18) });
    return reply.code(502).send({ error: 'templates_failed' });
  };
  const isCloud = async (id: string) => !!(await db.query(`SELECT 1 FROM channels WHERE id = $1 AND type = 'whatsapp_cloud'`, [id])).rowCount;

  app.get('/channels/:id/templates', { preHandler: manage, config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const q = z.object({ refresh: z.enum(['1']).optional() }).safeParse(req.query);
    if (!p.success || !q.success || !(await isCloud(p.data.id))) return reply.code(400).send({ error: 'bad_request' });
    try { return await mgr.cloudTemplates(p.data.id, !!q.data.refresh); } catch (e) { return fail(reply, e); }
  });

  app.post('/channels/:id/templates', { preHandler: manage, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = z.object({
      name: z.string().trim().regex(TEMPLATE_NAME).max(60),
      language: z.enum(TEMPLATE_LANGS),
      category: z.enum(TEMPLATE_CATEGORIES.filter((c) => c !== 'AUTHENTICATION') as ['UTILITY', 'MARKETING']),
      body: z.string().trim().min(1).max(1024),
      examples: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
    }).safeParse(req.body);
    if (!p.success || !b.success || !(await isCloud(p.data.id))) return reply.code(400).send({ error: 'bad_request' });
    // placeholders must be {{1}}, {{2}}... in order, each with an example value, and not at the very start or end (Meta rejects those)
    const nums = [...b.data.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
    const uniq = [...new Set(nums)];
    if (uniq.some((n, i) => n !== i + 1) || b.data.examples.length < uniq.length) return reply.code(400).send({ error: 'bad_placeholders' });
    if (/^\{\{\d+\}\}/.test(b.data.body) || /\{\{\d+\}\}$/.test(b.data.body)) return reply.code(400).send({ error: 'bad_placeholders' });
    try {
      const r = await mgr.createCloudTemplate(p.data.id, b.data);
      await audit(db, { actorId: req.user!.id, action: 'channel.template_create', target: p.data.id, ip: req.ip, meta: { name: b.data.name, category: b.data.category } });
      return reply.code(201).send({ ok: true, status: r.status ?? 'PENDING' });
    } catch (e) { return fail(reply, e); }
  });

  /** Approved templates a staff member can send in this conversation (empty for channels other than the official one). */
  app.get('/conversations/:id/templates', { preHandler: any }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const conv = await loadAccessible(db, req.user!, p.data.id);
    if (!conv) return reply.code(404).send({ error: 'not_found' });
    if (conv.channel_type !== 'whatsapp_cloud') return [];
    try { return (await mgr.cloudTemplates(conv.channel_id)).filter((t) => t.status === 'APPROVED'); } catch { return []; }
  });

  app.post('/conversations/:id/send-template', { preHandler: any, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = z.object({ name: z.string().regex(TEMPLATE_NAME), language: z.string().min(2).max(10), params: z.array(z.string().max(200)).max(20).default([]) }).safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    const u = req.user!;
    const conv = await loadAccessible(db, u, p.data.id);
    if (!conv) return reply.code(404).send({ error: 'not_found' });
    if (conv.channel_type !== 'whatsapp_cloud') return reply.code(400).send({ error: 'templates_need_official_channel' });
    if (conv.blocked) return reply.code(409).send({ error: 'contact_blocked' });
    if (conv.opted_out) return reply.code(409).send({ error: 'contact_opted_out' });
    let tpl;
    try { tpl = (await mgr.cloudTemplates(conv.channel_id)).find((t) => t.name === b.data.name && t.language === b.data.language); } catch (e) { return fail(reply, e); }
    if (!tpl) return reply.code(404).send({ error: 'template_not_found' });
    if (tpl.status !== 'APPROVED') return reply.code(409).send({ error: 'template_not_approved' });
    const params = b.data.params.map((x) => x.replace(/[\r\n\t]+/g, ' ').trim());
    if (params.length !== tpl.params || params.some((x) => !x)) return reply.code(400).send({ error: 'bad_params' });
    let sent: { externalMessageId?: string };
    try { sent = await mgr.sendTemplate(conv.channel_id, conv.external_id, { name: tpl.name, language: tpl.language, params }); } catch (e) {
      if ((e as Error).message === 'channel_not_connected') return reply.code(409).send({ error: 'channel_not_connected' });
      if (e instanceof SendError) return reply.code(429).send({ error: e.code });
      if (e instanceof PolicyRejected) return reply.code(409).send({ error: e.code });
      req.log.error({ err: e }, 'template send failed');
      return reply.code(502).send({ error: 'send_failed' });
    }
    const body = renderTemplateBody(tpl.body, params);
    const { rows } = await db.query(`INSERT INTO messages (conversation_id, direction, body, external_id, sender_user_id) VALUES ($1,'out',$2,$3,$4) RETURNING id, direction, body, created_at AS "createdAt"`, [conv.id, body, sent.externalMessageId ?? null, u.id]);
    mgr.notifyMessage(conv.channel_id, conv.id, rows[0].id);
    mgr.hookMessage('message.sent', conv.id, rows[0].id);
    await db.query(`UPDATE conversations SET last_message_at = now(), assigned_to = COALESCE(assigned_to, $2), bot_state = 'human' WHERE id = $1`, [conv.id, u.id]);
    await audit(db, { actorId: u.id, action: 'conversation.send_template', target: conv.id, ip: req.ip, meta: { template: tpl.name, category: tpl.category } });
    return reply.code(201).send(rows[0]);
  });
}

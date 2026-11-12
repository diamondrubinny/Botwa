import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ChannelManager } from '../channels/manager.js';
import type { Db } from '../db.js';
import type { WaWebhook } from '../channels/whatsapp-cloud.js';
import type { MetaWebhook } from '../channels/meta-messaging.js';

const idParam = z.object({ channelId: z.string().uuid() });

/**
 * Inbound webhook of the official WhatsApp channel. Public by necessity (Meta calls it), so it is authenticated by an HMAC
 * signature over the exact raw body (app secret) and never trusts the payload before that check. No CSRF/Origin check applies.
 */
export function webhookRoutes(app: FastifyInstance, db: Db, mgr: ChannelManager) {
  void app.register(async (scope) => {
    // keep the raw bytes: the signature is computed over them, not over re-serialised JSON
    scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 2 * 1024 * 1024 }, (_req, body, done) => done(null, body));
    const limit = { rateLimit: { max: 1200, timeWindow: '1 minute' } };

    const isCloud = async (id: string) => (await db.query(`SELECT 1 FROM channels WHERE id = $1 AND type = 'whatsapp_cloud'`, [id])).rowCount === 1;

    scope.get('/webhooks/whatsapp/:channelId', { config: limit }, async (req, reply) => {
      const p = idParam.safeParse(req.params);
      if (!p.success || !(await isCloud(p.data.channelId))) return reply.code(404).send('not found');
      const q = req.query as Record<string, string | undefined>;
      const ok = mgr.cloudAdapter(p.data.channelId)?.verifyHandshake(q['hub.mode'], q['hub.verify_token'], q['hub.challenge']);
      return ok ? reply.type('text/plain').send(ok) : reply.code(403).send('forbidden');
    });

    scope.post('/webhooks/whatsapp/:channelId', { config: limit }, async (req, reply) => {
      const p = idParam.safeParse(req.params);
      if (!p.success || !(await isCloud(p.data.channelId))) return reply.code(404).send({ error: 'not_found' });
      const adapter = mgr.cloudAdapter(p.data.channelId);
      if (!adapter || !adapter.isActive()) return reply.code(503).send({ error: 'channel_not_running' }); // Meta retries later
      const raw = req.body as Buffer;
      if (!Buffer.isBuffer(raw) || !adapter.checkSignature(raw, req.headers['x-hub-signature-256'] as string | undefined)) {
        return reply.code(403).send({ error: 'bad_signature' });
      }
      let payload: WaWebhook;
      try { payload = JSON.parse(raw.toString('utf8')) as WaWebhook; } catch { return reply.code(400).send({ error: 'bad_request' }); }
      mgr.noteCloudWebhook(p.data.channelId);   // a signed delivery arrived: the webhook works (shown on the channel's settings)
      try {
        await adapter.handleWebhook(payload);
      } catch (e) {
        req.log.error({ err: e }, 'whatsapp webhook processing failed');
        return reply.code(500).send({ error: 'processing_failed' }); // not acknowledged => Meta redelivers; duplicates are ignored by message id
      }
      return { ok: true };
    });

    // Messenger / Instagram: the same handshake and HMAC check (app secret), payload object 'page' or 'instagram'
    const isMeta = async (id: string) => (await db.query(`SELECT 1 FROM channels WHERE id = $1 AND type IN ('messenger','instagram')`, [id])).rowCount === 1;
    scope.get('/webhooks/meta/:channelId', { config: limit }, async (req, reply) => {
      const p = idParam.safeParse(req.params);
      if (!p.success || !(await isMeta(p.data.channelId))) return reply.code(404).send('not found');
      const q = req.query as Record<string, string | undefined>;
      const ok = mgr.metaAdapter(p.data.channelId)?.verifyHandshake(q['hub.mode'], q['hub.verify_token'], q['hub.challenge']);
      return ok ? reply.type('text/plain').send(ok) : reply.code(403).send('forbidden');
    });
    scope.post('/webhooks/meta/:channelId', { config: limit }, async (req, reply) => {
      const p = idParam.safeParse(req.params);
      if (!p.success || !(await isMeta(p.data.channelId))) return reply.code(404).send({ error: 'not_found' });
      const adapter = mgr.metaAdapter(p.data.channelId);
      if (!adapter || !adapter.isActive()) return reply.code(503).send({ error: 'channel_not_running' });
      const raw = req.body as Buffer;
      if (!Buffer.isBuffer(raw) || !adapter.checkSignature(raw, req.headers['x-hub-signature-256'] as string | undefined)) return reply.code(403).send({ error: 'bad_signature' });
      let payload: MetaWebhook;
      try { payload = JSON.parse(raw.toString('utf8')) as MetaWebhook; } catch { return reply.code(400).send({ error: 'bad_request' }); }
      mgr.noteCloudWebhook(p.data.channelId);
      try {
        await adapter.handleWebhook(payload);
      } catch (e) {
        req.log.error({ err: e }, 'meta webhook processing failed');
        return reply.code(500).send({ error: 'processing_failed' });
      }
      return { ok: true };
    });
  });
}

import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireAuth } from '../auth.js';
import type { Config } from '../config.js';
import { encrypt } from '../crypto.js';
import type { Db } from '../db.js';
import { EVENTS, webhookUrlProblem, type WebhookService } from '../integrations/webhooks.js';
import { SCOPES, sha } from './api.js';

const idParam = z.object({ id: z.string().uuid() });
const newKey = () => { const prefix = randomBytes(6).toString('base64url').replace(/[_-]/g, 'x'); return { prefix, key: `bk_${prefix}_${randomBytes(30).toString('base64url')}` }; };
const newSecret = () => `whsec_${randomBytes(30).toString('base64url')}`;

/** Admin side of integrations: API keys and webhook endpoints (permission api.manage). Secrets are shown once. */
export function integrationRoutes(app: FastifyInstance, db: Db, cfg: Config, hooks: WebhookService, opts: { allowHttp?: boolean } = {}) {
  const adminOnly = requireAuth(db, 'api.manage');
  const limit = { rateLimit: { max: 30, timeWindow: '1 minute' } };

  app.get('/integrations/keys', { preHandler: adminOnly }, async () => (await db.query(
    `SELECT k.id, k.name, k.prefix, k.scopes, k.created_at AS "createdAt", k.last_used_at AS "lastUsedAt", k.revoked_at AS "revokedAt", u.name AS "createdBy" FROM api_keys k LEFT JOIN users u ON u.id = k.created_by ORDER BY k.created_at DESC`)).rows);

  app.post('/integrations/keys', { preHandler: adminOnly, config: limit }, async (req, reply) => {
    const b = z.object({ name: z.string().trim().min(1).max(60), scopes: z.array(z.enum(SCOPES)).min(1).max(3) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const { key, prefix } = newKey();
    const r = await db.query('INSERT INTO api_keys (name, prefix, key_hash, scopes, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id', [b.data.name, prefix, sha(key), [...new Set(b.data.scopes)], req.user!.id]);
    await audit(db, { actorId: req.user!.id, action: 'api_key.create', target: r.rows[0].id, ip: req.ip, meta: { scopes: b.data.scopes } });
    return reply.code(201).send({ id: r.rows[0].id, key }); // the only time the full key is visible
  });

  app.delete('/integrations/keys/:id', { preHandler: adminOnly }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const r = await db.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [p.data.id]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(db, { actorId: req.user!.id, action: 'api_key.revoke', target: p.data.id, ip: req.ip });
    return { ok: true };
  });

  const WH = `SELECT id, name, url, events, include_text AS "includeText", enabled, failures, disabled_reason AS "disabledReason", created_at AS "createdAt",
    (SELECT count(*)::int FROM webhook_deliveries d WHERE d.webhook_id = w.id AND d.status = 'pending') AS pending FROM webhooks w`;
  app.get('/integrations/webhooks', { preHandler: adminOnly }, async () => ({ events: EVENTS, items: (await db.query(`${WH} ORDER BY created_at DESC`)).rows }));

  const body = z.object({ name: z.string().trim().min(1).max(60), url: z.string().trim().max(500), events: z.array(z.enum(EVENTS)).min(1), includeText: z.boolean().default(true) });
  app.post('/integrations/webhooks', { preHandler: adminOnly, config: limit }, async (req, reply) => {
    const b = body.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const problem = webhookUrlProblem(b.data.url, opts.allowHttp);
    if (problem) return reply.code(400).send({ error: problem });
    if ((await db.query('SELECT count(*)::int AS n FROM webhooks')).rows[0].n >= 20) return reply.code(409).send({ error: 'too_many' });
    const secret = newSecret();
    const r = await db.query('INSERT INTO webhooks (name, url, secret_enc, events, include_text, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [b.data.name, b.data.url, encrypt(secret, cfg.ENCRYPTION_KEY), [...new Set(b.data.events)], b.data.includeText, req.user!.id]);
    await audit(db, { actorId: req.user!.id, action: 'webhook.create', target: r.rows[0].id, ip: req.ip, meta: { host: new URL(b.data.url).host } });
    return reply.code(201).send({ id: r.rows[0].id, secret });
  });

  app.patch('/integrations/webhooks/:id', { preHandler: adminOnly }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = body.partial().extend({ enabled: z.boolean().optional() }).safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    if (b.data.url !== undefined) { const problem = webhookUrlProblem(b.data.url, opts.allowHttp); if (problem) return reply.code(400).send({ error: problem }); }
    const r = await db.query(
      `UPDATE webhooks SET name = COALESCE($2, name), url = COALESCE($3, url), events = COALESCE($4, events), include_text = COALESCE($5, include_text), enabled = COALESCE($6, enabled),
              failures = CASE WHEN $6 IS TRUE THEN 0 ELSE failures END, disabled_reason = CASE WHEN $6 IS TRUE THEN NULL ELSE disabled_reason END WHERE id = $1`,
      [p.data.id, b.data.name ?? null, b.data.url ?? null, b.data.events ?? null, b.data.includeText ?? null, b.data.enabled ?? null]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(db, { actorId: req.user!.id, action: 'webhook.update', target: p.data.id, ip: req.ip });
    return { ok: true };
  });

  app.post('/integrations/webhooks/:id/rotate-secret', { preHandler: adminOnly, config: limit }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const secret = newSecret();
    const r = await db.query('UPDATE webhooks SET secret_enc = $2 WHERE id = $1', [p.data.id, encrypt(secret, cfg.ENCRYPTION_KEY)]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(db, { actorId: req.user!.id, action: 'webhook.rotate_secret', target: p.data.id, ip: req.ip });
    return { secret };
  });

  app.delete('/integrations/webhooks/:id', { preHandler: adminOnly }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const r = await db.query('DELETE FROM webhooks WHERE id = $1', [p.data.id]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(db, { actorId: req.user!.id, action: 'webhook.delete', target: p.data.id, ip: req.ip });
    return { ok: true };
  });

  // A synthetic event, delivered right away, so the receiving side can be checked end to end.
  app.post('/integrations/webhooks/:id/test', { preHandler: adminOnly, config: limit }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    if (!(await db.query('SELECT 1 FROM webhooks WHERE id = $1', [p.data.id])).rowCount) return reply.code(404).send({ error: 'not_found' });
    const payload = { id: crypto.randomUUID(), type: 'webhook.test', createdAt: new Date().toISOString(), data: { note: 'This is a test event from Botwa.' } };
    const r = await db.query(`INSERT INTO webhook_deliveries (webhook_id, event_id, event, payload) VALUES ($1,$2,'webhook.test',$3) RETURNING id`, [p.data.id, payload.id, JSON.stringify(payload)]);
    await hooks.tick();
    const d = (await db.query('SELECT status, attempts, response_code AS "responseCode", last_error AS "lastError" FROM webhook_deliveries WHERE id = $1', [r.rows[0].id])).rows[0];
    return d;
  });

  app.get('/integrations/webhooks/:id/deliveries', { preHandler: adminOnly }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    return (await db.query(`SELECT id, event, status, attempts, response_code AS "responseCode", last_error AS "lastError", created_at AS "createdAt", delivered_at AS "deliveredAt" FROM webhook_deliveries WHERE webhook_id = $1 ORDER BY created_at DESC LIMIT 50`, [p.data.id])).rows;
  });
}

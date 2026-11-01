import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireAuth } from '../auth.js';
import type { ChannelManager } from '../channels/manager.js';
import type { Config } from '../config.js';
import { encrypt } from '../crypto.js';
import type { Db } from '../db.js';
import { behaviorSchema, designSchema, embedCode, newIdentitySecret, newPublicKey, normalizeOrigin, textOn } from '../webchat/config.js';

const idParam = z.object({ id: z.string().uuid() });

/** Create the default configuration row for a new website-chat channel (called when the channel is created). */
export async function createDefaultWebchat(db: Db, cfg: Config, channelId: string): Promise<void> {
  await db.query(
    `INSERT INTO webchat_configs (channel_id, public_key, identity_secret_enc, design, behavior) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [channelId, newPublicKey(), encrypt(newIdentitySecret(), cfg.ENCRYPTION_KEY), JSON.stringify(designSchema.parse({})), JSON.stringify(behaviorSchema.parse({}))],
  );
}

export function webchatAdminRoutes(app: FastifyInstance, db: Db, mgr: ChannelManager, cfg: Config) {
  const adminOnly = requireAuth(db, 'channels.manage');
  const origin = cfg.APP_ORIGIN.split(',')[0]!.trim().replace(/\/$/, '');

  const isWebchat = async (id: string) => (await db.query(`SELECT 1 FROM channels WHERE id = $1 AND type = 'webchat'`, [id])).rowCount === 1;
  const view = async (id: string) => {
    const r = (await db.query('SELECT public_key, allowed_origins, allow_any_origin, design, behavior FROM webchat_configs WHERE channel_id = $1', [id])).rows[0];
    if (!r) return null;
    return { design: r.design, behavior: r.behavior, allowedOrigins: r.allowed_origins, allowAnyOrigin: r.allow_any_origin, publicKey: r.public_key, embedCode: embedCode(origin, r.public_key), previewUrl: `${origin}/w/${r.public_key}`, status: mgr.snapshot(id).status };
  };

  app.get('/channels/:id/webchat', { preHandler: adminOnly }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success || !(await isWebchat(p.data.id))) return reply.code(404).send({ error: 'not_found' });
    await createDefaultWebchat(db, cfg, p.data.id); // channels created before this feature existed, or by hand
    return view(p.data.id);
  });

  app.put('/channels/:id/webchat', { preHandler: adminOnly, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = z.object({ design: designSchema, behavior: behaviorSchema, allowedOrigins: z.array(z.string().max(120)).max(20), allowAnyOrigin: z.boolean() }).safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    if (!(await isWebchat(p.data.id))) return reply.code(404).send({ error: 'not_found' });
    if (!textOn(b.data.design.color)) return reply.code(400).send({ error: 'bad_color' }); // neither white nor black text would be readable on it
    const origins: string[] = [];
    for (const o of b.data.allowedOrigins) { const n = normalizeOrigin(o); if (!n) return reply.code(400).send({ error: 'bad_origin' }); if (!origins.includes(n)) origins.push(n); }
    await createDefaultWebchat(db, cfg, p.data.id);
    await db.query(`UPDATE webchat_configs SET design = $2, behavior = $3, allowed_origins = $4, allow_any_origin = $5, updated_at = now() WHERE channel_id = $1`, [p.data.id, JSON.stringify(b.data.design), JSON.stringify(b.data.behavior), origins, b.data.allowAnyOrigin]);
    if (mgr.snapshot(p.data.id).status !== 'connected') await mgr.start(p.data.id).catch(() => undefined);
    await audit(db, { actorId: req.user!.id, action: 'channel.webchat_update', target: p.data.id, ip: req.ip, meta: { origins: origins.length, anyOrigin: b.data.allowAnyOrigin } });
    return view(p.data.id);
  });

  // The identity secret signs "this visitor is customer X" on the host site's server. Shown once, never stored in plain text.
  app.post('/channels/:id/webchat/identity-secret', { preHandler: adminOnly, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success || !(await isWebchat(p.data.id))) return reply.code(404).send({ error: 'not_found' });
    await createDefaultWebchat(db, cfg, p.data.id);
    const secret = newIdentitySecret();
    await db.query('UPDATE webchat_configs SET identity_secret_enc = $2, updated_at = now() WHERE channel_id = $1', [p.data.id, encrypt(secret, cfg.ENCRYPTION_KEY)]);
    await audit(db, { actorId: req.user!.id, action: 'channel.webchat_secret_rotated', target: p.data.id, ip: req.ip });
    return { secret };
  });
}


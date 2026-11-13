import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
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

/** Where the WordPress plugin sources are: copied next to the build (dist/webchat/wp-plugin), or the repository folder in development and tests. */
function pluginDir(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const c of [path.join(here, '../webchat/wp-plugin'), path.join(here, '../../../../wordpress-plugin/botwa-chat')]) if (existsSync(path.join(c, 'botwa-chat.php'))) return c;
  return null;
}
function walk(dir: string, base = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'tests' ? [] : walk(path.join(dir, e.name), `${base}${e.name}/`)) : e.isFile() ? [`${base}${e.name}`] : []));
}

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
    if (!b.success && b.error.issues.some((i) => i.path[0] === 'behavior' && i.path[1] === 'socialLinks')) return reply.code(400).send({ error: 'bad_social_handle' });
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

  // The WordPress plugin, packaged for this chat: server address and site key are pre-filled, so it works once activated.
  app.get('/channels/:id/webchat/wordpress-plugin.zip', { preHandler: adminOnly, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success || !(await isWebchat(p.data.id))) return reply.code(404).send({ error: 'not_found' });
    const dir = pluginDir();
    if (!dir) return reply.code(503).send({ error: 'plugin_unavailable' });
    await createDefaultWebchat(db, cfg, p.data.id);
    const key = (await db.query('SELECT public_key FROM webchat_configs WHERE channel_id = $1', [p.data.id])).rows[0].public_key as string;
    const zip = new JSZip();
    for (const f of walk(dir)) if (statSync(path.join(dir, f)).size < 1024 * 1024 && f !== 'botwa-chat-defaults.php') zip.file(`botwa-chat/${f}`, readFileSync(path.join(dir, f)));
    zip.file('botwa-chat/botwa-chat-defaults.php', `<?php\n// Generated by Botwa for one chat. Public values only.\nreturn array( 'server' => ${JSON.stringify(origin)}, 'key' => ${JSON.stringify(key)} );\n`);
    await audit(db, { actorId: req.user!.id, action: 'channel.webchat_plugin_download', target: p.data.id, ip: req.ip });
    return reply.header('content-type', 'application/zip').header('content-disposition', 'attachment; filename="botwa-chat.zip"').header('cache-control', 'private, no-store')
      .send(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
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


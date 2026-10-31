import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { registerStatic } from './static.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { channelRoutes } from './routes/channels.js';
import multipart from '@fastify/multipart';
import { MediaService } from './media/store.js';
import { passkeyRoutes } from './routes/passkeys.js';
import { roleRoutes } from './routes/roles.js';
import { backupRoutes } from './routes/backups.js';
import { pushRoutes } from './routes/push.js';
import { PushService } from './push.js';
import { contactRoutes } from './routes/contacts.js';
import { tagRoutes } from './routes/tags.js';
import { settingsRoutes } from './routes/settings.js';
import { eventRoutes } from './routes/events.js';
import { reportRoutes } from './routes/reports.js';
import { mediaRoutes } from './routes/media.js';
import { conversationRoutes } from './routes/conversations.js';
import type { ChannelManager } from './channels/manager.js';
import type { Config } from './config.js';
import type { Db } from './db.js';

export async function buildApp(cfg: Config, db: Db, mgr: ChannelManager, media: MediaService = new MediaService(db, cfg)): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: cfg.NODE_ENV === 'test' ? 'silent' : 'info',
      // never log credentials or session cookies
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    },
    trustProxy: cfg.TRUST_PROXY,
    bodyLimit: 100 * 1024,
  });

  app.decorate('mfaEnforced', cfg.REQUIRE_MFA_FOR_PRIVILEGED);
  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], frameAncestors: ["'none'"] } },
    hsts: cfg.COOKIE_SECURE ? { maxAge: 31536000, includeSubDomains: true } : false,
  });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: media.maxBytes, files: 1, fields: 4, parts: 6 } });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  const allowedOrigins = cfg.APP_ORIGIN.split(',').map((o) => o.trim().replace(/\/$/, ''));
  // CSRF defence in depth (cookie is already SameSite=Strict): mutating requests must come from our origin.
  app.addHook('onRequest', async (req, reply) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const origin = req.headers.origin;
      if (!origin || !allowedOrigins.includes(origin)) return reply.code(403).send({ error: 'bad_origin' });
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) req.log.error({ err }, 'unhandled error');
    reply.code(status).send({ error: status === 500 ? 'internal_error' : (err.message ?? 'error') });
  });

  app.get('/healthz', async () => {
    await db.query('SELECT 1');
    return { ok: true };
  });

  // Serve the built admin panel (hash-routed SPA) from the same origin, if present.
  const webDist = cfg.WEB_DIST ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (existsSync(path.join(webDist, 'index.html'))) {
    registerStatic(app, webDist);
  }

  authRoutes(app, db, cfg);
  passkeyRoutes(app, db, cfg);
  userRoutes(app, db);
  roleRoutes(app, db);
  channelRoutes(app, db, mgr);
  conversationRoutes(app, db, mgr, media);
  mediaRoutes(app, db, mgr, media);
  reportRoutes(app, db, cfg);
  eventRoutes(app, db, mgr);
  tagRoutes(app, db);
  contactRoutes(app, db);
  settingsRoutes(app, db);
  backupRoutes(app, db, cfg);
  const push = new PushService(db, cfg);
  await push.init();
  mgr.onInbound = (id) => void push.notifyInbound(id).catch(() => undefined);
  pushRoutes(app, db, push);
  return app;
}

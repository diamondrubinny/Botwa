import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { channelRoutes } from './routes/channels.js';
import { conversationRoutes } from './routes/conversations.js';
import type { ChannelManager } from './channels/manager.js';
import type { Config } from './config.js';
import type { Db } from './db.js';

export async function buildApp(cfg: Config, db: Db, mgr: ChannelManager): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: cfg.NODE_ENV === 'test' ? 'silent' : 'info',
      // never log credentials or session cookies
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    },
    trustProxy: cfg.TRUST_PROXY,
    bodyLimit: 100 * 1024,
  });

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], frameAncestors: ["'none'"] } },
    hsts: cfg.COOKIE_SECURE ? { maxAge: 31536000, includeSubDomains: true } : false,
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  // CSRF defence in depth (cookie is already SameSite=Strict): mutating requests must come from our origin.
  app.addHook('onRequest', async (req, reply) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin !== cfg.APP_ORIGIN) return reply.code(403).send({ error: 'bad_origin' });
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

  authRoutes(app, db, cfg);
  userRoutes(app, db);
  channelRoutes(app, db, mgr);
  conversationRoutes(app, db, mgr);
  return app;
}

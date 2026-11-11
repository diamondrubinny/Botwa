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
import { webhookRoutes } from './routes/webhooks.js';
import { avatarRoutes } from './routes/avatars.js';
import { Firewall } from './firewall.js';
import { securityRoutes } from './routes/security.js';
import { learningRoutes } from './routes/learning.js';
import { scheduledRoutes } from './routes/scheduled.js';
import { PushService } from './push.js';
import { KnowledgeBase } from './kb/service.js';
import { kbRoutes } from './routes/kb.js';
import { legalRoutes } from './routes/legal.js';
import { govRoutes } from './routes/gov.js';
import { GovImporter } from './kb/gov/importer.js';
import { makeHttp } from './kb/gov/wikisource.js';
import { DG_HOST, StandardsImporter } from './kb/gov/standards.js';
import { KNESSET_HOST } from './kb/gov/knesset.js';
import { FireImporter } from './kb/gov/fire.js';
import { flowRoutes } from './routes/flow.js';
import { brandingRoutes } from './routes/branding.js';
import { forwardRoutes } from './routes/forward.js';
import { templateRoutes } from './routes/templates.js';
import { BrowserRenderer, RemoteRenderer } from './kb/browser.js';
import { safetyRoutes } from './routes/safety.js';
import { widgetRoutes } from './routes/widget.js';
import { apiRoutes } from './routes/api.js';
import { integrationRoutes } from './routes/integrations.js';
import { WebhookService, type Sender } from './integrations/webhooks.js';
import { webchatAdminRoutes } from './routes/webchat.js';
import { LocalEmbedder } from './semantic/embedder.js';
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

export async function buildApp(cfg: Config, db: Db, mgr: ChannelManager, media: MediaService = new MediaService(db, cfg), webhookSender?: Sender): Promise<FastifyInstance> {
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
  app.decorate('sessionCfg', cfg);
  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], frameAncestors: ["'none'"] } },
    hsts: cfg.COOKIE_SECURE ? { maxAge: 31536000, includeSubDomains: true } : false,
  });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: media.maxBytes, files: 1, fields: 4, parts: 6 } });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  // panel firewall: refused networks get nothing (before any other work); the chat widget and webhooks stay reachable
  const fw = new Firewall(db, cfg.FIREWALL_DISABLE);
  app.addHook('onRequest', async (req, reply) => {
    const why = await fw.decide(req.ip, req.url);
    if (!why) return;
    reply.code(403).header('cache-control', 'no-store');
    return (req.headers.accept ?? '').includes('text/html')
      ? reply.type('text/html; charset=utf-8').send('<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><title>הגישה חסומה</title><body style="font-family:system-ui;padding:2rem"><h1>הגישה מהרשת הזו אינה מורשית</h1><p>פנו למנהל המערכת.</p></body></html>')
      : reply.send({ error: 'blocked_by_firewall' });
  });

  const allowedOrigins = cfg.APP_ORIGIN.split(',').map((o) => o.trim().replace(/\/$/, ''));
  // CSRF defence in depth (cookie is already SameSite=Strict): mutating requests must come from our origin.
  app.addHook('onRequest', async (req, reply) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !req.url.startsWith('/webhooks/') && !req.url.startsWith('/api/v1/')) { // webhooks authenticate by HMAC, the API by bearer key (neither uses the cookie session)
      const origin = req.headers.origin;
      if (!origin || !allowedOrigins.includes(origin)) return reply.code(403).send({ error: 'bad_origin' });
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) req.log.error({ err }, 'unhandled error');
    reply.code(status).send({ error: status === 500 ? 'internal_error' : (err.message ?? 'error') });
  });

  // Digital Asset Links: proves this site and the Android app belong together, so the app shows the panel without a browser bar
  app.get('/.well-known/assetlinks.json', async (_req, reply) => {
    const prints = cfg.ANDROID_APP_SHA256.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
    if (!prints.length) return reply.code(404).send({ error: 'not_found' });
    return reply.header('cache-control', 'public, max-age=3600').send([{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: cfg.ANDROID_APP_PACKAGE, sha256_cert_fingerprints: prints } }]);
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
  channelRoutes(app, db, mgr, cfg);
  conversationRoutes(app, db, mgr, media);
  mediaRoutes(app, db, mgr, media);
  reportRoutes(app, db, cfg);
  eventRoutes(app, db, mgr);
  tagRoutes(app, db);
  contactRoutes(app, db);
  scheduledRoutes(app, db);
  settingsRoutes(app, db, mgr);
  backupRoutes(app, db, cfg);
  const push = new PushService(db, cfg);
  await push.init();
  mgr.onInbound = (id) => void push.notifyInbound(id).catch(() => undefined);
  mgr.onSlaBreach = (id) => void push.notifySla(id).catch(() => undefined);
  mgr.onAssigned = (id, userId, how) => void push.notifyAssigned(id, userId, how).catch(() => undefined);
  pushRoutes(app, db, push);
  webhookRoutes(app, db, mgr);
  const kb = new KnowledgeBase(db, cfg, media);
  mgr.kb = kb;
  kb.setEmbedder(new LocalEmbedder(cfg, () => void kb.embedMissing().catch(() => undefined)));
  if (cfg.BROWSER_URL && cfg.BROWSER_TOKEN) kb.setRenderer(new RemoteRenderer(cfg.BROWSER_URL.replace(/\/$/, ''), cfg.BROWSER_TOKEN));
  else if (cfg.BROWSER === 'local') kb.setRenderer(new BrowserRenderer({ path: cfg.BROWSER_PATH, noSandbox: cfg.BROWSER_NO_SANDBOX || undefined }));
  app.addHook('onClose', async () => { await kb.closeRenderer(); });
  kbRoutes(app, db, kb);
  legalRoutes(app, db, cfg);
  const govUa = `BotwaGovImport/1.0 (self-hosted support inbox; ${cfg.GOV_IMPORT_CONTACT ?? cfg.APP_ORIGIN.split(',')[0]!.trim()})`;
  const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const gov = new GovImporter(db, kb, { http: makeHttp(govUa), sleep: pause, gapMs: cfg.NODE_ENV === 'test' ? 0 : 1500 }, cfg.NODE_ENV === 'test' ? null : { http: makeHttp(govUa, KNESSET_HOST), sleep: pause });
  const standards = new StandardsImporter(db, kb, { http: makeHttp(govUa, DG_HOST), sleep: pause });
  mgr.gov = gov;
  const fire = new FireImporter(db, kb, { http: makeHttp(govUa, DG_HOST), sleep: pause });
  mgr.standards = standards;
  mgr.fire = fire;
  govRoutes(app, db, gov, standards, fire);
  learningRoutes(app, db, kb);
  securityRoutes(app, db, cfg, fw, media);
  avatarRoutes(app, db, kb);
  flowRoutes(app, db, kb);
  safetyRoutes(app, db, kb);
  brandingRoutes(app, db, kb);
  forwardRoutes(app, db, mgr, cfg);
  templateRoutes(app, db, mgr);
  widgetRoutes(app, db, mgr, cfg);
  const hooks = new WebhookService(db, cfg, webhookSender);
  mgr.webhooks = hooks;
  if (cfg.NODE_ENV !== 'test') hooks.start();
  apiRoutes(app, db, mgr, cfg);
  integrationRoutes(app, db, cfg, hooks);
  app.addHook('onClose', async () => hooks.stop());
  webchatAdminRoutes(app, db, mgr, cfg);
  return app;
}

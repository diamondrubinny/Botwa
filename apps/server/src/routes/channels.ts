import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { imageSize, stripImageMetadata } from '../avatars.js';
import { audit } from '../audit.js';
import { loadSession, requireAuth } from '../auth.js';
import { can } from '../permissions.js';
import type { ChannelManager, BusEvent } from '../channels/manager.js';
import type { Config } from '../config.js';
import { createDefaultWebchat } from './webchat.js';
import type { Db } from '../db.js';
import { warmupCap } from '../channels/sender.js';

/** Digits with country code, no leading 0/00. Israeli local format (05XXXXXXXX) is converted to 972. */
export function normalizePhone(d: string): string {
  const x = d.replace(/^00/, '');
  return /^0\d{8,9}$/.test(x) ? `972${x.slice(1)}` : x;
}

const idParam = z.object({ id: z.string().uuid() });

/** Heuristic "ban risk" from signals the platforms are known to care about (volume, unsolicited-looking ratio, failures). Advisory only. */
export function assessRisk(x: { status: string; day: number; cap: number; inbound24h: number; ageDays: number; recentAutoPauses: number }): { level: 'low' | 'medium' | 'high'; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  if (x.status === 'restricted') { score += 5; reasons.push('restricted'); }
  if (x.recentAutoPauses > 0) { score += 2; reasons.push('auto_paused_recently'); }
  const use = x.cap > 0 ? x.day / x.cap : 0;
  if (use >= 0.8) { score += 2; reasons.push('cap_near'); } else if (use >= 0.5) { score += 1; reasons.push('cap_half'); }
  if (x.day >= 30 && x.day > 3 * Math.max(1, x.inbound24h)) { score += 1; reasons.push('outbound_heavy'); }
  if (x.ageDays < 3 && x.day >= 15) { score += 1; reasons.push('new_number_busy'); }
  return { level: score >= 5 ? 'high' : score >= 2 ? 'medium' : 'low', reasons };
}

export function channelRoutes(app: FastifyInstance, db: Db, mgr: ChannelManager, cfg: Config) {
  const adminOnly = requireAuth(db, 'channels.manage');
  const view = requireAuth(db, 'channels.view');

  const exists = async (id: string) => (await db.query('SELECT 1 FROM channels WHERE id=$1', [id])).rowCount === 1;

  app.get('/channels', { preHandler: view }, async () => {
    const { rows } = await db.query('SELECT id, type, label, status, created_at AS "createdAt" FROM channels ORDER BY created_at');
    return rows.map((r) => ({ ...r, status: mgr.snapshot(r.id).status === 'stopped' ? r.status : mgr.snapshot(r.id).status }));
  });

  // Health: current status, send usage vs. cap (anti-ban pacing) and the last status changes.
  app.get('/channels/health', { preHandler: view }, async () => {
    const { rows } = await db.query('SELECT id, type, label, status FROM channels ORDER BY created_at');
    const out = [];
    for (const ch of rows) {
      const u = await mgr.sendUsage(ch.id);
      const cap = warmupCap(u.settings, u.ageDays);
      const events = (await db.query('SELECT kind, created_at AS "at" FROM channel_events WHERE channel_id = $1 ORDER BY id DESC LIMIT 6', [ch.id])).rows;
      const status = mgr.snapshot(ch.id).status === 'stopped' ? ch.status : mgr.snapshot(ch.id).status;
      const warnings: string[] = [];
      if (status === 'restricted') warnings.push('restricted');
      if (status === 'logged_out') warnings.push('logged_out');
      if (u.day >= cap * 0.8) warnings.push(u.day >= cap ? 'daily_cap_reached' : 'daily_cap_near');
      if (u.settings.warmup && cap < u.settings.perDay) warnings.push('warming_up');
      const inb = (await db.query(`SELECT count(*)::int AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.channel_id = $1 AND m.direction = 'in' AND m.created_at > now() - interval '24 hours'`, [ch.id])).rows[0].n as number;
      const pausedRow = (await db.query('SELECT paused FROM channels WHERE id = $1', [ch.id])).rows[0];
      const autoPausedUntil = mgr.isAutoPausedUntil(ch.id);
      const recentAutoPauses = (await db.query(`SELECT count(*)::int AS n FROM channel_events WHERE channel_id = $1 AND kind = 'auto_paused' AND created_at > now() - interval '24 hours'`, [ch.id])).rows[0].n as number;
      const risk = ['whatsapp_cloud', 'webchat', 'messenger', 'instagram', 'email'].includes(ch.type) ? { level: 'low' as const, reasons: [] as string[] } : assessRisk({ status, day: u.day, cap, inbound24h: inb, ageDays: u.ageDays, recentAutoPauses });
      out.push({
        id: ch.id, label: ch.label, type: ch.type, status, sentLast24h: u.day, inboundLast24h: inb, sentLastMinute: u.minute, dailyCap: cap, ageDays: Math.floor(u.ageDays),
        paused: !!pausedRow?.paused, autoPausedUntil: autoPausedUntil > Date.now() ? new Date(autoPausedUntil).toISOString() : null,
        risk, warnings, events,
      });
    }
    return out;
  });

  app.post('/channels', { preHandler: adminOnly }, async (req, reply) => {
    const b = z.object({ type: z.enum(['whatsapp', 'whatsapp_cloud', 'telegram', 'webchat', 'messenger', 'instagram', 'email']), label: z.string().min(1).max(80) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    if (!mgr.supports(b.data.type)) return reply.code(501).send({ error: 'unsupported_channel_type' });
    const { rows } = await db.query(
      'INSERT INTO channels (type, label, created_by) VALUES ($1,$2,$3) RETURNING id, type, label, status',
      [b.data.type, b.data.label, req.user!.id],
    );
    if (b.data.type === 'webchat') await createDefaultWebchat(db, cfg, rows[0].id);
    await audit(db, { actorId: req.user!.id, action: 'channel.create', target: rows[0].id, ip: req.ip, meta: { type: b.data.type } });
    return reply.code(201).send(rows[0]);
  });

  for (const action of ['start', 'stop', 'logout'] as const) {
    app.post(`/channels/:id/${action}`, { preHandler: adminOnly }, async (req, reply) => {
      const p = idParam.safeParse(req.params);
      if (!p.success) return reply.code(400).send({ error: 'bad_request' });
      if (!(await exists(p.data.id))) return reply.code(404).send({ error: 'not_found' });
      // Optional WhatsApp phone-number pairing: POST /channels/:id/start {"phone":"9725XXXXXXXX"}
      const body = action === 'start' ? z.object({ phone: z.string().regex(/^\d{8,15}$/).optional() }).safeParse(req.body ?? {}) : null;
      if (body && !body.success) return reply.code(400).send({ error: 'bad_request' });
      try {
        if (action === 'start') await mgr.start(p.data.id, { pairingPhone: body?.success && body.data.phone ? normalizePhone(body.data.phone) : undefined });
        else await mgr[action](p.data.id);
      } catch (e) {
        req.log.error({ err: e }, `channel ${action} failed`);
        return reply.code(502).send({ error: 'channel_error' });
      }
      await audit(db, { actorId: req.user!.id, action: `channel.${action}`, target: p.data.id, ip: req.ip });
      return { ok: true };
    });
  }

  // Official WhatsApp (Cloud API): credentials + the webhook details to paste into Meta's app dashboard.
  const cloudWebhook = (id: string, origin: string) => `${origin.split(',')[0]!.trim().replace(/\/$/, '')}/webhooks/whatsapp/${id}`;
  app.get('/channels/:id/cloud', { preHandler: adminOnly }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success || (await db.query(`SELECT 1 FROM channels WHERE id=$1 AND type='whatsapp_cloud'`, [p.data.id])).rowCount !== 1) return reply.code(404).send({ error: 'not_found' });
    const c = await mgr.getCloudConfig(p.data.id);
    return { ...c, webhookUrl: cloudWebhook(p.data.id, cfg.APP_ORIGIN) };
  });
  // Link the business account to the app again and report whether it is linked (for "no messages arrive").
  app.post('/channels/:id/cloud/subscribe', { preHandler: adminOnly, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success || (await db.query(`SELECT 1 FROM channels WHERE id=$1 AND type='whatsapp_cloud'`, [p.data.id])).rowCount !== 1) return reply.code(404).send({ error: 'not_found' });
    const a = mgr.cloudAdapter(p.data.id);
    if (!a || !a.isActive()) return reply.code(409).send({ error: 'channel_not_connected' });
    const result = await a.subscribeApp();
    await audit(db, { actorId: req.user!.id, action: 'channel.cloud_subscribe', target: p.data.id, ip: req.ip, meta: { result } });
    // the address Meta really uses for this number: an alternate callback URL on the account or the number wins over the app's
    const targets = await a.webhookTargets();
    const effective = targets ? (targets.phone_number ?? targets.whatsapp_business_account ?? targets.application ?? null) : null;
    const ours = cloudWebhook(p.data.id, cfg.APP_ORIGIN);
    const sub = await a.appSubscription();
    const appFields = sub ? { appId: sub.appId, callbackUrl: sub.callbackUrl, fields: sub.fields, messages: sub.active && sub.fields.includes('messages'), urlMatches: sub.callbackUrl === ours } : null;
    return { result, subscribed: await a.subscribedApps(), webhook: targets ? { ...targets, effective, ours, matches: effective === ours } : null, appFields };
  });

  // Subscribe the app to the WhatsApp "messages" field with this server as its callback. Admin only, audited.
  app.post('/channels/:id/cloud/subscribe-fields', { preHandler: adminOnly, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success || (await db.query(`SELECT 1 FROM channels WHERE id=$1 AND type='whatsapp_cloud'`, [p.data.id])).rowCount !== 1) return reply.code(404).send({ error: 'not_found' });
    const a = mgr.cloudAdapter(p.data.id);
    if (!a || !a.isActive()) return reply.code(409).send({ error: 'channel_not_connected' });
    const url = cloudWebhook(p.data.id, cfg.APP_ORIGIN);
    if (!url.startsWith('https://')) return reply.code(409).send({ error: 'webhook_needs_https' });
    const result = await a.subscribeAppFields(url);
    await audit(db, { actorId: req.user!.id, action: 'channel.cloud_subscribe_fields', target: p.data.id, ip: req.ip, meta: { result } });
    return { result };
  });

  // Send this number's webhooks here (Meta checks the address with the handshake before accepting it). Admin only, audited.
  app.post('/channels/:id/cloud/route-here', { preHandler: adminOnly, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success || (await db.query(`SELECT 1 FROM channels WHERE id=$1 AND type='whatsapp_cloud'`, [p.data.id])).rowCount !== 1) return reply.code(404).send({ error: 'not_found' });
    const a = mgr.cloudAdapter(p.data.id);
    if (!a || !a.isActive()) return reply.code(409).send({ error: 'channel_not_connected' });
    const url = cloudWebhook(p.data.id, cfg.APP_ORIGIN);
    if (!url.startsWith('https://')) return reply.code(409).send({ error: 'webhook_needs_https' });
    const result = await a.routeWebhooksTo(url);
    await audit(db, { actorId: req.user!.id, action: 'channel.cloud_route_here', target: p.data.id, ip: req.ip, meta: { result } });
    return { result };
  });

  app.put('/channels/:id/cloud', { preHandler: adminOnly, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    // a token copied together with "Bearer " (as Meta's examples show it) or with spaces around it is still the same token
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const body = { ...raw, ...(typeof raw.accessToken === 'string' ? { accessToken: raw.accessToken.trim().replace(/^Bearer\s+/i, '') } : {}), ...(typeof raw.appSecret === 'string' ? { appSecret: raw.appSecret.trim() } : {}) };
    const b = z.object({
      phoneNumberId: z.string().regex(/^\d{5,32}$/),
      accessToken: z.string().min(20).max(1000).regex(/^[\w.\-~+/=]+$/),
      appSecret: z.string().min(16).max(200).regex(/^[\w.\-~+/=]+$/),
      /** WhatsApp Business Account id (to read and create message templates); optional */
      wabaId: z.string().regex(/^\d{5,32}$/).optional(),
    }).safeParse(body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    if (!b.success) {
      // name the field that is wrong, so the screen can say what to fix (the values themselves are never echoed)
      const field = String(b.error.issues[0]?.path[0] ?? '');
      const code = ({ phoneNumberId: 'invalid_phone_number_id', accessToken: 'invalid_token_format', appSecret: 'invalid_app_secret_format', wabaId: 'invalid_waba_id' } as Record<string, string>)[field] ?? 'bad_request';
      return reply.code(400).send({ error: code });
    }
    if ((await db.query(`SELECT 1 FROM channels WHERE id=$1 AND type='whatsapp_cloud'`, [p.data.id])).rowCount !== 1) return reply.code(404).send({ error: 'not_found' });
    try {
      await mgr.setCloudCredentials(p.data.id, b.data);
    } catch (e) {
      req.log.error({ err: e }, 'cloud credentials failed');
      return reply.code(502).send({ error: 'channel_error' });
    }
    await audit(db, { actorId: req.user!.id, action: 'channel.cloud_credentials', target: p.data.id, ip: req.ip }); // never logs the values
    const status = mgr.snapshot(p.data.id).status;
    // connected: link the business account to the app, or Meta sends no webhooks at all
    const subscribe = status === 'connected' ? await mgr.cloudAdapter(p.data.id)!.subscribeApp() : null;
    // saved either way; when Meta refused, say why (the screen explains each reason)
    return { ok: true, status, ...(status === 'connected' ? { subscribe } : { error: mgr.cloudLastError(p.data.id) ?? 'meta_check_failed' }) };
  });

  // Messenger / Instagram: Page credentials + the webhook details for Meta's app dashboard (same pattern as the official WhatsApp channel).
  const isMeta = async (id: string) => (await db.query(`SELECT 1 FROM channels WHERE id=$1 AND type IN ('messenger','instagram')`, [id])).rowCount === 1;
  const metaWebhook = (id: string) => `${cfg.APP_ORIGIN.split(',')[0]!.trim().replace(/\/$/, '')}/webhooks/meta/${id}`;
  app.get('/channels/:id/meta', { preHandler: adminOnly }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success || !(await isMeta(p.data.id))) return reply.code(404).send({ error: 'not_found' });
    return { ...(await mgr.getMetaConfig(p.data.id)), webhookUrl: metaWebhook(p.data.id) };
  });
  app.post('/channels/:id/meta/subscribe', { preHandler: adminOnly, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success || !(await isMeta(p.data.id))) return reply.code(404).send({ error: 'not_found' });
    const a = mgr.metaAdapter(p.data.id);
    if (!a || !a.isActive()) return reply.code(409).send({ error: 'channel_not_connected' });
    const result = await a.subscribeApp();
    await audit(db, { actorId: req.user!.id, action: 'channel.meta_subscribe', target: p.data.id, ip: req.ip, meta: { result } });
    return { result, subscribed: await a.subscribedApps() };
  });
  app.put('/channels/:id/meta', { preHandler: adminOnly, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const body = { ...raw, ...(typeof raw.pageAccessToken === 'string' ? { pageAccessToken: raw.pageAccessToken.trim().replace(/^Bearer\s+/i, '') } : {}), ...(typeof raw.appSecret === 'string' ? { appSecret: raw.appSecret.trim() } : {}) };
    const b = z.object({
      pageId: z.string().regex(/^\d{5,32}$/),
      pageAccessToken: z.string().min(20).max(1000).regex(/^[\w.\-~+/=]+$/),
      appSecret: z.string().min(16).max(200).regex(/^[\w.\-~+/=]+$/),
      igAccountId: z.string().regex(/^\d{5,32}$/).optional(),
      comments: z.boolean().optional(),
    }).safeParse(body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    if (!b.success) {
      const field = String(b.error.issues[0]?.path[0] ?? '');
      const code = ({ pageId: 'invalid_page_id', pageAccessToken: 'invalid_token_format', appSecret: 'invalid_app_secret_format', igAccountId: 'invalid_ig_account_id' } as Record<string, string>)[field] ?? 'bad_request';
      return reply.code(400).send({ error: code });
    }
    const type = (await db.query(`SELECT type FROM channels WHERE id=$1`, [p.data.id])).rows[0]?.type as string | undefined;
    if (type !== 'messenger' && type !== 'instagram') return reply.code(404).send({ error: 'not_found' });
    if (type === 'instagram' && !b.data.igAccountId) return reply.code(400).send({ error: 'invalid_ig_account_id' });
    try {
      await mgr.setMetaCredentials(p.data.id, b.data);
    } catch (e) {
      req.log.error({ err: e }, 'meta credentials failed');
      return reply.code(502).send({ error: 'channel_error' });
    }
    await audit(db, { actorId: req.user!.id, action: 'channel.meta_credentials', target: p.data.id, ip: req.ip });
    const status = mgr.snapshot(p.data.id).status;
    const subscribe = status === 'connected' ? await mgr.metaAdapter(p.data.id)!.subscribeApp() : null;
    return { ok: true, status, ...(status === 'connected' ? { subscribe } : { error: mgr.cloudLastError(p.data.id) ?? 'meta_check_failed' }) };
  });

  // E-mail: mailbox settings (the password is write-only). Saving checks SMTP and IMAP and says which side failed and why.
  const isEmail = async (id: string) => (await db.query(`SELECT 1 FROM channels WHERE id=$1 AND type = 'email'`, [id])).rowCount === 1;
  const host = z.string().trim().toLowerCase().max(253).regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$|^\d{1,3}(\.\d{1,3}){3}$/);
  const emailBody = z.object({
    imapHost: host, imapPort: z.union([z.literal(993), z.literal(143)]),
    smtpHost: host, smtpPort: z.union([z.literal(465), z.literal(587)]),
    username: z.string().trim().min(1).max(254),
    password: z.string().max(500).optional(),
    fromAddress: z.string().trim().toLowerCase().max(254).regex(/^[^\s@<>"']{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$/),
    fromName: z.string().trim().max(80).regex(/^[^<>"\r\n]*$/).default(''),
    mailbox: z.string().trim().min(1).max(100).regex(/^[^\r\n*%"]+$/).default('INBOX'),
  }).strict();
  app.get('/channels/:id/email', { preHandler: adminOnly }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success || !(await isEmail(p.data.id))) return reply.code(404).send({ error: 'not_found' });
    return mgr.getEmailConfig(p.data.id);
  });
  app.put('/channels/:id/email', { preHandler: adminOnly, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = emailBody.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    if (!b.success) {
      const field = String(b.error.issues[0]?.path[0] ?? '');
      const code = ({ imapHost: 'invalid_mail_host', smtpHost: 'invalid_mail_host', imapPort: 'invalid_mail_port', smtpPort: 'invalid_mail_port', fromAddress: 'invalid_from_address', username: 'invalid_mail_username', fromName: 'invalid_from_name', mailbox: 'invalid_mailbox' } as Record<string, string>)[field] ?? 'bad_request';
      return reply.code(400).send({ error: code });
    }
    if (!(await isEmail(p.data.id))) return reply.code(404).send({ error: 'not_found' });
    if (!(await mgr.setEmailCredentials(p.data.id, b.data))) return reply.code(400).send({ error: 'mail_password_required' });
    await audit(db, { actorId: req.user!.id, action: 'channel.email_settings', target: p.data.id, ip: req.ip, meta: { imapHost: b.data.imapHost, smtpHost: b.data.smtpHost } });
    const status = mgr.snapshot(p.data.id).status;
    return { ok: true, status, ...(status === 'connected' ? {} : { error: mgr.cloudLastError(p.data.id) ?? 'mail_check_failed' }) };
  });

  // The WhatsApp profile picture: PNG/JPEG by content, metadata removed, scanned, at least 192x192 and at most 5 MB. Admin, audited.
  app.post('/channels/:id/profile-photo', { preHandler: adminOnly, bodyLimit: 5 * 1024 * 1024 + 64 * 1024, config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const ch = (await db.query(`SELECT type FROM channels WHERE id = $1`, [p.data.id])).rows[0];
    if (!ch) return reply.code(404).send({ error: 'not_found' });
    if (ch.type !== 'whatsapp' && ch.type !== 'whatsapp_cloud') return reply.code(400).send({ error: 'profile_photo_unsupported' });
    const file = await req.file({ limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
    if (!file) return reply.code(400).send({ error: 'bad_request' });
    let buf: Buffer;
    try { buf = await file.toBuffer(); } catch { return reply.code(413).send({ error: 'file_too_large' }); }
    if (file.file.truncated) return reply.code(413).send({ error: 'file_too_large' });
    const img = stripImageMetadata(buf);
    if (!img) return reply.code(415).send({ error: 'unsupported_image' });
    const size = imageSize(img.data);
    if (!size || size.width < 192 || size.height < 192) return reply.code(400).send({ error: 'profile_photo_too_small' });
    const scan = await mgr.scanFile(img.data);
    if (scan.status === 'infected') return reply.code(422).send({ error: 'file_infected' });
    if (scan.status !== 'clean') return reply.code(503).send({ error: 'scanner_unavailable' });
    const result = await mgr.setProfilePhoto(p.data.id, img.data, img.mime);
    const detail = result === 'ok' ? null : mgr.cloudAdapter(p.data.id)?.lastPhotoDetail ?? null;
    await audit(db, { actorId: req.user!.id, action: 'channel.profile_photo', target: p.data.id, ip: req.ip, meta: { result, bytes: img.data.length, ...(detail ? { detail } : {}) } });
    return { result, ...(detail ? { detail } : {}) };
  });

  // Telegram two-step verification password during QR login. Not persisted, not logged.
  app.post('/channels/:id/password', { preHandler: adminOnly, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    const b = z.object({ password: z.string().min(1).max(256) }).safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    try {
      mgr.submitPassword(p.data.id, b.data.password);
    } catch {
      return reply.code(409).send({ error: 'password_not_requested' });
    }
    await audit(db, { actorId: req.user!.id, action: 'channel.password_submitted', target: p.data.id, ip: req.ip });
    return { ok: true };
  });

  // Emergency brake: stops ALL outgoing messages of the channel (incoming keep arriving). Supervisors can use it too.
  for (const action of ['pause', 'resume'] as const) {
    app.post(`/channels/:id/${action}`, { preHandler: view }, async (req, reply) => {
      const p = idParam.safeParse(req.params);
      if (!p.success) return reply.code(400).send({ error: 'bad_request' });
      if (!(await exists(p.data.id))) return reply.code(404).send({ error: 'not_found' });
      await mgr.setPaused(p.data.id, action === 'pause');
      await audit(db, { actorId: req.user!.id, action: `channel.${action}`, target: p.data.id, ip: req.ip });
      return { ok: true };
    });
  }

  app.delete('/channels/:id', { preHandler: adminOnly }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    if (!(await exists(p.data.id))) return reply.code(404).send({ error: 'not_found' });
    await mgr.remove(p.data.id);
    await audit(db, { actorId: req.user!.id, action: 'channel.delete', target: p.data.id, ip: req.ip });
    return { ok: true };
  });

  // Server-Sent Events: live status + QR for the link screen. Admin only (QR = account takeover).
  app.get('/channels/:id/events', { preHandler: adminOnly }, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const id = p.data.id;
    if (!(await exists(id))) return reply.code(404).send({ error: 'not_found' });

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (e: object) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    const snap = mgr.snapshot(id);
    send({ type: 'status', status: snap.status });
    if (snap.qr) send({ type: 'qr', qr: snap.qr });
    if (snap.code) send({ type: 'pairing_code', code: snap.code });

    const onEvent = (e: BusEvent) => {
      if (e.channelId !== id || e.type === 'message') return;
      send(e);
    };
    mgr.bus.on('event', onEvent);
    const hb = setInterval(() => res.write(': hb\n\n'), 25_000);
    // Re-validate the session periodically so a revoked/expired session stops receiving QR codes.
    const recheck = setInterval(async () => {
      const t = req.cookies.botwa_sid;
      const ok = t ? await loadSession(db, t).catch(() => null) : null;
      if (!ok || !can(ok, 'channels.manage')) res.end();
    }, 60_000);
    req.raw.on('close', () => {
      clearInterval(hb);
      clearInterval(recheck);
      mgr.bus.off('event', onEvent);
    });
  });
}

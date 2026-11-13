import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireAuth } from '../auth.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { hasSmsSecret, loadSms, monthUsage, saveSms, sendSms, smsSettingsSchema, SmsError, smsNumber, type FetchLike } from '../sms/service.js';

/** SMS settings (admins: channels.manage). The provider's secret is write-only; a test SMS goes to a number the admin types. */
export function smsRoutes(app: FastifyInstance, db: Db, cfg: Config, fetchImpl?: FetchLike) {
  const admin = requireAuth(db, 'channels.manage');
  const view = async () => {
    const s = await loadSms(db);
    const recent = (await db.query(`SELECT to_masked AS "to", purpose, segments, status, error, created_at AS "at" FROM sms_log ORDER BY id DESC LIMIT 20`)).rows;
    return { ...s, hasSecret: await hasSmsSecret(db), usedThisMonth: await monthUsage(db), recent };
  };
  app.get('/settings/sms', { preHandler: admin }, async () => view());
  app.put('/settings/sms', { preHandler: admin, config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const b = smsSettingsSchema.extend({ secret: z.string().trim().regex(/^[A-Za-z0-9]{16,128}$/).optional() }).strict().safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request', detail: String(b.error.issues[0]?.path[0] ?? '') });
    const { secret, ...s } = b.data;
    if (s.enabled && (!s.accountSid || !s.from || (!secret && !(await hasSmsSecret(db))))) return reply.code(400).send({ error: 'sms_incomplete' });
    await saveSms(db, cfg, s, secret);
    await audit(db, { actorId: req.user!.id, action: 'settings.sms', ip: req.ip, meta: { enabled: s.enabled, monthlyLimit: s.monthlyLimit, secretChanged: !!secret } });
    return view();
  });
  app.post('/settings/sms/test', { preHandler: admin, config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const b = z.object({ to: z.string().trim().max(30) }).strict().safeParse(req.body);
    if (!b.success || !smsNumber(b.data.to)) return reply.code(400).send({ error: 'sms_bad_number' });
    try {
      const r = await sendSms(db, cfg, { to: b.data.to, text: 'בדיקת SMS מהמערכת: ההגדרות עובדות.', purpose: 'test', userId: req.user!.id }, fetchImpl);
      await audit(db, { actorId: req.user!.id, action: 'settings.sms_test', ip: req.ip });
      return { ok: true, segments: r.segments };
    } catch (e) {
      if (e instanceof SmsError) return reply.code(e.key === 'sms_monthly_limit' ? 429 : e.key === 'sms_not_configured' || e.key === 'sms_bad_number' ? 400 : 502).send({ error: e.key, ...(e.detail ? { detail: e.detail } : {}) });
      throw e;
    }
  });
}

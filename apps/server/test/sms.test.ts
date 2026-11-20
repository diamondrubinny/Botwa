import { randomBytes } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { ChannelManager } from '../src/channels/manager.js';
import type { AdapterContext, AdapterFactory, ChannelAdapter } from '../src/channels/types.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { remindBatch } from '../src/forms/batch.js';
import type { Field } from '../src/forms/schema.js';
import { createRequest, createTemplate } from '../src/forms/service.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';
import { maskNumber, smsNumber, smsSegments } from '../src/sms/service.js';

describe('SMS helpers', () => {
  it('counts parts: Hebrew is UCS-2 (70, then 67), plain Latin GSM-7 (160, then 153)', () => {
    expect(smsSegments('א'.repeat(70))).toEqual({ encoding: 'UCS-2', chars: 70, segments: 1 });
    expect(smsSegments('א'.repeat(71)).segments).toBe(2);
    expect(smsSegments('א'.repeat(135)).segments).toBe(3);
    expect(smsSegments('a'.repeat(160))).toEqual({ encoding: 'GSM-7', chars: 160, segments: 1 });
    expect(smsSegments('a'.repeat(161)).segments).toBe(2);
    expect(smsSegments('{}').chars).toBe(4);                                   // escaped characters count twice
  });
  it('a phone number only: local, international or a WhatsApp id; never another platform\'s id', () => {
    expect(smsNumber('050-123-4567')).toBe('+972501234567');
    expect(smsNumber('972501234567@s.whatsapp.net')).toBe('+972501234567');
    expect(smsNumber('+1 (555) 123-4567')).toBe('+15551234567');
    for (const bad of ['IL.12345678@bsuid', 'dana@example.com', '123', '', null]) expect(smsNumber(bad)).toBeNull();
    expect(maskNumber('+972501234567')).toBe('+97250•••4567');
  });
});

describe('SMS: settings, test send, one-time code, reminders', () => {
  const ORIGIN = 'https://panel.test';
  const PW = 'correct-horse-battery';
  const SID = 'AC' + 'a'.repeat(32);
  const SECRET = 'b'.repeat(32);
  const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test', ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false', MEDIA_ALLOW_UNSCANNED: 'true' });
  const db = createDb(cfg.DATABASE_URL);
  let app: Awaited<ReturnType<typeof buildApp>>;
  let mgr: ChannelManager;
  const cookies: Record<string, string> = {};
  let ip = 0;
  const sent: { url: string; auth: string; body: URLSearchParams }[] = [];
  let twilio: () => Response = () => Response.json({ sid: 'SM' + 'c'.repeat(32), status: 'queued' }, { status: 201 });
  const realFetch = globalThis.fetch;
  const call = (who: string | null, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({ method, url, payload: payload as never, remoteAddress: `10.83.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, ...(who ? { cookie: cookies[who]! } : {}) } });
  class Fake implements ChannelAdapter {
    constructor(private c: AdapterContext) {}
    async start() { this.c.events.onStatus('connected'); }
    async stop() {} async logout() {}
    async sendText() { return { externalMessageId: `t${Math.random()}` }; }
  }

  beforeAll(async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    mgr = new ChannelManager(db, cfg, ((_t, c) => new Fake(c)) as AdapterFactory);
    app = await buildApp(cfg, db, mgr);
    for (const [e, role] of [['adm@t.io', 'admin'], ['ag@t.io', 'agent']] as const) {
      await db.query(`INSERT INTO users (email,name,role,password_hash) VALUES ($1,$1,$2,$3)`, [e, role, await hashPassword(PW)]);
      cookies[e] = `botwa_sid=${(await call(null, 'POST', '/auth/login', { email: e, password: PW })).cookies[0]!.value}`;
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith('https://api.twilio.com/')) return realFetch(input, init);
      sent.push({ url, auth: (init?.headers as Record<string, string>).authorization ?? '', body: new URLSearchParams(String(init?.body)) });
      return twilio();
    });
  });
  afterEach(() => { sent.length = 0; });
  afterAll(async () => { vi.restoreAllMocks(); await mgr.stopAll(); await app.close(); await db.end(); });

  it('settings: admins only, the secret is write-only and stored encrypted, a complete setup is required to switch on', async () => {
    expect((await call('ag@t.io', 'GET', '/settings/sms')).statusCode).toBe(403);
    expect((await call('adm@t.io', 'GET', '/settings/sms')).json()).toMatchObject({ enabled: false, monthlyLimit: 300, hasSecret: false, usedThisMonth: 0 });
    expect((await call('adm@t.io', 'PUT', '/settings/sms', { enabled: true, provider: 'twilio', accountSid: SID, from: '+15550001111', monthlyLimit: 300 })).json()).toEqual({ error: 'sms_incomplete' });
    expect((await call('adm@t.io', 'PUT', '/settings/sms', { enabled: true, provider: 'twilio', accountSid: 'nope', from: '+15550001111', monthlyLimit: 300, secret: SECRET })).statusCode).toBe(400);
    const ok = await call('adm@t.io', 'PUT', '/settings/sms', { enabled: true, provider: 'twilio', accountSid: SID, from: 'Technion', monthlyLimit: 300, secret: SECRET });
    expect(ok.json()).toMatchObject({ enabled: true, from: 'Technion', hasSecret: true });
    expect(JSON.stringify(ok.json())).not.toContain(SECRET);
    expect(JSON.stringify((await db.query(`SELECT value FROM settings WHERE key = 'sms_secret'`)).rows[0].value)).not.toContain(SECRET);
    // saving again without the secret keeps it
    expect((await call('adm@t.io', 'PUT', '/settings/sms', { enabled: true, provider: 'twilio', accountSid: SID, from: 'Technion', monthlyLimit: 300 })).json()).toMatchObject({ hasSecret: true });
  });

  it('a test SMS: Twilio\'s Messages API with Basic auth, logged with the number masked; Twilio refusals are named', async () => {
    const r = await call('adm@t.io', 'POST', '/settings/sms/test', { to: '050-123-4567' });
    expect(r.json()).toEqual({ ok: true, segments: 1 });
    expect(sent[0]!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`);
    expect(sent[0]!.auth).toBe(`Basic ${Buffer.from(`${SID}:${SECRET}`).toString('base64')}`);
    expect(Object.fromEntries(sent[0]!.body)).toMatchObject({ To: '+972501234567', From: 'Technion' });
    const log = (await db.query(`SELECT to_masked, purpose, status FROM sms_log ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(log).toEqual({ to_masked: '+97250•••4567', purpose: 'test', status: 'sent' });
    expect((await call('adm@t.io', 'POST', '/settings/sms/test', { to: 'abc' })).json()).toEqual({ error: 'sms_bad_number' });
    twilio = () => Response.json({ code: 20003, message: 'Authenticate' }, { status: 401 });
    expect((await call('adm@t.io', 'POST', '/settings/sms/test', { to: '0501234567' })).json()).toMatchObject({ error: 'sms_auth_failed', detail: '20003: Authenticate' });
    twilio = () => Response.json({ sid: 'SM' + 'd'.repeat(32), status: 'queued' }, { status: 201 });
  });

  it('the one-time code of a form by SMS, to the WhatsApp number of the chat only; the team never sees the code', async () => {
    const d = await PDFDocument.create(); d.addPage([595, 842]);
    const userId = (await db.query(`SELECT id FROM users WHERE email = 'adm@t.io'`)).rows[0].id;
    const t = await createTemplate(db, { title: 'הצהרה', pdf: Buffer.from(await d.save()), sourceName: 'x.pdf', userId });
    const f: Field = { id: 'n', type: 'text', label: 'שם', page: 0, x: 10, y: 10, w: 100, h: 20, required: true, prefill: null, locked: false, hint: '' };
    await db.query('UPDATE form_templates SET fields = $2 WHERE id = $1', [t.id, JSON.stringify([f])]);
    const mk = async (type: string, ext: string) => {
      const ch = (await db.query(`INSERT INTO channels (type, label) VALUES ($1, $1) RETURNING id`, [type])).rows[0].id;
      const ct = (await db.query(`INSERT INTO contacts (channel_id, external_id) VALUES ($1,$2) RETURNING id`, [ch, ext])).rows[0].id;
      const conv = (await db.query(`INSERT INTO conversations (channel_id, contact_id) VALUES ($1,$2) RETURNING id`, [ch, ct])).rows[0].id;
      return { convId: conv, ...(await createRequest(db, cfg, { templateId: t.id, conversationId: conv, userId, days: 3 })) };
    };
    const wa = await mk('whatsapp', '972521112233@s.whatsapp.net');
    expect((await call(null, 'GET', `/f/${wa.token}/info`)).json().smsOtp).toBe(true);
    const r = await call(null, 'POST', `/f/${wa.token}/otp`, { via: 'sms' });
    expect(r.json()).toEqual({ ok: true });
    expect(sent[0]!.body.get('To')).toBe('+972521112233');
    const code = /(\d{6})/.exec(sent[0]!.body.get('Body')!)![1]!;
    const note = (await db.query(`SELECT body FROM conversation_notes WHERE conversation_id = $1`, [wa.convId])).rows[0].body as string;
    expect(note).toContain('נשלח ב-SMS ל-+97252•••2233');
    expect(note).not.toContain(code);
    expect((await call(null, 'POST', `/f/${wa.token}/verify`, { code })).statusCode).toBe(200);   // the SMS code verifies like the chat code
    // a Telegram chat: its id is not a phone number, so no SMS
    const tg = await mk('telegram', '123456789');
    expect((await call(null, 'GET', `/f/${tg.token}/info`)).json().smsOtp).toBe(false);
    expect((await call(null, 'POST', `/f/${tg.token}/otp`, { via: 'sms' })).json()).toEqual({ error: 'no_phone' });
  });

  it('reminders of a group by SMS to those WhatsApp could not reach; opted-out people and the monthly cap are respected', async () => {
    const userId = (await db.query(`SELECT id FROM users WHERE email = 'adm@t.io'`)).rows[0].id;
    const tpl = (await db.query(`SELECT id FROM form_templates LIMIT 1`)).rows[0].id;
    const batch = (await db.query(`INSERT INTO form_batches (template_id, title, total) VALUES ($1, 'b', 3) RETURNING id`, [tpl])).rows[0].id;
    const ch = (await db.query(`INSERT INTO channels (type, label) VALUES ('whatsapp', 'b') RETURNING id`)).rows[0].id;
    const add = async (phone: string, optedOut = false) => {
      const ct = (await db.query(`INSERT INTO contacts (channel_id, external_id, opted_out) VALUES ($1,$2,$3) RETURNING id`, [ch, `${phone}@s.whatsapp.net`, optedOut])).rows[0].id;
      const conv = (await db.query(`INSERT INTO conversations (channel_id, contact_id) VALUES ($1,$2) RETURNING id`, [ch, ct])).rows[0].id;
      const r = await createRequest(db, cfg, { templateId: tpl, conversationId: conv, userId, days: 3, batchId: batch, keepLink: true });
      await db.query(`UPDATE form_requests SET delivery = 'link_only' WHERE id = $1`, [r.id]);
      return r;
    };
    await add('972531110001'); await add('972531110002'); await add('972531110003', true);
    // without SMS: nobody can be reminded
    expect(await remindBatch(db, cfg, mgr, batch, userId)).toEqual({ reminded: 0, skipped: 0, bySms: 0, smsFailed: 0 });
    const r = await remindBatch(db, cfg, mgr, batch, userId, { sms: true });
    expect(r).toMatchObject({ reminded: 2, bySms: 2, smsFailed: 1 });                          // the third asked to stop
    expect(sent.map((s) => s.body.get('To'))).toEqual(['+972531110001', '+972531110002']);
    expect(sent[0]!.body.get('Body')).toMatch(/מחכה לחתימתך: https:\/\/panel\.test\/f\/f_/);
    // the cap: nothing more this month
    await db.query(`UPDATE settings SET value = jsonb_set(value, '{monthlyLimit}', '5') WHERE key = 'sms'`);
    await db.query(`UPDATE form_requests SET reminded_at = NULL WHERE batch_id = $1`, [batch]);
    sent.length = 0;
    const capped = await remindBatch(db, cfg, mgr, batch, userId, { sms: true });
    expect(capped.bySms).toBe(0);
    expect(sent).toEqual([]);
    expect((await call('adm@t.io', 'POST', '/settings/sms/test', { to: '0501234567' })).json()).toEqual({ error: 'sms_monthly_limit' });
  });
});

import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ChannelManager, createDefaultFactory } from '../src/channels/manager.js';
import { metaCheckError, isGraphMediaUrl, verifySignature, WhatsAppCloudAdapter } from '../src/channels/whatsapp-cloud.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';

const ORIGIN = 'https://panel.test';
const PW = 'correct-horse-battery';
const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test';
const db = createDb(DB_URL);
const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: DB_URL, ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false' });
const SECRET = 'app-secret-0123456789abcdef';
const TOKEN = 'EAAG' + 'x'.repeat(40);

describe('helpers', () => {
  it('names the reason of a failed credentials check from Meta\'s error code', () => {
    expect(metaCheckError(401, 190)).toBe('meta_auth_failed');
    expect(metaCheckError(400, 100)).toBe('meta_phone_not_found');
    expect(metaCheckError(403, 10)).toBe('meta_permission_denied');
    expect(metaCheckError(400, 4)).toBe('meta_rate_limited');
    expect(metaCheckError(500, undefined)).toBe('meta_check_failed');
  });

  it('verifies HMAC signatures and restricts media hosts', () => {
    const body = Buffer.from('{"a":1}');
    const sig = 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');
    expect(verifySignature(SECRET, body, sig)).toBe(true);
    expect(verifySignature(SECRET, body, sig.replace(/.$/, (c) => (c === '0' ? '1' : '0')))).toBe(false);
    expect(verifySignature(SECRET, Buffer.from('{"a":2}'), sig)).toBe(false);
    expect(verifySignature(SECRET, body, undefined)).toBe(false);
    expect(verifySignature(SECRET, body, 'sha256=zz')).toBe(false);
    expect(isGraphMediaUrl('https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1')).toBe(true);
    for (const bad of ['http://lookaside.fbsbx.com/x', 'https://169.254.169.254/x', 'https://fbsbx.com.evil.io/x', 'https://evil.io/fbsbx.com', 'https://u:p@lookaside.fbsbx.com/x']) expect(isGraphMediaUrl(bad), bad).toBe(false);
  });
});

describe('official WhatsApp channel', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const calls: { url: string; init?: RequestInit }[] = [];
  let sendResponse: () => Response = () => Response.json({ messages: [{ id: 'wamid.OUT1' }] });
  const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    if (init?.method === 'POST' && url.endsWith('/messages')) return sendResponse();
    if (url.includes('/subscribed_apps')) return init?.method === 'POST' ? subscribeResponse() : Response.json({ data: subscribedData });
    return infoResponse();
  };
  let subscribeResponse: () => Response = () => Response.json({ success: true });
  let subscribedData: unknown[] = [];
  let infoResponse: () => Response = () => Response.json({ display_phone_number: '+972 50-000-0000', verified_name: 'Shop' });
  const cookies: Record<string, string> = {};
  let ip = 0;
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, who?: string, payload?: object, extra: Record<string, string> = {}) =>
    app.inject({ method, url, payload, remoteAddress: `10.90.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, ...(who ? { cookie: cookies[who]! } : {}), ...extra } });
  let channelId = '';
  let verifyToken = '';

  const hook = async (obj: unknown, sign = true) => {
    const raw = JSON.stringify(obj);
    const sig = 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex');
    return app.inject({ method: 'POST', url: `/webhooks/whatsapp/${channelId}`, payload: raw, remoteAddress: '203.0.113.9', headers: { 'content-type': 'application/json', ...(sign ? { 'x-hub-signature-256': sig } : {}) } }); // no Origin header, like Meta
  };
  const msg = (id: string, text: string, ts = Math.floor(Date.now() / 1000)) => ({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: { contacts: [{ wa_id: '972501112233', profile: { name: 'Dana' } }], messages: [{ id, from: '972501112233', timestamp: String(ts), type: 'text', text: { body: text } }] } }] }],
  });

  beforeAll(async () => {
    await migrate(db);
    await db.query(`TRUNCATE sessions, users, channels, settings, audit_log CASCADE`);
    const mgr = new ChannelManager(db, cfg, (type, ctx) => (type === 'whatsapp_cloud' ? new WhatsAppCloudAdapter(ctx, fakeFetch) : createDefaultFactory(cfg)(type, ctx)));
    app = await buildApp(cfg, db, mgr);
    for (const [e, role] of [['adm@t.io', 'admin'], ['ag@t.io', 'agent']] as const) {
      await db.query(`INSERT INTO users (email,name,role,password_hash) VALUES ($1,$1,$2,$3)`, [e, role, await hashPassword(PW)]);
      cookies[e] = `botwa_sid=${(await call('POST', '/auth/login', undefined, { email: e, password: PW })).cookies[0]!.value}`;
    }
    await db.query(`UPDATE users SET totp_enabled = true WHERE email = 'adm@t.io'`).catch(() => undefined);
  });
  afterAll(async () => { await app.close(); await db.end(); });

  it('creates the channel, stores credentials encrypted, connects, and shows webhook details to admins only', async () => {
    const c = await call('POST', '/channels', 'adm@t.io', { type: 'whatsapp_cloud', label: 'Official' });
    expect(c.statusCode).toBe(201);
    channelId = c.json().id;
    expect((await call('GET', `/channels/${channelId}/cloud`, 'adm@t.io')).json()).toMatchObject({ configured: false });
    expect((await call('PUT', `/channels/${channelId}/cloud`, 'ag@t.io', { phoneNumberId: '1234567890', accessToken: TOKEN, appSecret: SECRET })).statusCode).toBe(403);
    expect((await call('PUT', `/channels/${channelId}/cloud`, 'adm@t.io', { phoneNumberId: 'abc', accessToken: TOKEN, appSecret: SECRET })).json()).toEqual({ error: 'invalid_phone_number_id' });
    expect((await call('PUT', `/channels/${channelId}/cloud`, 'adm@t.io', { phoneNumberId: '1234567890', accessToken: 'short', appSecret: SECRET })).json()).toEqual({ error: 'invalid_token_format' });
    expect((await call('PUT', `/channels/${channelId}/cloud`, 'adm@t.io', { phoneNumberId: '1234567890', accessToken: TOKEN, appSecret: 'bad secret!' })).json()).toEqual({ error: 'invalid_app_secret_format' });
    expect((await call('PUT', `/channels/${channelId}/cloud`, 'adm@t.io', { phoneNumberId: '1234567890', accessToken: TOKEN, appSecret: SECRET, wabaId: 'x1' })).json()).toEqual({ error: 'invalid_waba_id' });
    // a token pasted with "Bearer " in front and spaces around it is accepted as the token itself
    const put = await call('PUT', `/channels/${channelId}/cloud`, 'adm@t.io', { phoneNumberId: '1234567890', accessToken: `  Bearer ${TOKEN} `, appSecret: SECRET });
    expect(put.json()).toMatchObject({ ok: true, status: 'connected' });
    const cfgOut = (await call('GET', `/channels/${channelId}/cloud`, 'adm@t.io')).json();
    expect(cfgOut).toMatchObject({ configured: true, phoneNumberId: '1234567890', webhookUrl: `${ORIGIN}/webhooks/whatsapp/${channelId}` });
    expect(JSON.stringify(cfgOut)).not.toContain(TOKEN);
    verifyToken = cfgOut.verifyToken;
    const stored = (await db.query(`SELECT value FROM channel_auth WHERE channel_id = $1`, [channelId]).catch(() => ({ rows: [] }))).rows;
    expect(JSON.stringify(stored)).not.toContain(TOKEN);
    expect((await db.query(`SELECT 1 FROM audit_log WHERE action='channel.cloud_credentials'`)).rowCount).toBe(1);
    // re-saving keeps the verify token (so the Meta dashboard value stays valid)
    await call('PUT', `/channels/${channelId}/cloud`, 'adm@t.io', { phoneNumberId: '1234567890', accessToken: TOKEN, appSecret: SECRET });
    expect((await call('GET', `/channels/${channelId}/cloud`, 'adm@t.io')).json().verifyToken).toBe(verifyToken);
  });

  it('says why Meta refused the credentials (they are saved either way)', async () => {
    const put = () => call('PUT', `/channels/${channelId}/cloud`, 'adm@t.io', { phoneNumberId: '1234567890', accessToken: TOKEN, appSecret: SECRET });
    infoResponse = () => Response.json({ error: { message: 'Error validating access token', type: 'OAuthException', code: 190 } }, { status: 401 });
    expect((await put()).json()).toEqual({ ok: true, status: 'error', error: 'meta_auth_failed' });
    infoResponse = () => Response.json({ error: { message: 'Unsupported get request', type: 'GraphMethodException', code: 100 } }, { status: 400 });
    expect((await put()).json()).toMatchObject({ status: 'error', error: 'meta_phone_not_found' });
    infoResponse = () => Response.json({ error: { code: 200 } }, { status: 403 });
    expect((await put()).json()).toMatchObject({ error: 'meta_permission_denied' });
    infoResponse = () => { throw new TypeError('fetch failed'); };
    expect((await put()).json()).toMatchObject({ error: 'meta_unreachable' });
    infoResponse = () => Response.json({ display_phone_number: '+972 50-000-0000', verified_name: 'Shop' });
    expect((await put()).json()).toEqual({ ok: true, status: 'connected', subscribe: 'no_waba' });
  });

  it('links the business account to the app on save and on demand, and shows when Meta last delivered', async () => {
    const WABA = '9876543210';
    const put = await call('PUT', `/channels/${channelId}/cloud`, 'adm@t.io', { phoneNumberId: '1234567890', accessToken: TOKEN, appSecret: SECRET, wabaId: WABA });
    expect(put.json()).toEqual({ ok: true, status: 'connected', subscribe: 'ok' });
    const sub = calls.filter((c) => c.url.includes(`/${WABA}/subscribed_apps`) && c.init?.method === 'POST');
    expect(sub.length).toBe(1);
    expect((sub[0]!.init!.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    // the check button: agents may not, admins get the result and whether an app is subscribed
    expect((await call('POST', `/channels/${channelId}/cloud/subscribe`, 'ag@t.io')).statusCode).toBe(403);
    subscribedData = [{ whatsapp_business_api_data: { id: '1', name: 'Botwa' } }];
    expect((await call('POST', `/channels/${channelId}/cloud/subscribe`, 'adm@t.io')).json()).toEqual({ result: 'ok', subscribed: true });
    subscribeResponse = () => Response.json({ error: { code: 200 } }, { status: 403 });
    subscribedData = [];
    expect((await call('POST', `/channels/${channelId}/cloud/subscribe`, 'adm@t.io')).json()).toEqual({ result: 'meta_permission_denied', subscribed: false });
    subscribeResponse = () => Response.json({ success: true });
    expect((await db.query(`SELECT 1 FROM audit_log WHERE action='channel.cloud_subscribe'`)).rowCount).toBe(2);
    expect((await call('POST', `/channels/00000000-0000-4000-8000-000000000000/cloud/subscribe`, 'adm@t.io')).statusCode).toBe(404);
    expect((await call('GET', `/channels/${channelId}/cloud`, 'adm@t.io')).json().lastWebhookAt).toBeNull();
  });

  it('answers the webhook handshake only for the right verify token', async () => {
    const url = `/webhooks/whatsapp/${channelId}`;
    const ok = await app.inject({ method: 'GET', url: `${url}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verifyToken)}&hub.challenge=12345` });
    expect(ok.statusCode).toBe(200); expect(ok.body).toBe('12345');
    expect((await app.inject({ method: 'GET', url: `${url}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=12345` })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `${url}?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=%3Cscript%3E` })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/webhooks/whatsapp/00000000-0000-4000-8000-000000000000?hub.mode=subscribe` })).statusCode).toBe(404);
  });

  it('ingests signed webhooks only, deduplicates, and keeps the contact name', async () => {
    expect((await hook(msg('wamid.A', 'hello'), false)).statusCode).toBe(403);
    expect((await db.query(`SELECT count(*)::int AS n FROM messages`)).rows[0].n).toBe(0);
    expect((await hook(msg('wamid.A', 'שלום'))).statusCode).toBe(200);
    expect((await hook(msg('wamid.A', 'שלום'))).statusCode).toBe(200); // redelivery
    const rows = (await db.query(`SELECT m.body, ct.external_id, ct.display_name FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN contacts ct ON ct.id = c.contact_id`)).rows;
    expect(rows).toEqual([{ body: 'שלום', external_id: '972501112233@s.whatsapp.net', display_name: 'Dana' }]);
    // status callbacks and unrelated fields are ignored without error
    expect((await hook({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'x', status: 'delivered' }] } }] }] })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/webhooks/whatsapp/${channelId}`, payload: 'not json', headers: { 'content-type': 'application/json' } })).statusCode).toBe(403);
  });

  it('records when the last signed webhook arrived', async () => {
    expect((await hook(msg('wamid.T1', 'ping'))).statusCode).toBe(200);
    const at = (await call('GET', `/channels/${channelId}/cloud`, 'adm@t.io')).json().lastWebhookAt as string;
    expect(Date.now() - Date.parse(at)).toBeLessThan(60_000);
  });

  it('sends replies through the Graph API; policy rejections are 409 and never pause the channel', async () => {
    const conv = (await db.query(`SELECT id FROM conversations LIMIT 1`)).rows[0].id as string;
    calls.length = 0;
    const r = await call('POST', `/conversations/${conv}/messages`, 'adm@t.io', { text: 'מה שלומך' });
    expect(r.statusCode).toBe(201);
    const sent = calls.find((c) => c.init?.method === 'POST' && c.url.endsWith('/1234567890/messages'))!;
    expect(sent.url).toContain('https://graph.facebook.com/v21.0/');
    expect(JSON.parse(sent.init!.body as string)).toMatchObject({ messaging_product: 'whatsapp', to: '972501112233', type: 'text', text: { body: 'מה שלומך' } });
    expect((sent.init!.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);

    sendResponse = () => Response.json({ error: { code: 131047, message: 're-engagement' } }, { status: 400 });
    for (let i = 0; i < 5; i++) expect((await call('POST', `/conversations/${conv}/messages`, 'adm@t.io', { text: `x${i}` })).json()).toEqual({ error: 'outside_reply_window' });
    expect((await db.query(`SELECT count(*)::int AS n FROM channel_events WHERE kind = 'auto_paused'`)).rows[0].n).toBe(0);
    sendResponse = () => Response.json({ messages: [{ id: 'wamid.OUT2' }] });
    expect((await call('POST', `/conversations/${conv}/messages`, 'adm@t.io', { text: 'שוב' })).statusCode).toBe(201);

    // invalid token => channel flagged as error, not retried blindly
    sendResponse = () => Response.json({ error: { code: 190 } }, { status: 401 });
    expect((await call('POST', `/conversations/${conv}/messages`, 'adm@t.io', { text: 'tok' })).statusCode).toBe(502);
    expect((await call('GET', '/channels', 'adm@t.io')).json().find((c: { id: string }) => c.id === channelId).status).toBe('error');
    sendResponse = () => Response.json({ messages: [{ id: 'wamid.OUT3' }] });
  });

  it('enforces the 24h customer-service window server-side', async () => {
    await call('PUT', `/channels/${channelId}/cloud`, 'adm@t.io', { phoneNumberId: '1234567890', accessToken: TOKEN, appSecret: SECRET });
    const conv = (await db.query(`SELECT id FROM conversations LIMIT 1`)).rows[0].id as string;
    await db.query(`UPDATE messages SET created_at = now() - interval '30 hours' WHERE conversation_id = $1 AND direction = 'in'`, [conv]);
    calls.length = 0;
    const r = await call('POST', `/conversations/${conv}/messages`, 'adm@t.io', { text: 'late' });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'outside_reply_window' });
    expect(calls.filter((c) => c.init?.method === 'POST')).toHaveLength(0); // nothing reached Meta
  });
});

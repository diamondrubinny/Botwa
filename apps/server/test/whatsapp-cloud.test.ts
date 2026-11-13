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
const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: DB_URL, ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', MEDIA_ALLOW_UNSCANNED: 'true' });
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
    if (url.includes('/app?fields=id')) return Response.json({ id: '5550001112' });
    if (init?.method === 'POST' && url.includes('/5550001112/uploads?')) return Response.json({ id: 'upload:MTphdHRhY2htZW50OjEyMw==?sig=ARZx-9_q' });   // Meta's real shape
    if (init?.method === 'POST' && url.endsWith('/upload:MTphdHRhY2htZW50OjEyMw==?sig=ARZx-9_q')) return Response.json({ h: 'HANDLE_1' });
    if (init?.method === 'POST' && url.endsWith('/1234567890/whatsapp_business_profile')) return profileResponse();
    if (url.includes('/5550001112/subscriptions')) {
      if (init?.method === 'POST') { appSubPosts.push({ body: String(init.body), auth: (init.headers as Record<string, string>).authorization ?? '' }); appSubs = [{ object: 'whatsapp_business_account', callback_url: `${ORIGIN}/webhooks/whatsapp/${channelId}`, active: true, fields: [{ name: 'messages' }] }]; return Response.json({ success: true }); }
      return Response.json({ data: appSubs });
    }
    if (url.includes('fields=webhook_configuration')) return Response.json({ webhook_configuration: webhookConf, id: '1234567890' });
    if (init?.method === 'POST' && /\/1234567890$/.test(url)) { routed.push(JSON.parse(init.body as string)); return Response.json({ success: true }); }
    if (url.includes('/subscribed_apps')) return init?.method === 'POST' ? subscribeResponse() : Response.json({ data: subscribedData });
    return infoResponse();
  };
  let subscribeResponse: () => Response = () => Response.json({ success: true });
  let subscribedData: unknown[] = [];
  let webhookConf: Record<string, string> = { application: 'https://old-provider.example/hook' };
  const routed: unknown[] = [];
  let appSubs: unknown[] = [];
  let profileResponse: () => Response = () => Response.json({ success: true });
  const appSubPosts: { body: string; auth: string }[] = [];
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
    const chk = (await call('POST', `/channels/${channelId}/cloud/subscribe`, 'adm@t.io')).json();
    expect(chk).toMatchObject({ result: 'ok', subscribed: true, webhook: { effective: 'https://old-provider.example/hook', ours: `${ORIGIN}/webhooks/whatsapp/${channelId}`, matches: false } });
    // an alternate callback URL on the number wins over the app's
    webhookConf = { application: `${ORIGIN}/webhooks/whatsapp/${channelId}`, phone_number: 'https://other.example/x' };
    expect((await call('POST', `/channels/${channelId}/cloud/subscribe`, 'adm@t.io')).json().webhook).toMatchObject({ effective: 'https://other.example/x', matches: false });
    expect((await call('POST', `/channels/${channelId}/cloud/route-here`, 'ag@t.io')).statusCode).toBe(403);
    expect((await call('POST', `/channels/${channelId}/cloud/route-here`, 'adm@t.io')).json()).toEqual({ result: 'ok' });
    expect(routed.at(-1)).toEqual({ webhook_configuration: { override_callback_uri: `${ORIGIN}/webhooks/whatsapp/${channelId}`, verify_token: verifyToken } });
    webhookConf = { application: `${ORIGIN}/webhooks/whatsapp/${channelId}` };
    expect((await call('POST', `/channels/${channelId}/cloud/subscribe`, 'adm@t.io')).json().webhook).toMatchObject({ matches: true });
    // the app-level subscription: not subscribed to "messages" -> say so; one click subscribes it with this server's URL
    expect((await call('POST', `/channels/${channelId}/cloud/subscribe`, 'adm@t.io')).json().appFields).toMatchObject({ appId: '5550001112', messages: false });
    expect((await call('POST', `/channels/${channelId}/cloud/subscribe-fields`, 'ag@t.io')).statusCode).toBe(403);
    expect((await call('POST', `/channels/${channelId}/cloud/subscribe-fields`, 'adm@t.io')).json()).toEqual({ result: 'ok' });
    const post = new URLSearchParams(appSubPosts.at(-1)!.body);
    expect(Object.fromEntries(post)).toMatchObject({ object: 'whatsapp_business_account', callback_url: `${ORIGIN}/webhooks/whatsapp/${channelId}`, fields: 'messages', verify_token: verifyToken });
    expect(appSubPosts.at(-1)!.auth).toBe(`Bearer 5550001112|${SECRET}`);
    expect((await call('POST', `/channels/${channelId}/cloud/subscribe`, 'adm@t.io')).json().appFields).toMatchObject({ messages: true, urlMatches: true });
    subscribeResponse = () => Response.json({ error: { code: 200 } }, { status: 403 });
    subscribedData = [];
    expect((await call('POST', `/channels/${channelId}/cloud/subscribe`, 'adm@t.io')).json()).toMatchObject({ result: 'meta_permission_denied', subscribed: false });
    subscribeResponse = () => Response.json({ success: true });
    expect((await db.query(`SELECT 1 FROM audit_log WHERE action='channel.cloud_subscribe'`)).rowCount).toBe(6);
    expect((await db.query(`SELECT 1 FROM audit_log WHERE action='channel.cloud_route_here'`)).rowCount).toBe(1);
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

  it('tells apart "Meta never reached us" from a wrong App secret or verify token', async () => {
    const last = async () => (await call('GET', `/channels/${channelId}/cloud`, 'adm@t.io')).json().lastAttempt;
    const raw = JSON.stringify(msg('wamid.SIG', 'x'));
    await app.inject({ method: 'POST', url: `/webhooks/whatsapp/${channelId}`, payload: raw, headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', 'a-different-secret').update(raw).digest('hex') } });
    expect((await last()).outcome).toBe('bad_signature');
    await app.inject({ method: 'POST', url: `/webhooks/whatsapp/${channelId}`, payload: raw, headers: { 'content-type': 'application/json' } });
    expect((await last()).outcome).toBe('unsigned');
    await app.inject({ url: `/webhooks/whatsapp/${channelId}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1` });
    expect((await last()).outcome).toBe('handshake_bad_token');
    await app.inject({ url: `/webhooks/whatsapp/${channelId}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verifyToken)}&hub.challenge=1` });
    expect((await last()).outcome).toBe('handshake_ok');
    await hook(msg('wamid.SIG2', 'ok'));
    expect((await last()).outcome).toBe('ok');
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

  it('changes the business profile picture: upload session, the bytes, then the profile; small or fake images refused', async () => {
    const PNG200 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAMgAAADICAIAAAAiOjnJAAABdklEQVR42u3SMREAMAgAsVJfGEI5MjDBwJBI+Puo7AfbvgQYC2NhLDAWxsJYYCyMhbHAWBgLY4GxMBbGAmNhLIwFxsJYGAuMhbEwFhgLY2EsMBbGwlhgLIyFscBYGAtjgbEwFsYCY2EsjAXGwlgYC4yFsTAWGAtjYSwwFsbCWGAsjIWxwFgYC2OBsTAWxgJjYSyMBcbCWBgLjIWxMBYYC2NhLDAWxsJYYCyMhbHAWBgLY4GxMBbGwlhgLIyFscBYGAtjgbEwFsYCY2EsjAXGwlgYC4yFsTAWGAtjYSwwFsbCWGAsjIWxwFgYC2OBsTAWxgJjYSyMBcbCWBgLjIWxMBYYC2NhLDAWxsJYYCyMhbHAWBgLY4GxMBbGAmNhLIwFxsJYGAuMhbEwFhgLY2EsMBbGwlhgLIyFscBYGAtjgbEwFsYCY2EsjIWxwFgYC2OBsTAWxgJjYSyMBcbCWBgLjIWxMBYYC2NhLDAWxsJYYCyMhbHAWFwzs5gDH6D8pLsAAAAASUVORK5CYII=', 'base64');
    const send = (who: string, bytes: Buffer, type = 'image/png') => {
      const b = '----pp';
      const body = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="p.png"\r\nContent-Type: ${type}\r\n\r\n`), bytes, Buffer.from(`\r\n--${b}--\r\n`)]);
      return app.inject({ method: 'POST', url: `/channels/${channelId}/profile-photo`, payload: body, remoteAddress: `10.90.9.${++ip % 250}`, headers: { origin: ORIGIN, cookie: cookies[who]!, 'content-type': `multipart/form-data; boundary=${b}` } });
    };
    await call('PUT', `/channels/${channelId}/cloud`, 'adm@t.io', { phoneNumberId: '1234567890', accessToken: TOKEN, appSecret: SECRET });
    expect((await send('ag@t.io', PNG200)).statusCode).toBe(403);
    expect((await send('adm@t.io', Buffer.from('GIF89a not a picture'))).json()).toEqual({ error: 'unsupported_image' });
    const tiny = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    expect((await send('adm@t.io', tiny)).json()).toEqual({ error: 'profile_photo_too_small' });
    calls.length = 0;
    expect((await send('adm@t.io', PNG200)).json()).toEqual({ result: 'ok' });
    const up = calls.find((c) => c.url.includes('/uploads?'))!;
    expect(up.url).toContain(`file_length=${PNG200.length}`);
    expect(up.url).toContain('file_type=image%2Fpng');
    const bytes = calls.find((c) => c.url.includes('/upload:MTphdHRhY2htZW50OjEyMw==?sig='))!;
    expect((bytes.init!.headers as Record<string, string>).authorization).toBe(`OAuth ${TOKEN}`);
    expect((bytes.init!.headers as Record<string, string>).file_offset).toBe('0');
    const prof = calls.find((c) => c.url.endsWith('/whatsapp_business_profile'))!;
    expect(JSON.parse(prof.init!.body as string)).toEqual({ messaging_product: 'whatsapp', profile_picture_handle: 'HANDLE_1' });
    // a refusal says at which step and what Meta said
    profileResponse = () => Response.json({ error: { code: 100, error_subcode: 2494102, message: 'Invalid parameter', error_user_msg: 'The image is too small' } }, { status: 400 });
    const bad = (await send('adm@t.io', PNG200)).json();
    expect(bad.result).toBe('meta_phone_not_found');
    expect(bad.detail).toContain('שמירה בפרופיל העסקי (HTTP 400, code 100/2494102): The image is too small');
    profileResponse = () => Response.json({ success: true });
    expect((await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'channel.profile_photo'`)).rows[0].n).toBe(2);
  });
});

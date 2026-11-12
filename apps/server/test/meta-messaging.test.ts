import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ChannelManager, createDefaultFactory } from '../src/channels/manager.js';
import { isMetaMediaUrl, MetaMessagingAdapter, splitText } from '../src/channels/meta-messaging.js';
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
const TOKEN = 'EAAG' + 'p'.repeat(40);
const PAGE = '111222333444';
const IG = '17841400000000';

describe('helpers', () => {
  it('splits long texts at natural boundaries within the limit', () => {
    const parts = splitText(`${'א'.repeat(900)}\n\n${'ב'.repeat(900)} ${'ג'.repeat(300)}`, 1000);
    expect(parts.every((p) => p.length <= 1000)).toBe(true);
    expect(parts.join('')).toBe(`${'א'.repeat(900)}${'ב'.repeat(900)}${'ג'.repeat(300)}`);
    expect(splitText('קצר', 1000)).toEqual(['קצר']);
    expect(splitText('x'.repeat(2500), 1000).map((p) => p.length)).toEqual([1000, 1000, 500]);
  });
  it('downloads attachments only from Meta and Instagram CDNs over https', () => {
    for (const ok of ['https://scontent.xx.fbcdn.net/v/t1/a.jpg', 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1', 'https://scontent.cdninstagram.com/x.jpg']) expect(isMetaMediaUrl(ok), ok).toBe(true);
    for (const bad of ['http://scontent.cdninstagram.com/x', 'https://cdninstagram.com.evil.io/x', 'https://169.254.169.254/', 'https://u:p@fbcdn.net/x', 'https://evil.io/?fbcdn.net']) expect(isMetaMediaUrl(bad), bad).toBe(false);
  });
});

describe('Messenger and Instagram channels', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const calls: { url: string; init?: RequestInit }[] = [];
  let sendResponse: () => Response = () => Response.json({ recipient_id: '1', message_id: 'm_OUT1' });
  let infoResponse: () => Response = () => Response.json({ id: PAGE, name: 'Shop' });
  let replyN = 0;
  const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    if (url.includes('/subscribed_apps')) return init?.method === 'POST' ? Response.json({ success: true }) : Response.json({ data: [{ id: 'app' }] });
    if (init?.method === 'POST' && url.endsWith('/messages')) return sendResponse();
    if (init?.method === 'POST' && /\/(comments|replies)$/.test(url)) return Response.json({ id: `reply_${++replyN}` });
    if (init?.method === 'POST' && /\/v21\.0\/[\d_]+$/.test(url)) return Response.json({ success: true });   // hide a comment
    if (/\/\d+\?fields=first_name/.test(url)) return Response.json({ first_name: 'Dana', last_name: 'Levi' });
    if (/\/\d+\?fields=name,username/.test(url)) return Response.json({ name: 'Noa IG', username: 'noa' });
    if (url.startsWith('https://scontent.xx.fbcdn.net/')) return new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
    if (url.startsWith('https://lookaside.fbsbx.com/')) return new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } });
    return infoResponse();
  };
  const cookies: Record<string, string> = {};
  let ip = 0;
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, who?: string, payload?: object) =>
    app.inject({ method, url, payload, remoteAddress: `10.91.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, ...(who ? { cookie: cookies[who]! } : {}) } });
  const ids: Record<'messenger' | 'instagram', string> = { messenger: '', instagram: '' };
  let verifyToken = '';
  const hook = (channelId: string, obj: unknown, sign = true) => {
    const raw = JSON.stringify(obj);
    const sig = 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex');
    return app.inject({ method: 'POST', url: `/webhooks/meta/${channelId}`, payload: raw, remoteAddress: '203.0.113.7', headers: { 'content-type': 'application/json', ...(sign ? { 'x-hub-signature-256': sig } : {}) } });
  };
  const fbMsg = (mid: string, text: string, extra: object = {}) => ({ object: 'page', entry: [{ id: PAGE, time: Date.now(), messaging: [{ sender: { id: '5550001' }, recipient: { id: PAGE }, timestamp: Date.now(), message: { mid, text, ...extra } }] }] });

  beforeAll(async () => {
    await migrate(db);
    await db.query(`TRUNCATE sessions, users, channels, settings, audit_log CASCADE`);
    const mgr = new ChannelManager(db, cfg, (type, ctx) => (type === 'messenger' || type === 'instagram' ? new MetaMessagingAdapter(ctx, type, fakeFetch) : createDefaultFactory(cfg)(type, ctx)));
    app = await buildApp(cfg, db, mgr);
    for (const [e, role] of [['adm@t.io', 'admin'], ['ag@t.io', 'agent']] as const) {
      await db.query(`INSERT INTO users (email,name,role,password_hash) VALUES ($1,$1,$2,$3)`, [e, role, await hashPassword(PW)]);
      cookies[e] = `botwa_sid=${(await call('POST', '/auth/login', undefined, { email: e, password: PW })).cookies[0]!.value}`;
    }
    await db.query(`UPDATE users SET totp_enabled = true WHERE email = 'adm@t.io'`).catch(() => undefined);
  });
  afterAll(async () => { await app.close(); await db.end(); });

  it('creates both channel types; credentials are admin-only, validated per field, stored encrypted, and subscribe the Page', async () => {
    for (const t of ['messenger', 'instagram'] as const) {
      const c = await call('POST', '/channels', 'adm@t.io', { type: t, label: t });
      expect(c.statusCode).toBe(201);
      ids[t] = c.json().id;
    }
    const id = ids.messenger;
    expect((await call('GET', `/channels/${id}/meta`, 'adm@t.io')).json()).toMatchObject({ configured: false, webhookUrl: `${ORIGIN}/webhooks/meta/${id}` });
    expect((await call('PUT', `/channels/${id}/meta`, 'ag@t.io', { pageId: PAGE, pageAccessToken: TOKEN, appSecret: SECRET })).statusCode).toBe(403);
    expect((await call('PUT', `/channels/${id}/meta`, 'adm@t.io', { pageId: 'abc', pageAccessToken: TOKEN, appSecret: SECRET })).json()).toEqual({ error: 'invalid_page_id' });
    expect((await call('PUT', `/channels/${id}/meta`, 'adm@t.io', { pageId: PAGE, pageAccessToken: 'short', appSecret: SECRET })).json()).toEqual({ error: 'invalid_token_format' });
    expect((await call('PUT', `/channels/${ids.instagram}/meta`, 'adm@t.io', { pageId: PAGE, pageAccessToken: TOKEN, appSecret: SECRET })).json()).toEqual({ error: 'invalid_ig_account_id' });
    calls.length = 0;
    const put = await call('PUT', `/channels/${id}/meta`, 'adm@t.io', { pageId: PAGE, pageAccessToken: `Bearer ${TOKEN}`, appSecret: SECRET });
    expect(put.json()).toEqual({ ok: true, status: 'connected', subscribe: 'ok' });
    const sub = calls.find((c) => c.url.includes(`/${PAGE}/subscribed_apps`) && c.init?.method === 'POST')!;
    expect(sub.url).toContain('subscribed_fields=messages,messaging_postbacks,message_reactions');
    const out = (await call('GET', `/channels/${id}/meta`, 'adm@t.io')).json();
    expect(out).toMatchObject({ configured: true, pageId: PAGE });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    verifyToken = out.verifyToken;
    expect(JSON.stringify((await db.query(`SELECT * FROM channel_auth WHERE channel_id = $1`, [id])).rows)).not.toContain(TOKEN);
    expect((await call('POST', `/channels/${id}/meta/subscribe`, 'adm@t.io')).json()).toEqual({ result: 'ok', subscribed: true });

    infoResponse = () => Response.json({ error: { code: 190 } }, { status: 401 });
    expect((await call('PUT', `/channels/${id}/meta`, 'adm@t.io', { pageId: PAGE, pageAccessToken: TOKEN, appSecret: SECRET })).json()).toMatchObject({ status: 'error', error: 'meta_auth_failed' });
    infoResponse = () => Response.json({ id: PAGE, name: 'Shop' });
    expect((await call('PUT', `/channels/${id}/meta`, 'adm@t.io', { pageId: PAGE, pageAccessToken: TOKEN, appSecret: SECRET })).json()).toMatchObject({ status: 'connected' });
    expect((await call('PUT', `/channels/${ids.instagram}/meta`, 'adm@t.io', { pageId: PAGE, pageAccessToken: TOKEN, appSecret: SECRET, igAccountId: IG })).json()).toMatchObject({ status: 'connected' });
  });

  it('answers the handshake only with the right verify token', async () => {
    const url = `/webhooks/meta/${ids.messenger}`;
    const ok = await app.inject({ url: `${url}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verifyToken)}&hub.challenge=987` });
    expect(ok.body).toBe('987');
    expect((await app.inject({ url: `${url}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=987` })).statusCode).toBe(403);
  });

  it('ingests signed Messenger webhooks: names, dedup, echoes ignored, quick replies as numbers, other Pages ignored', async () => {
    const id = ids.messenger;
    expect((await hook(id, fbMsg('m_1', 'שלום'), false)).statusCode).toBe(403);
    expect((await hook(id, fbMsg('m_1', 'שלום'))).statusCode).toBe(200);
    expect((await hook(id, fbMsg('m_1', 'שלום'))).statusCode).toBe(200);   // redelivery
    await hook(id, fbMsg('m_echo', 'from us', { is_echo: true }));
    await hook(id, fbMsg('m_qr', 'אפשרות שתיים', { quick_reply: { payload: '2' } }));
    await hook(id, { ...fbMsg('m_other', 'x'), entry: [{ id: '999999', messaging: [{ sender: { id: '5550002' }, recipient: { id: '999999' }, timestamp: Date.now(), message: { mid: 'm_other', text: 'x' } }] }] });
    await hook(id, { object: 'instagram', entry: [] });   // wrong object for this channel
    const rows = (await db.query(`SELECT m.body, m.external_id, ct.display_name, ct.external_id AS contact FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN contacts ct ON ct.id = c.contact_id WHERE c.channel_id = $1 AND m.direction = 'in' ORDER BY m.created_at`, [id])).rows;
    expect(rows.map((r) => r.body)).toEqual(['שלום', '2']);
    expect(rows[0]).toMatchObject({ display_name: 'Dana Levi', contact: '5550001@messenger' });
  });

  it('keeps a picture from Meta\'s CDN and refuses a redirect away from it', async () => {
    const id = ids.messenger;
    await hook(id, fbMsg('m_img', '', { attachments: [{ type: 'image', payload: { url: 'https://scontent.xx.fbcdn.net/v/pic.png' } }] }));
    await hook(id, fbMsg('m_redir', '', { attachments: [{ type: 'image', payload: { url: 'https://lookaside.fbsbx.com/x' } }] }));
    expect(calls.some((c) => c.url.startsWith('https://evil.example'))).toBe(false);
    const att = (await db.query(`SELECT m.external_id, a.status, a.detail FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.external_id IN ('m_img','m_redir') ORDER BY m.external_id`)).rows;
    expect(att.find((a) => a.external_id === 'm_redir')).toMatchObject({ status: 'blocked' });
    expect(att.find((a) => a.external_id === 'm_img')).toBeTruthy();
  });

  it('Instagram: only the linked account\'s entries; replies go out through the Page with the 24h window enforced', async () => {
    const id = ids.instagram;
    await hook(id, { object: 'instagram', entry: [{ id: IG, time: Date.now(), messaging: [{ sender: { id: '7770001' }, recipient: { id: IG }, timestamp: Date.now(), message: { mid: 'ig_1', text: 'היי מאינסטגרם' } }] }] });
    await hook(id, { object: 'instagram', entry: [{ id: IG, time: Date.now(), messaging: [{ sender: { id: IG }, recipient: { id: '7770001' }, timestamp: Date.now(), message: { mid: 'ig_echo', text: 'echo', is_echo: true } }] }] });
    const conv = (await db.query(`SELECT c.id FROM conversations c WHERE c.channel_id = $1`, [id])).rows;
    expect(conv).toHaveLength(1);
    calls.length = 0;
    const long = 'ת'.repeat(1500);
    expect((await call('POST', `/conversations/${conv[0].id}/messages`, 'adm@t.io', { text: long })).statusCode).toBe(201);
    const sent = calls.filter((c) => c.init?.method === 'POST' && c.url.endsWith(`/${PAGE}/messages`));
    expect(sent).toHaveLength(2);   // Instagram's 1000-character limit: split in two
    expect(JSON.parse(sent[0]!.init!.body as string)).toMatchObject({ recipient: { id: '7770001' }, messaging_type: 'RESPONSE' });

    sendResponse = () => Response.json({ error: { code: 10, error_subcode: 2018278 } }, { status: 400 });
    expect((await call('POST', `/conversations/${conv[0].id}/messages`, 'adm@t.io', { text: 'x' })).json()).toEqual({ error: 'outside_reply_window' });
    sendResponse = () => Response.json({ recipient_id: '1', message_id: 'm_OUT2' });

    await db.query(`UPDATE messages SET created_at = now() - interval '30 hours' WHERE conversation_id = $1 AND direction = 'in'`, [conv[0].id]);
    calls.length = 0;
    expect((await call('POST', `/conversations/${conv[0].id}/messages`, 'adm@t.io', { text: 'late' })).json()).toEqual({ error: 'outside_reply_window' });
    expect(calls.filter((c) => c.init?.method === 'POST')).toHaveLength(0);
  });

  it('comments on posts: taken in only when switched on; never answered by the bot; a person picks public or private', async () => {
    const id = ids.messenger;
    const feed = (commentId: string, from: string, message: string, verb = 'add') => ({ object: 'page', entry: [{ id: PAGE, time: Date.now(), changes: [{ field: 'feed', value: { item: 'comment', verb, comment_id: commentId, post_id: `${PAGE}_1`, from: { id: from, name: 'Ron Commenter' }, message, created_time: Math.floor(Date.now() / 1000), post: { permalink_url: 'https://www.facebook.com/shop/posts/1' } } }] }] });
    await hook(id, feed('111_1', '8880001', 'כמה עולה?'));
    expect((await db.query(`SELECT 1 FROM contacts WHERE external_id = '8880001@fbcomment'`)).rowCount).toBe(0);   // off by default
    calls.length = 0;
    expect((await call('PUT', `/channels/${id}/meta`, 'adm@t.io', { pageId: PAGE, pageAccessToken: TOKEN, appSecret: SECRET, comments: true })).json()).toMatchObject({ status: 'connected' });
    expect(calls.find((c) => c.url.includes('/subscribed_apps') && c.init?.method === 'POST')!.url).toContain(',feed');
    expect((await call('GET', `/channels/${id}/meta`, 'adm@t.io')).json().comments).toBe(true);
    await db.query(`INSERT INTO settings (key, value) VALUES ('bot', '{"enabled": true, "mode": "menu", "welcome": "שלום", "items": [{"title": "א", "answer": "ב"}]}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    calls.length = 0;
    await hook(id, feed('111_2', '8880001', 'כמה עולה?'));
    await hook(id, feed('111_3', PAGE, 'our own reply'));
    await hook(id, feed('111_4', '8880001', 'deleted', 'remove'));
    const conv = (await db.query(`SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.external_id = '8880001@fbcomment'`)).rows[0].id as string;
    const inb = (await db.query(`SELECT body, external_id FROM messages WHERE conversation_id = $1 AND direction = 'in'`, [conv])).rows;
    expect(inb).toHaveLength(1);
    expect(inb[0].body).toContain('כמה עולה?');
    expect(inb[0].body).toContain('https://www.facebook.com/shop/posts/1');
    expect(calls.filter((c) => c.init?.method === 'POST' && c.url.endsWith('/messages'))).toHaveLength(0);   // the bot stayed silent
    expect((await db.query(`SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND direction = 'out'`, [conv])).rows[0].n).toBe(0);

    expect((await call('POST', `/conversations/${conv}/messages`, 'adm@t.io', { text: 'מחיר בפרטי' })).json()).toEqual({ error: 'comment_reply_mode_required' });
    calls.length = 0;
    expect((await call('POST', `/conversations/${conv}/messages`, 'adm@t.io', { text: 'שלחנו לך בפרטי', commentReply: 'public' })).statusCode).toBe(201);
    const pub = calls.find((c) => c.url.endsWith('/111_2/comments'))!;
    expect(JSON.parse(pub.init!.body as string)).toEqual({ message: 'שלחנו לך בפרטי' });
    expect((await call('POST', `/conversations/${conv}/messages`, 'adm@t.io', { text: 'המחיר הוא 100', commentReply: 'private' })).statusCode).toBe(201);
    const priv = calls.find((c) => c.url.endsWith(`/${PAGE}/messages`))!;
    expect(JSON.parse(priv.init!.body as string)).toMatchObject({ recipient: { comment_id: '111_2' }, message: { text: 'המחיר הוא 100' } });
    expect((await db.query(`SELECT reply_mode FROM messages WHERE conversation_id = $1 AND direction = 'out' ORDER BY created_at`, [conv])).rows.map((r) => r.reply_mode)).toEqual(['public', 'private']);
    // a day later there is no 24-hour block on a comment thread
    await db.query(`UPDATE messages SET created_at = now() - interval '3 days' WHERE conversation_id = $1 AND direction = 'in'`, [conv]);
    expect((await call('POST', `/conversations/${conv}/messages`, 'adm@t.io', { text: 'עדיין כאן', commentReply: 'public' })).statusCode).toBe(201);

    calls.length = 0;
    expect((await call('POST', `/conversations/${conv}/comment/hide`, 'adm@t.io')).json()).toEqual({ ok: true });
    expect(JSON.parse(calls.find((c) => c.url.endsWith('/111_2'))!.init!.body as string)).toEqual({ is_hidden: true });
    expect((await db.query(`SELECT action FROM audit_log WHERE action LIKE 'comment.%' ORDER BY created_at`)).rows.map((r) => r.action)).toEqual(['comment.reply_public', 'comment.reply_private', 'comment.reply_public', 'comment.hide']);
    await db.query(`DELETE FROM settings WHERE key = 'bot'`);
  });

  it('Instagram comments: a public reply goes to /replies', async () => {
    const id = ids.instagram;
    await call('PUT', `/channels/${id}/meta`, 'adm@t.io', { pageId: PAGE, pageAccessToken: TOKEN, appSecret: SECRET, igAccountId: IG, comments: true });
    await hook(id, { object: 'instagram', entry: [{ id: IG, time: Date.now(), changes: [{ field: 'comments', value: { id: '1790001', text: 'איפה זה?', from: { id: '7770009', username: 'gal' }, media: { id: '1780001' } } }] }] });
    const conv = (await db.query(`SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.external_id = '7770009@igcomment'`)).rows[0].id as string;
    calls.length = 0;
    expect((await call('POST', `/conversations/${conv}/messages`, 'adm@t.io', { text: 'בתל אביב', commentReply: 'public' })).statusCode).toBe(201);
    expect(calls.some((c) => c.url.endsWith('/1790001/replies'))).toBe(true);
  });
});

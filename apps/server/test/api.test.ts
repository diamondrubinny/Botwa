import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ChannelManager } from '../src/channels/manager.js';
import type { AdapterContext, AdapterFactory, ChannelAdapter } from '../src/channels/types.js';
import { loadConfig } from '../src/config.js';
import { decrypt } from '../src/crypto.js';
import { createDb } from '../src/db.js';
import { sign, verifySignature, webhookUrlProblem } from '../src/integrations/webhooks.js';
import { safePost } from '../src/kb/fetch.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';

describe('webhook signatures and URL checks', () => {
  it('signs the exact body with a timestamp; tampering, replays and wrong secrets fail', () => {
    const body = '{"a":1}';
    const h = sign('whsec_x', body, 1_700_000_000);
    expect(verifySignature('whsec_x', h, body, 300, 1_700_000_100)).toBe(true);
    expect(verifySignature('whsec_x', h, '{"a":2}', 300, 1_700_000_100)).toBe(false);
    expect(verifySignature('other', h, body, 300, 1_700_000_100)).toBe(false);
    expect(verifySignature('whsec_x', h, body, 300, 1_700_001_000)).toBe(false); // too old
    expect(verifySignature('whsec_x', 'garbage', body)).toBe(false);
  });
  it('accepts only public https endpoints', async () => {
    expect(webhookUrlProblem('https://hooks.example.com/x')).toBeNull();
    for (const u of ['http://hooks.example.com/x', 'https://127.0.0.1/x', 'https://169.254.169.254/x', 'https://localhost/x', 'https://user:p@example.com/', 'ftp://x.com', 'nonsense']) expect(webhookUrlProblem(u), u).not.toBeNull();
    await expect(safePost('https://127.0.0.1:8443/x', '{}', {})).rejects.toThrow(); // blocked before any connection
  });
});

describe('API keys, REST API and webhooks', () => {
  const ORIGIN = 'https://panel.test';
  const PW = 'correct-horse-battery';
  const cfg = loadConfig({
    NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test',
    ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false',
  });
  const db = createDb(cfg.DATABASE_URL);
  let app: Awaited<ReturnType<typeof buildApp>>;
  let mgr: ChannelManager;
  let ctx: AdapterContext;
  const sent: string[] = [];
  const delivered: { url: string; body: string; headers: Record<string, string> }[] = [];
  let hookStatus = 200;
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let ip = 0;
  class Fake implements ChannelAdapter {
    constructor(c: AdapterContext) { ctx = c; }
    async start() { ctx.events.onStatus('connected'); }
    async stop() {}
    async logout() {}
    async sendText(_t: string, text: string) { sent.push(text); return { externalMessageId: `x${sent.length}` }; }
  }
  const factory: AdapterFactory = (t, c) => (t === 'whatsapp' ? new Fake(c) : null);
  const staff = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, who: string, payload?: object) =>
    app.inject({ method, url, payload, remoteAddress: `10.65.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, cookie: cookies[who]! } });
  const api = (method: 'GET' | 'POST', url: string, key?: string, payload?: object, extra: Record<string, string> = {}) =>
    app.inject({ method, url, payload, remoteAddress: `10.66.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...extra } }); // no Origin header: servers do not send one
  let mid = 0;
  const customer = async (who: string, text: string) => { await ctx.events.onMessage({ externalContactId: who, externalMessageId: `c${++mid}`, text, timestamp: new Date(), contactName: who }); };
  const flush = async () => { await new Promise((r) => setTimeout(r, 120)); await mgr.webhooks!.tick(); };
  let keys: Record<string, string> = {};
  let convId = '';

  beforeAll(async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    mgr = new ChannelManager(db, cfg, factory);
    app = await buildApp(cfg, db, mgr, undefined, async (url, body, headers) => { delivered.push({ url, body, headers }); return { status: hookStatus }; });
    for (const [e, r] of [['admin', 'admin'], ['sup', 'supervisor']] as const) {
      ids[e] = (await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4) RETURNING id', [`${e}@t.io`, e, r, await hashPassword(PW)])).rows[0].id;
      cookies[`${e}@t.io`] = `botwa_sid=${(await app.inject({ method: 'POST', url: '/auth/login', remoteAddress: `10.9.1.${++ip}`, headers: { origin: ORIGIN }, payload: { email: `${e}@t.io`, password: PW } })).cookies[0]!.value}`;
    }
    const ch = (await staff('POST', '/channels', 'admin@t.io', { type: 'whatsapp', label: 'WA' })).json().id;
    await staff('POST', `/channels/${ch}/start`, 'admin@t.io');
    await new Promise((r) => setTimeout(r, 40));
    await db.query(`INSERT INTO tags (name) VALUES ('vip'), ('billing')`);
  });
  afterAll(async () => { await mgr.stopAll(); await app.close(); await db.end(); });

  it('only api.manage may create keys; the full key is shown once; revoking works', async () => {
    expect((await staff('GET', '/integrations/keys', 'sup@t.io')).statusCode).toBe(403);
    expect((await staff('POST', '/integrations/keys', 'admin@t.io', { name: 'x', scopes: ['root'] })).statusCode).toBe(400);
    for (const scopes of [['read'], ['read', 'send'], ['read', 'manage']]) {
      const r = (await staff('POST', '/integrations/keys', 'admin@t.io', { name: scopes.join('+'), scopes })).json();
      expect(r.key).toMatch(/^bk_[\w-]{8}_[\w-]{30,}$/);
      keys[scopes.join('+')] = r.key;
    }
    const list = JSON.stringify((await staff('GET', '/integrations/keys', 'admin@t.io')).json());
    expect(list).not.toContain(keys['read']);
    expect(list).toContain('"prefix"');
    const row = (await db.query('SELECT key_hash FROM api_keys LIMIT 1')).rows[0].key_hash as string;
    expect(Object.values(keys)).not.toContain(row); // only a hash is stored
    const doomed = (await staff('POST', '/integrations/keys', 'admin@t.io', { name: 'temp', scopes: ['read'] })).json();
    expect((await api('GET', '/api/v1/me', doomed.key)).statusCode).toBe(200);
    expect((await staff('DELETE', `/integrations/keys/${doomed.id}`, 'admin@t.io')).statusCode).toBe(200);
    expect((await api('GET', '/api/v1/me', doomed.key)).statusCode).toBe(401);
  });

  it('authentication: bearer keys only, scopes enforced, browser session cookie never works', async () => {
    expect((await api('GET', '/api/v1/conversations')).statusCode).toBe(401);
    expect((await api('GET', '/api/v1/conversations', 'bk_abcdefgh_' + 'x'.repeat(40))).statusCode).toBe(401);
    expect((await api('GET', '/api/v1/conversations', undefined, undefined, { cookie: cookies['admin@t.io']! })).statusCode).toBe(401);
    expect((await api('GET', '/api/v1/me', keys['read'])).json()).toMatchObject({ scopes: ['read'] });
    await customer('alice', 'שלום, אני צריכה עזרה');
    convId = (await db.query(`SELECT id FROM conversations`)).rows[0].id;
    expect((await api('POST', `/api/v1/conversations/${convId}/messages`, keys['read'], { text: 'hi' })).json()).toEqual({ error: 'insufficient_scope', required: 'send' });
    expect((await api('POST', `/api/v1/conversations/${convId}/status`, keys['read+send'], { status: 'closed' })).statusCode).toBe(403);
  });

  it('read: conversations, messages with a stable cursor, tags, users', async () => {
    const list = (await api('GET', '/api/v1/conversations?status=open', keys['read'])).json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ id: convId, status: 'open', contact: { name: 'alice' }, channel: { type: 'whatsapp' } });
    expect(JSON.stringify(list)).not.toContain('alice@'); // no platform identifiers such as phone numbers
    expect((await api('GET', '/api/v1/conversations?limit=500', keys['read'])).statusCode).toBe(400);
    const m1 = (await api('GET', `/api/v1/conversations/${convId}/messages`, keys['read'])).json();
    expect(m1.items.map((m: { text: string }) => m.text)).toEqual(['שלום, אני צריכה עזרה']);
    await customer('alice', 'עוד הודעה');
    const m2 = (await api('GET', `/api/v1/conversations/${convId}/messages?after_seq=${m1.nextAfterSeq}`, keys['read'])).json();
    expect(m2.items.map((m: { text: string }) => m.text)).toEqual(['עוד הודעה']);
    expect((await api('GET', '/api/v1/conversations/00000000-0000-4000-8000-000000000000', keys['read'])).statusCode).toBe(404);
    expect((await api('GET', '/api/v1/tags', keys['read'])).json().items.map((t: { name: string }) => t.name)).toEqual(['billing', 'vip']);
    expect((await api('GET', '/api/v1/users', keys['read'])).json().items.length).toBe(2);
  });

  it('send obeys the same rules as staff: delivered once, blocked/opted-out contacts refused', async () => {
    const r = await api('POST', `/api/v1/conversations/${convId}/messages`, keys['read+send'], { text: 'שלום מהמערכת' });
    expect(r.statusCode).toBe(201);
    expect(sent).toContain('שלום מהמערכת');
    expect((await db.query(`SELECT count(*)::int AS n FROM messages WHERE direction = 'out' AND body = 'שלום מהמערכת'`)).rows[0].n).toBe(1);
    expect((await api('POST', `/api/v1/conversations/${convId}/messages`, keys['read+send'], { text: '' })).statusCode).toBe(400);
    await db.query(`UPDATE contacts SET opted_out = true`);
    expect((await api('POST', `/api/v1/conversations/${convId}/messages`, keys['read+send'], { text: 'שוב' })).json()).toEqual({ error: 'contact_opted_out' });
    await db.query(`UPDATE contacts SET opted_out = false, blocked = true`);
    expect((await api('POST', `/api/v1/conversations/${convId}/messages`, keys['read+send'], { text: 'שוב' })).json()).toEqual({ error: 'contact_blocked' });
    await db.query(`UPDATE contacts SET blocked = false`);
    await db.query(`UPDATE messages SET created_at = now() - interval '30 days' WHERE direction = 'in'`);
    expect((await api('POST', `/api/v1/conversations/${convId}/messages`, keys['read+send'], { text: 'באיחור' })).json()).toEqual({ error: 'outside_reply_window' });
    await db.query(`UPDATE messages SET created_at = now() WHERE direction = 'in'`);
  });

  it('manage: status, assignment (active users only) and existing tags only', async () => {
    expect((await api('POST', `/api/v1/conversations/${convId}/assign`, keys['read+manage'], { userId: '00000000-0000-4000-8000-000000000000' })).json()).toEqual({ error: 'invalid_user' });
    expect((await api('POST', `/api/v1/conversations/${convId}/assign`, keys['read+manage'], { userId: ids.sup })).statusCode).toBe(200);
    expect((await api('POST', `/api/v1/conversations/${convId}/tags`, keys['read+manage'], { names: ['VIP'] })).json()).toEqual({ ok: true, tags: ['vip'] });
    expect((await api('POST', `/api/v1/conversations/${convId}/tags`, keys['read+manage'], { names: ['nope'] })).json()).toEqual({ error: 'unknown_tag' });
    expect((await api('GET', `/api/v1/conversations/${convId}`, keys['read'])).json()).toMatchObject({ assignedTo: ids.sup, tags: ['vip'] });
    expect((await api('POST', `/api/v1/conversations/${convId}/status`, keys['read+manage'], { status: 'closed' })).statusCode).toBe(200);
    expect((await api('POST', `/api/v1/conversations/${convId}/status`, keys['read+manage'], { status: 'open' })).statusCode).toBe(200);
  });

  let hookId = '';
  let secret = '';
  it('webhooks: validated, secret shown once, events signed and delivered; text can be left out', async () => {
    expect((await staff('POST', '/integrations/webhooks', 'sup@t.io', {})).statusCode).toBe(403);
    expect((await staff('POST', '/integrations/webhooks', 'admin@t.io', { name: 'a', url: 'http://hooks.example.com/x', events: ['message.received'] })).json()).toEqual({ error: 'https_required' });
    expect((await staff('POST', '/integrations/webhooks', 'admin@t.io', { name: 'a', url: 'https://127.0.0.1/x', events: ['message.received'] })).json()).toEqual({ error: 'blocked_address' });
    expect((await staff('POST', '/integrations/webhooks', 'admin@t.io', { name: 'a', url: 'https://hooks.example.com/x', events: ['nope'] })).statusCode).toBe(400);
    const r = (await staff('POST', '/integrations/webhooks', 'admin@t.io', { name: 'CRM', url: 'https://hooks.example.com/crm', events: ['message.received', 'message.sent', 'conversation.status_changed', 'conversation.assigned'] })).json();
    hookId = r.id; secret = r.secret;
    expect(secret).toMatch(/^whsec_/);
    expect(JSON.stringify((await staff('GET', '/integrations/webhooks', 'admin@t.io')).json())).not.toContain(secret);
    const stored = (await db.query('SELECT secret_enc FROM webhooks')).rows[0].secret_enc as string;
    expect(stored).not.toContain(secret);
    expect(decrypt(stored, cfg.ENCRYPTION_KEY)).toBe(secret);

    delivered.length = 0;
    await customer('bob', 'שאלה על חשבונית');
    await flush();
    const ev = delivered.find((d) => JSON.parse(d.body).type === 'message.received')!;
    const payload = JSON.parse(ev.body);
    expect(ev.url).toBe('https://hooks.example.com/crm');
    expect(ev.headers['x-botwa-event']).toBe('message.received');
    expect(verifySignature(secret, ev.headers['x-botwa-signature']!, ev.body)).toBe(true);
    expect(payload.data).toMatchObject({ message: { direction: 'in', text: 'שאלה על חשבונית' }, contact: { name: 'bob' }, conversation: { channelType: 'whatsapp' } });
    expect(JSON.stringify(payload)).not.toContain('bob@s.whatsapp.net');
    // staff reply, status and assignment events
    const bobConv = (await db.query(`SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.external_id = 'bob'`)).rows[0].id;
    delivered.length = 0;
    await staff('POST', `/conversations/${bobConv}/messages`, 'admin@t.io', { text: 'בדקנו' });
    await staff('POST', `/conversations/${bobConv}/status`, 'admin@t.io', { status: 'closed' });
    await staff('POST', `/conversations/${bobConv}/assign`, 'admin@t.io', { userId: ids.sup });
    await flush();
    expect(delivered.map((d) => JSON.parse(d.body).type).sort()).toEqual(['conversation.assigned', 'conversation.status_changed', 'message.sent']);
    // no text mode
    await staff('PATCH', `/integrations/webhooks/${hookId}`, 'admin@t.io', { includeText: false });
    delivered.length = 0;
    await customer('bob', 'סודי מאוד');
    await flush();
    const noText = delivered.find((d) => JSON.parse(d.body).type === 'message.received')!;
    expect(noText.body).not.toContain('סודי מאוד');
    expect(JSON.parse(noText.body).data.message).toMatchObject({ direction: 'in' });
    await staff('PATCH', `/integrations/webhooks/${hookId}`, 'admin@t.io', { includeText: true });
  });

  it('failed deliveries are retried with growing delays, then marked failed; the endpoint disables itself after many failures', async () => {
    hookStatus = 500;
    delivered.length = 0;
    await customer('carol', 'בדיקת כשל');
    await flush();
    const d1 = (await db.query(`SELECT id, status, attempts, last_error FROM webhook_deliveries WHERE event = 'message.received' ORDER BY created_at DESC LIMIT 1`)).rows[0];
    expect(d1).toMatchObject({ status: 'pending', attempts: 1, last_error: 'http_500' });
    const wait1 = (await db.query(`SELECT extract(epoch FROM next_attempt_at - now())::int AS s FROM webhook_deliveries WHERE id = $1`, [d1.id])).rows[0].s;
    expect(wait1).toBeGreaterThan(30);
    for (let i = 0; i < 6; i++) { await db.query(`UPDATE webhook_deliveries SET next_attempt_at = now() WHERE id = $1`, [d1.id]); await mgr.webhooks!.tick(); }
    expect((await db.query('SELECT status, attempts FROM webhook_deliveries WHERE id = $1', [d1.id])).rows[0]).toEqual({ status: 'failed', attempts: 7 });
    // 20 consecutive failed deliveries switch the endpoint off
    await db.query(`UPDATE webhooks SET failures = 19 WHERE id = $1`, [hookId]);
    await db.query(`UPDATE webhook_deliveries SET status = 'pending', attempts = 6, next_attempt_at = now() WHERE id = $1`, [d1.id]);
    await mgr.webhooks!.tick();
    expect((await db.query('SELECT enabled, disabled_reason FROM webhooks WHERE id = $1', [hookId])).rows[0]).toEqual({ enabled: false, disabled_reason: 'too_many_failures' });
    // re-enabling resets the counter; recovery clears failures
    hookStatus = 200;
    await staff('PATCH', `/integrations/webhooks/${hookId}`, 'admin@t.io', { enabled: true });
    const t = (await staff('POST', `/integrations/webhooks/${hookId}/test`, 'admin@t.io')).json();
    expect(t).toMatchObject({ status: 'delivered', responseCode: 200 });
    expect((await staff('GET', `/integrations/webhooks/${hookId}/deliveries`, 'admin@t.io')).json().length).toBeGreaterThan(3);
    const rot = (await staff('POST', `/integrations/webhooks/${hookId}/rotate-secret`, 'admin@t.io')).json().secret as string;
    expect(rot).not.toBe(secret);
    expect((await staff('DELETE', `/integrations/webhooks/${hookId}`, 'admin@t.io')).statusCode).toBe(200);
    expect((await db.query('SELECT count(*)::int AS n FROM webhook_deliveries')).rows[0].n).toBe(0); // deliveries go with the endpoint
  });
});

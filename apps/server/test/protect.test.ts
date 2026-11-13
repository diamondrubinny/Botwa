import { DEFAULT_AUTOMATIONS } from '../src/automations.js';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ChannelManager } from '../src/channels/manager.js';
import { ChannelSender, DEFAULT_SENDING, SendError, warmupCap, type SendingSettings } from '../src/channels/sender.js';
import type { AdapterContext, AdapterFactory, ChannelAdapter } from '../src/channels/types.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';
import { isRestriction } from '../src/channels/telegram.js';

const ORIGIN = 'https://panel.test';
const PW = 'correct-horse-battery';
const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test';
const db = createDb(DB_URL);

// webhook receiver for alert tests
let hookBodies: Record<string, unknown>[] = [];
const hook = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => { hookBodies.push(JSON.parse(b)); res.end('ok'); });
});

const cfg = loadConfig({
  NODE_ENV: 'test', DATABASE_URL: DB_URL, ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN,
  COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false', FLOOD_LIMIT: '5',
  ALERT_WEBHOOK_URL: 'http://127.0.0.1:0/placeholder', // replaced below once the server listens
});

let app: Awaited<ReturnType<typeof buildApp>>;
let mgr: ChannelManager;
let cfg2 = cfg;
let ctx: AdapterContext;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
let ip = 0;
let channelId = '';
const sent: string[] = [];

class Fake implements ChannelAdapter {
  constructor(c: AdapterContext) { ctx = c; }
  async start() { ctx.events.onStatus('connected'); }
  async stop() {}
  async logout() {}
  async sendText(_t: string, text: string) { sent.push(text); return { externalMessageId: `p${sent.length}-${Math.random()}` }; }
}
const factory: AdapterFactory = (t, c) => (t === 'whatsapp' ? new Fake(c) : null);
const call = (method: 'GET' | 'POST' | 'PUT', url: string, who?: string, payload?: object) =>
  app.inject({ method, url, payload, remoteAddress: `10.50.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, ...(who ? { cookie: cookies[who]! } : {}) } });
let mid = 0;
const inbound = (who: string, text = 'hello') =>
  ctx.events.onMessage({ externalContactId: who, externalMessageId: `i${++mid}`, text, timestamp: new Date() });
const contactOf = async (who: string) => (await db.query(`SELECT * FROM contacts WHERE external_id = $1`, [who])).rows[0];
const convOf = async (who: string) => (await db.query(`SELECT c.* FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE ct.external_id=$1`, [who])).rows[0];

beforeAll(async () => {
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()));
  const port = (hook.address() as { port: number }).port;
  cfg2 = loadConfig({
    NODE_ENV: 'test', DATABASE_URL: DB_URL, ENCRYPTION_KEY: cfg.ENCRYPTION_KEY, APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false',
    REQUIRE_MFA_FOR_PRIVILEGED: 'false', FLOOD_LIMIT: '5', ALERT_WEBHOOK_URL: `http://127.0.0.1:${port}/hook`,
  });
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  await db.query(`INSERT INTO settings (key, value) VALUES ('automations', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ ...DEFAULT_AUTOMATIONS, introduce: { ...DEFAULT_AUTOMATIONS.introduce, enabled: false } })]);   // these tests check the exact replies; the introduction has its own tests
  mgr = new ChannelManager(db, cfg2, factory);
  app = await buildApp(cfg2, db, mgr);
  for (const [e, r] of [['admin', 'admin'], ['sup', 'supervisor'], ['a1', 'agent']] as const) {
    const u = await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4) RETURNING id', [`${e}@t.io`, e, r, await hashPassword(PW)]);
    ids[e] = u.rows[0].id;
    const res = await call('POST', '/auth/login', undefined, { email: `${e}@t.io`, password: PW });
    cookies[`${e}@t.io`] = `botwa_sid=${res.cookies[0]!.value}`;
  }
  channelId = (await call('POST', '/channels', 'admin@t.io', { type: 'whatsapp', label: 'WA' })).json().id;
  await call('POST', `/channels/${channelId}/start`, 'admin@t.io');
  await new Promise((r) => setTimeout(r, 40));
});
afterAll(async () => { await mgr.stopAll(); await app.close(); await db.end(); hook.close(); });

describe('send pacing (unit, fake clock)', () => {
  const S: SendingSettings = { ...DEFAULT_SENDING, minDelayMs: 1000, maxDelayMs: 3000, perMinute: 3, perDay: 1000, warmup: false, typing: false };
  const clock = () => {
    let t = 1_000_000;
    const sleeps: number[] = [];
    return { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, sleeps, advance: (ms: number) => { t += ms; } };
  };

  it('spaces consecutive sends by a random human-like delay within [min,max]; first send is immediate', async () => {
    const c = clock();
    const sender = new ChannelSender(db, c.now, c.sleep);
    await sender.run(channelId, S, async () => 'a');
    expect(c.sleeps).toEqual([]);
    for (let i = 0; i < 2; i++) await sender.run(channelId, S, async () => 'x');
    expect(c.sleeps).toHaveLength(2);
    for (const s of c.sleeps) { expect(s).toBeGreaterThanOrEqual(1); expect(s).toBeLessThanOrEqual(3000); }
  });

  it('enforces the per-minute cap: waits for the window, or fails fast for interactive callers', async () => {
    const c = clock();
    const sender = new ChannelSender(db, c.now, c.sleep);
    const fast: SendingSettings = { ...S, minDelayMs: 0, maxDelayMs: 0, perMinute: 2 };
    await sender.run(channelId, fast, async () => 1);
    await sender.run(channelId, fast, async () => 2);
    await expect(sender.run(channelId, fast, async () => 3, { maxWaitMs: 5000 })).rejects.toMatchObject({ code: 'send_throttled' });
    const t0 = c.now();
    await sender.run(channelId, fast, async () => 3, { maxWaitMs: 120_000 }); // background caller may wait for the window
    expect(c.now() - t0).toBeGreaterThan(50_000);
  });

  it('serialises concurrent sends in order, and bounds the queue', async () => {
    const c = clock();
    const sender = new ChannelSender(db, c.now, c.sleep);
    const order: number[] = [];
    const fast: SendingSettings = { ...S, minDelayMs: 0, maxDelayMs: 0, perMinute: 120 };
    await Promise.all([1, 2, 3, 4].map((n) => sender.run(channelId, fast, async () => { await new Promise((r) => setTimeout(r, 5 - n)); order.push(n); })));
    expect(order).toEqual([1, 2, 3, 4]);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const jobs = Array.from({ length: 50 }, () => sender.run(channelId, fast, () => gate));
    await expect(sender.run(channelId, fast, async () => 'overflow')).rejects.toMatchObject({ code: 'queue_full' });
    release();
    await Promise.all(jobs);
  });

  it('daily cap comes from the database and warm-up grows with channel age', async () => {
    expect(warmupCap({ ...S, warmup: true, perDay: 500 }, 0)).toBe(20);
    expect(warmupCap({ ...S, warmup: true, perDay: 500 }, 2.5)).toBe(100);
    expect(warmupCap({ ...S, warmup: true, perDay: 90 }, 10)).toBe(90);
    expect(warmupCap({ ...S, warmup: false, perDay: 500 }, 0)).toBe(500);

    const ch = (await db.query(`INSERT INTO channels (type, label) VALUES ('whatsapp','cap') RETURNING id`)).rows[0].id;
    const c = await db.query(`INSERT INTO contacts (channel_id, external_id) VALUES ($1,'cap') RETURNING id`, [ch]);
    const v = await db.query(`INSERT INTO conversations (channel_id, contact_id) VALUES ($1,$2) RETURNING id`, [ch, c.rows[0].id]);
    await db.query(`INSERT INTO messages (conversation_id, direction, body) SELECT $1, 'out', 'x' FROM generate_series(1, 20)`, [v.rows[0].id]);
    const sender = new ChannelSender(db, clock().now, clock().sleep);
    await expect(sender.run(ch, { ...S, warmup: true, perDay: 500 }, async () => 1)).rejects.toBeInstanceOf(SendError); // new number: cap 20 reached
    await expect(sender.run(ch, { ...S, warmup: false, perDay: 500, minDelayMs: 0, maxDelayMs: 0, perMinute: 120 }, async () => 'ok')).resolves.toBe('ok');
  });
});

describe('pacing through the API', () => {
  it('settings: validated, admin writes, supervisor reads', async () => {
    expect((await call('GET', '/settings/sending', 'a1@t.io')).statusCode).toBe(403);
    expect((await call('PUT', '/settings/sending', 'sup@t.io', DEFAULT_SENDING)).statusCode).toBe(403);
    expect((await call('PUT', '/settings/sending', 'admin@t.io', { ...DEFAULT_SENDING, minDelayMs: 5000, maxDelayMs: 1000 })).statusCode).toBe(400);
    expect((await call('PUT', '/settings/sending', 'admin@t.io', { ...DEFAULT_SENDING, perMinute: 0 })).statusCode).toBe(400);
    expect((await call('PUT', '/settings/sending', 'admin@t.io', { ...DEFAULT_SENDING, minDelayMs: 0, maxDelayMs: 0, perDay: 3, warmup: false, typing: false })).statusCode).toBe(200);
  });

  it('staff reply returns 429 daily_limit once the cap is reached (and nothing is sent)', async () => {
    await inbound('cap1');
    const conv = (await convOf('cap1')).id;
    await call('POST', `/conversations/${conv}/assign`, 'admin@t.io', { userId: ids.a1 });
    sent.length = 0;
    for (let i = 0; i < 3; i++) expect((await call('POST', `/conversations/${conv}/messages`, 'a1@t.io', { text: `m${i}` })).statusCode).toBe(201);
    const over = await call('POST', `/conversations/${conv}/messages`, 'a1@t.io', { text: 'too many' });
    expect(over.statusCode).toBe(429);
    expect(over.json()).toEqual({ error: 'daily_limit' });
    expect(sent).not.toContain('too many');
  });

  it('health endpoint: usage, cap, warnings, recent events', async () => {
    const h = (await call('GET', '/channels/health', 'sup@t.io')).json().find((c: { id: string }) => c.id === channelId);
    expect(h).toMatchObject({ label: 'WA', status: 'connected', dailyCap: 3 });
    expect(h.sentLast24h).toBeGreaterThanOrEqual(3);
    expect(h.warnings).toContain('daily_cap_reached');
    expect(h.events[0].kind).toBe('connected');
    expect((await call('GET', '/channels/health', 'a1@t.io')).statusCode).toBe(403);
    await call('PUT', '/settings/sending', 'admin@t.io', { ...DEFAULT_SENDING, minDelayMs: 0, maxDelayMs: 0, perDay: 5000, warmup: false, typing: false });
  });
});

describe('blocking customers', () => {
  it('manager blocks: conversation closed, hidden, sending refused; unblock restores; agents cannot block', async () => {
    await inbound('spam1', 'buy now');
    const contact = await contactOf('spam1');
    expect((await call('POST', `/contacts/${contact.id}/block`, 'a1@t.io', { reason: 'x' })).statusCode).toBe(403);
    expect((await call('POST', `/contacts/${contact.id}/block`, 'sup@t.io', { reason: 'ספאם' })).statusCode).toBe(200);
    expect((await contactOf('spam1'))).toMatchObject({ blocked: true, blocked_reason: 'ספאם' });
    expect((await convOf('spam1')).status).toBe('closed');

    const visible = async (who: string, q = '') => (await call('GET', `/conversations?status=closed${q}`, who)).json().some((c: { contactId: string }) => c.contactId === 'spam1');
    expect(await visible('sup@t.io')).toBe(false);                  // hidden by default
    expect(await visible('sup@t.io', '&blocked=true')).toBe(true);  // managers can review blocked ones
    expect(await visible('a1@t.io', '&blocked=true')).toBe(false);  // agents never see them

    const conv = (await convOf('spam1')).id;
    expect((await call('POST', `/conversations/${conv}/messages`, 'sup@t.io', { text: 'hi' })).json()).toEqual({ error: 'contact_blocked' });

    expect((await call('POST', `/contacts/${contact.id}/unblock`, 'sup@t.io')).statusCode).toBe(200);
    expect((await contactOf('spam1')).blocked).toBe(false);
    expect((await db.query(`SELECT action FROM audit_log WHERE action IN ('contact.block','contact.unblock') ORDER BY id`)).rows.map((r) => r.action)).toEqual(['contact.block', 'contact.unblock']);
  });

  it('a blocked contact\'s messages are stored silently: no unread, no bot, no away reply, no routing, no event', async () => {
    await call('PUT', '/settings/bot', 'admin@t.io', { enabled: true, welcome: 'hi', items: [], humanOption: true, humanLabel: 'agent', humanKeywords: ['agent'], humanMessage: 'ok', invalidMessage: 'no', invalidRetries: 1, footer: '' });
    await call('PUT', '/settings/routing', 'admin@t.io', { mode: 'round_robin' });
    await inbound('spam2', 'first');
    sent.length = 0;
    await call('POST', `/contacts/${(await contactOf('spam2')).id}/block`, 'sup@t.io', {});
    const events: unknown[] = [];
    mgr.bus.on('event', (e) => events.push(e));
    await inbound('spam2', 'buy now!!!');
    await inbound('spam2', 'agent please', );
    const c = await convOf('spam2');
    expect(sent).toEqual([]);
    expect(c).toMatchObject({ status: 'closed', unread_count: 0, bot_state: null });
    expect(events.filter((e) => (e as { type: string }).type === 'message')).toEqual([]);
    expect((await db.query(`SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1 AND direction='in'`, [c.id])).rows[0].n).toBe(3); // kept as evidence
    await call('PUT', '/settings/bot', 'admin@t.io', { enabled: false, welcome: 'hi', items: [], humanOption: true, humanLabel: 'agent', humanKeywords: ['agent'], humanMessage: 'ok', invalidMessage: 'no', invalidRetries: 1, footer: '' });
    await call('PUT', '/settings/routing', 'admin@t.io', { mode: 'off' });
  });

  it('flood guard auto-blocks a contact sending too many messages (FLOOD_LIMIT=5), audits and alerts', async () => {
    hookBodies = [];
    for (let i = 0; i < 6; i++) await inbound('flooder', `spam ${i}`);
    expect((await contactOf('flooder'))).toMatchObject({ blocked: true, blocked_reason: 'flood' });
    expect((await db.query(`SELECT 1 FROM audit_log WHERE action='contact.auto_block'`)).rowCount).toBe(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(String(hookBodies.find((b) => String(b.text).includes('הצפת'))?.text)).toContain('נחסם אוטומטית');
    // a normal customer is unaffected
    for (let i = 0; i < 3; i++) await inbound('normal', `hello ${i}`);
    expect((await contactOf('normal')).blocked).toBe(false);
  });
});

describe('restriction detection and alerts', () => {
  it('recognises Telegram restriction errors', () => {
    expect(isRestriction({ errorMessage: 'PEER_FLOOD' })).toBe(true);
    expect(isRestriction({ errorMessage: 'USER_DEACTIVATED_BAN' })).toBe(true);
    expect(isRestriction({ errorMessage: 'MESSAGE_EMPTY' })).toBe(false);
    expect(isRestriction(new Error('x'))).toBe(false);
  });

  it('a connected channel that becomes restricted: event recorded, audit, webhook alert, auto-start off, no reconnect', async () => {
    hookBodies = [];
    ctx.events.onStatus('restricted');
    await new Promise((r) => setTimeout(r, 150));
    expect(mgr.snapshot(channelId).status).toBe('restricted');
    expect((await db.query(`SELECT kind FROM channel_events WHERE channel_id=$1 ORDER BY id DESC LIMIT 1`, [channelId])).rows[0].kind).toBe('restricted');
    expect((await db.query(`SELECT 1 FROM audit_log WHERE action='channel.alert'`)).rowCount).toBe(1);
    expect((await db.query(`SELECT auto_start FROM channels WHERE id=$1`, [channelId])).rows[0].auto_start).toBe(false);
    expect(String(hookBodies[0]?.text)).toContain('הוגבל או נחסם');
    expect(hookBodies[0]).toMatchObject({ source: 'botwa', status: 'restricted' });
    const h = (await call('GET', '/channels/health', 'sup@t.io')).json().find((c: { id: string }) => c.id === channelId);
    expect(h.warnings).toContain('restricted');
    // sending is refused while restricted
    await expect(mgr.sendText(channelId, 'x', 'y')).rejects.toThrow('channel_not_connected');
  });

  it('a stop by the operator is NOT an alert', async () => {
    hookBodies = [];
    await call('POST', `/channels/${channelId}/start`, 'admin@t.io');
    await new Promise((r) => setTimeout(r, 50));
    const before = (await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action='channel.alert'`)).rows[0].n;
    await call('POST', `/channels/${channelId}/stop`, 'admin@t.io');
    await new Promise((r) => setTimeout(r, 100));
    expect(hookBodies).toEqual([]);
    expect((await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action='channel.alert'`)).rows[0].n).toBe(before);
  });
});

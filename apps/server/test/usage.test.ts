import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ChannelManager } from '../src/channels/manager.js';
import { SendError } from '../src/channels/sender.js';
import type { AdapterContext, AdapterFactory, ChannelAdapter } from '../src/channels/types.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';
import { monthOf } from '../src/usage.js';

describe('usage month', () => {
  it('is the calendar month in UTC, and resets on the first of the next one', () => {
    expect(monthOf(new Date('2026-11-30T23:59:59Z'))).toEqual({ month: '2026-11-01', resetsAt: '2026-12-01T00:00:00.000Z' });
    expect(monthOf(new Date('2026-12-31T22:30:00Z'))).toEqual({ month: '2026-12-01', resetsAt: '2027-01-01T00:00:00.000Z' });
  });
});

const ORIGIN = 'https://panel.test';
const PW = 'correct-horse-battery';
const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test', ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false', MEDIA_ALLOW_UNSCANNED: 'true' });
const db = createDb(cfg.DATABASE_URL);
let app: Awaited<ReturnType<typeof buildApp>>;
let mgr: ChannelManager;
const ctxs = new Map<string, AdapterContext>();
const sent: string[] = [];
class Fake implements ChannelAdapter {
  constructor(private c: AdapterContext) { ctxs.set(c.channelId, c); }
  async start() { this.c.events.onStatus('connected'); }
  async stop() {}
  async logout() {}
  async sendText(_t: string, text: string) { sent.push(text); return { externalMessageId: `s${sent.length}-${Math.random()}` }; }
  async react() {}
}
let ip = 0;
const cookies: Record<string, string> = {};
const call = (who: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => app.inject({ method, url, payload, remoteAddress: `10.75.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, cookie: cookies[who]! } });
let cloud = '';
let qr = '';
let conv = '';

beforeAll(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  const factory: AdapterFactory = (_t, c) => new Fake(c);
  mgr = new ChannelManager(db, cfg, factory);
  app = await buildApp(cfg, db, mgr);
  for (const [e, role] of [['admin@t.io', 'admin'], ['ag@t.io', 'agent']] as const) {
    await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4)', [e, e, role, await hashPassword(PW)]);
    cookies[e] = `botwa_sid=${(await app.inject({ method: 'POST', url: '/auth/login', payload: { email: e, password: PW }, remoteAddress: `10.75.9.${role === 'admin' ? 1 : 2}`, headers: { origin: ORIGIN } })).cookies[0]!.value}`;
  }
  cloud = (await call('admin@t.io', 'POST', '/channels', { type: 'whatsapp_cloud', label: 'רשמי' })).json().id;
  qr = (await call('admin@t.io', 'POST', '/channels', { type: 'whatsapp', label: 'QR' })).json().id;
  await call('admin@t.io', 'POST', `/channels/${cloud}/start`);
  await new Promise((r) => setTimeout(r, 40));
  // two replies already sent this month before counting existed (they show as "before counting started")
  await ctxs.get(cloud)!.events.onMessage({ externalContactId: '972500000001', externalMessageId: 'in1', text: 'שלום', timestamp: new Date() });
  conv = (await db.query('SELECT id FROM conversations LIMIT 1')).rows[0].id;
  await db.query(`INSERT INTO messages (conversation_id, direction, body, external_id) VALUES ($1,'out','a','old1'), ($1,'out','b','old2')`, [conv]);
});
afterAll(async () => { await mgr.stopAll(); await app.close(); await db.end(); });

describe('official WhatsApp monthly outgoing count', () => {
  it('counts every message that goes out, starting from what was already sent this month; 1000 by default', async () => {
    await db.query('DELETE FROM wa_monthly_usage');
    const before = (await call('admin@t.io', 'GET', `/channels/${cloud}/usage`)).json();
    expect(before).toMatchObject({ total: 2, seeded: 2, limit: { limit: 1000, action: 'warn', warnAt: 80 }, percent: 0.2 });
    expect((await call('admin@t.io', 'POST', `/conversations/${conv}/messages`, { text: 'תשובה' })).statusCode).toBe(201);
    const inId = (await db.query(`SELECT id FROM messages WHERE conversation_id = $1 AND direction = 'in' LIMIT 1`, [conv])).rows[0].id;
    expect((await call('admin@t.io', 'POST', `/conversations/${conv}/messages/${inId}/reaction`, { emoji: '👍' })).statusCode).toBe(200);
    const after = (await call('admin@t.io', 'GET', `/channels/${cloud}/usage`)).json();
    expect(after.total).toBe(4);
    expect(after.byKind).toMatchObject({ text: 1, reaction: 1 });
    // only official WhatsApp is counted
    expect((await call('admin@t.io', 'GET', `/channels/${qr}/usage`)).json().error).toBe('not_official_whatsapp');
    expect((await call('ag@t.io', 'GET', `/channels/${cloud}/usage`)).statusCode).toBe(403);
  });

  it('alerts once at the warning level and once at the limit; "warn" keeps sending', async () => {
    expect((await call('admin@t.io', 'PUT', `/channels/${cloud}/usage-limit`, { limit: 8, action: 'warn', warnAt: 60 })).statusCode).toBe(200);
    for (let i = 0; i < 6; i++) expect((await call('admin@t.io', 'POST', `/conversations/${conv}/messages`, { text: `m${i}` })).statusCode).toBe(201);
    const u = (await call('admin@t.io', 'GET', `/channels/${cloud}/usage`)).json();
    expect(u.total).toBe(10);
    expect(u.percent).toBe(125);
    const ev = (await db.query(`SELECT kind FROM channel_events WHERE channel_id = $1 AND kind LIKE 'monthly_limit%' ORDER BY id`, [cloud])).rows.map((r) => r.kind);
    expect(ev).toEqual(['monthly_limit_warning', 'monthly_limit_reached']);
  });

  it('"stop automatic messages" stops the bot and away replies at the limit, people still answer', async () => {
    expect((await call('admin@t.io', 'PUT', `/channels/${cloud}/usage-limit`, { limit: 10, action: 'block_auto', warnAt: 80 })).statusCode).toBe(200);
    await expect(mgr.sendText(cloud, '972500000001', 'אוטומטי', { background: true })).rejects.toThrow(SendError);
    expect((await call('admin@t.io', 'POST', `/conversations/${conv}/messages`, { text: 'נציג' })).statusCode).toBe(201);
    const u = (await call('admin@t.io', 'GET', `/channels/${cloud}/usage`)).json();
    expect(u.blocked).toBe(1);
    expect(u.total).toBe(11);
  });

  it('"stop everything" refuses staff messages too, with a clear code; raising the limit lets them through again', async () => {
    expect((await call('admin@t.io', 'PUT', `/channels/${cloud}/usage-limit`, { limit: 11, action: 'block_all', warnAt: 80 })).statusCode).toBe(200);
    const r = await call('admin@t.io', 'POST', `/conversations/${conv}/messages`, { text: 'לא יישלח' });
    expect(r.statusCode).toBe(429);
    expect(r.json().error).toBe('monthly_limit');
    expect((await call('admin@t.io', 'PUT', `/channels/${cloud}/usage-limit`, { limit: 0, action: 'block_all', warnAt: 80 })).json().percent).toBeNull();   // 0 = count only
    expect((await call('admin@t.io', 'POST', `/conversations/${conv}/messages`, { text: 'עכשיו כן' })).statusCode).toBe(201);
  });

  it('validates the settings and lets only channel managers change them', async () => {
    for (const bad of [{ limit: -1 }, { limit: 1.5 }, { action: 'explode' }, { warnAt: 10 }, { limit: 'x' }]) expect((await call('admin@t.io', 'PUT', `/channels/${cloud}/usage-limit`, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    expect((await call('ag@t.io', 'PUT', `/channels/${cloud}/usage-limit`, { limit: 5 })).statusCode).toBe(403);
    expect((await call('admin@t.io', 'PUT', `/channels/${qr}/usage-limit`, { limit: 5 })).statusCode).toBe(409);
    expect((await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'channel.usage_limit'`)).rows[0].n).toBeGreaterThan(0);
  });
});

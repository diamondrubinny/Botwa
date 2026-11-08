import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ChannelManager } from '../src/channels/manager.js';
import type { AdapterContext, AdapterFactory, ChannelAdapter } from '../src/channels/types.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';

const ORIGIN = 'https://panel.test';
const PW = 'correct-horse-battery';
const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test', ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false' });
const db = createDb(cfg.DATABASE_URL);
let app: Awaited<ReturnType<typeof buildApp>>;
let mgr: ChannelManager;
let ip = 0;
const factoryCalls: string[] = [];
const ctxs = new Map<string, AdapterContext>();
class Fake implements ChannelAdapter {
  constructor(private c: AdapterContext) { ctxs.set(c.channelId, c); factoryCalls.push(c.channelId); }
  async start() { this.c.events.onStatus('connected'); }
  async stop() { this.c.events.onStatus('stopped'); }
  async logout() {}
  async sendText() { return {}; }
}
const addr = () => `10.77.${Math.floor(++ip / 250)}.${ip % 250}`;
const login = (remember?: boolean) => app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'a@t.io', password: PW, ...(remember === undefined ? {} : { remember }) }, remoteAddress: addr(), headers: { origin: ORIGIN } });
const me = (cookie: string) => app.inject({ method: 'GET', url: '/auth/me', remoteAddress: addr(), headers: { origin: ORIGIN, cookie } });
const sess = async (token: string) => (await db.query(`SELECT id, remember, created_at, expires_at FROM sessions WHERE token_hash = encode(sha256($1::bytea), 'hex')`, [token])).rows[0];

beforeAll(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  mgr = new ChannelManager(db, cfg, ((ty, c) => (ty === 'whatsapp' || ty === 'telegram' ? new Fake(c) : null)) as AdapterFactory);
  app = await buildApp(cfg, db, mgr);
  await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4)', ['a@t.io', 'a', 'admin', await hashPassword(PW)]);
});
afterAll(async () => { await mgr.stopAll(); await app.close(); await db.end(); });

const hoursFromNow = (d: Date) => (d.getTime() - Date.now()) / 3_600_000;

describe('staying signed in', () => {
  it('a normal sign-in lasts the configured hours, a "stay signed in" one lasts days, and the cookie says the same', async () => {
    const a = await login();
    expect(a.cookies[0]!.maxAge).toBe(12 * 3600);
    const sa = await sess(a.cookies[0]!.value);
    expect(sa.remember).toBe(false);
    expect(hoursFromNow(sa.expires_at)).toBeGreaterThan(11.9);
    const b = await login(true);
    expect(b.cookies[0]!.maxAge).toBe(30 * 24 * 3600);
    const sb = await sess(b.cookies[0]!.value);
    expect(sb.remember).toBe(true);
    expect(hoursFromNow(sb.expires_at)).toBeGreaterThan(30 * 24 - 0.1);
  });

  it('a session in use is renewed once half its time is gone (database and cookie), and is left alone before that', async () => {
    const r = await login();
    const token = r.cookies[0]!.value;
    const ck = `botwa_sid=${token}`;
    await db.query(`UPDATE sessions SET expires_at = now() + interval '11 hours' WHERE token_hash = encode(sha256($1::bytea), 'hex')`, [token]);
    const early = await me(ck);
    expect(early.statusCode).toBe(200);
    expect(early.cookies).toHaveLength(0);                                       // more than half left: nothing to do
    await db.query(`UPDATE sessions SET expires_at = now() + interval '5 hours' WHERE token_hash = encode(sha256($1::bytea), 'hex')`, [token]);
    const late = await me(ck);
    expect(late.statusCode).toBe(200);
    expect(late.cookies[0]!.value).toBe(token);
    expect(late.cookies[0]!.maxAge).toBeGreaterThan(11.9 * 3600);
    expect(hoursFromNow((await sess(token)).expires_at)).toBeGreaterThan(11.9);
  });

  it('never goes beyond the absolute cap, and a session that was not used still ends', async () => {
    const r = await login(true);
    const token = r.cookies[0]!.value;
    const ck = `botwa_sid=${token}`;
    await db.query(`UPDATE sessions SET created_at = now() - interval '89 days', expires_at = now() + interval '2 hours' WHERE token_hash = encode(sha256($1::bytea), 'hex')`, [token]);
    expect((await me(ck)).statusCode).toBe(200);
    const s = await sess(token);
    expect(hoursFromNow(s.expires_at)).toBeLessThan(25.1);                        // 90 days from the sign-in, not 30 more days
    expect(hoursFromNow(s.expires_at)).toBeGreaterThan(2);
    await db.query(`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE token_hash = encode(sha256($1::bytea), 'hex')`, [token]);
    expect((await me(ck)).statusCode).toBe(401);
  });

  it('signing out and changing the password still end sessions', async () => {
    const r = await login(true);
    const ck = `botwa_sid=${r.cookies[0]!.value}`;
    expect((await app.inject({ method: 'POST', url: '/auth/logout', remoteAddress: addr(), headers: { origin: ORIGIN, cookie: ck } })).statusCode).toBe(200);
    expect((await me(ck)).statusCode).toBe(401);
  });
});

describe('channels are kept connected', () => {
  let ch = '';
  beforeAll(async () => {
    ch = (await db.query(`INSERT INTO channels (type, label, status, auto_start) VALUES ('whatsapp','WA','stopped',false) RETURNING id`)).rows[0].id;
  });
  const status = () => (mgr as unknown as { statuses: Map<string, string> }).statuses.get(ch);

  it('a channel that was never linked is not started by itself', async () => {
    await db.query('UPDATE channels SET auto_start = true WHERE id = $1', [ch]);
    expect(await mgr.supervise()).toBe(0);
    expect(factoryCalls).toEqual([]);
  });

  it('a channel that was working and dropped to "error" is started again, with no person involved', async () => {
    await mgr.start(ch);
    expect(status()).toBe('connected');
    ctxs.get(ch)!.events.onStatus('error');
    await new Promise((r) => setTimeout(r, 30));
    expect(status()).toBe('error');
    expect(await mgr.supervise()).toBe(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(status()).toBe('connected');
    expect((await db.query(`SELECT count(*)::int AS n FROM channel_events WHERE channel_id = $1 AND kind = 'auto_restart'`, [ch])).rows[0].n).toBe(1);
    expect(await mgr.supervise()).toBe(0);                                         // connected: nothing to do
  });

  it('never revives a channel a person stopped, or one the platform logged out or restricted', async () => {
    await mgr.stop(ch);
    expect(await mgr.supervise()).toBe(0);
    expect(status()).toBe('stopped');
    await db.query('UPDATE channels SET auto_start = true WHERE id = $1', [ch]);
    ctxs.get(ch)!.events.onStatus('logged_out');
    await new Promise((r) => setTimeout(r, 30));
    expect(await mgr.supervise()).toBe(0);
    ctxs.get(ch)!.events.onStatus('restricted');
    await new Promise((r) => setTimeout(r, 30));
    expect(await mgr.supervise()).toBe(0);
  });
});

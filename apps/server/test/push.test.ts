import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ChannelManager } from '../src/channels/manager.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';
import { isAllowedPushEndpoint } from '../src/push.js';

const ORIGIN = 'https://panel.test';
const PW = 'correct-horse-battery';
const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test';
const db = createDb(DB_URL);
const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: DB_URL, ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false' });

describe('push endpoint allow-list (SSRF guard)', () => {
  it('accepts only https URLs of the known push services', () => {
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBe(true);
    expect(isAllowedPushEndpoint('https://web.push.apple.com/abc')).toBe(true);
    expect(isAllowedPushEndpoint('https://wns2-par02p.notify.windows.com/w/?token=x')).toBe(true);
    for (const bad of ['http://fcm.googleapis.com/x', 'https://169.254.169.254/latest', 'https://localhost/x', 'https://fcm.googleapis.com.evil.com/x', 'https://evil.com/fcm.googleapis.com', 'https://user:p@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'nonsense'])
      expect(isAllowedPushEndpoint(bad), bad).toBe(false);
  });
});

describe('push routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const cookies: Record<string, string> = {};
  let ip = 0;
  const call = (method: 'GET' | 'POST', url: string, who?: string, payload?: object) =>
    app.inject({ method, url, payload, remoteAddress: `10.80.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, ...(who ? { cookie: cookies[who]! } : {}) } });
  const good = { endpoint: 'https://fcm.googleapis.com/fcm/send/abcdef123', keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } };

  beforeAll(async () => {
    await migrate(db);
    await db.query(`TRUNCATE push_subscriptions, sessions, users CASCADE`);
    app = await buildApp(cfg, db, new ChannelManager(db, cfg));
    for (const e of ['p1@t.io', 'p2@t.io']) {
      await db.query(`INSERT INTO users (email,name,role,password_hash) VALUES ($1,$1,'agent',$2)`, [e, await hashPassword(PW)]);
      cookies[e] = `botwa_sid=${(await call('POST', '/auth/login', undefined, { email: e, password: PW })).cookies[0]!.value}`;
    }
  });
  afterAll(async () => { await app.close(); await db.end(); });

  it('requires login, serves a stable public key, validates and scopes subscriptions', async () => {
    expect((await call('GET', '/push/key')).statusCode).toBe(401);
    const k1 = (await call('GET', '/push/key', 'p1@t.io')).json().publicKey as string;
    expect(k1.length).toBeGreaterThan(60);
    expect((await call('GET', '/push/key', 'p2@t.io')).json().publicKey).toBe(k1);
    const stored = (await db.query(`SELECT value FROM settings WHERE key='vapid'`)).rows[0].value;
    expect(JSON.stringify(stored)).not.toContain('"privateKey":"MI'); // private key is stored encrypted, not raw

    expect((await call('POST', '/push/subscribe', 'p1@t.io', { ...good, endpoint: 'https://169.254.169.254/x' })).statusCode).toBe(400);
    expect((await call('POST', '/push/subscribe', 'p1@t.io', { endpoint: good.endpoint, keys: { p256dh: 'x', auth: 'y' } })).statusCode).toBe(400);
    expect((await call('POST', '/push/subscribe', undefined, good)).statusCode).toBe(401);
    expect((await call('POST', '/push/subscribe', 'p1@t.io', good)).statusCode).toBe(200);
    expect((await call('POST', '/push/subscribe', 'p1@t.io', good)).statusCode).toBe(200); // idempotent
    expect((await db.query(`SELECT count(*)::int AS n FROM push_subscriptions`)).rows[0].n).toBe(1);

    // another user cannot remove it; the owner can
    await call('POST', '/push/unsubscribe', 'p2@t.io', { endpoint: good.endpoint });
    expect((await db.query(`SELECT count(*)::int AS n FROM push_subscriptions`)).rows[0].n).toBe(1);
    await call('POST', '/push/unsubscribe', 'p1@t.io', { endpoint: good.endpoint });
    expect((await db.query(`SELECT count(*)::int AS n FROM push_subscriptions`)).rows[0].n).toBe(0);
  });
});

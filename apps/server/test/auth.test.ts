import { authenticator } from 'otplib';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ChannelManager } from '../src/channels/manager.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';
import { decrypt, encrypt } from '../src/crypto.js';

const ORIGIN = 'https://panel.test';
const cfg = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test',
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  APP_ORIGIN: ORIGIN,
  COOKIE_SECURE: 'false',
});
const db = createDb(cfg.DATABASE_URL);
let app: Awaited<ReturnType<typeof buildApp>>;
const PW = 'correct-horse-battery';

// unique source IP per request so the per-IP rate limiter doesn't interfere (it has its own test)
let ipCounter = 0;
const nextIp = () => `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

const post = (url: string, payload: unknown, cookie?: string, origin: string | null = ORIGIN) =>
  app.inject({ method: 'POST', url, payload: payload as object, remoteAddress: nextIp(), headers: { ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) } });

async function login(email: string, extra: object = {}) {
  const res = await post('/auth/login', { email, password: PW, ...extra });
  const sid = res.cookies.find((c) => c.name === 'botwa_sid');
  return { res, cookie: sid ? `botwa_sid=${sid.value}` : undefined };
}

async function mkUser(email: string, role: string) {
  await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4)', [email, email, role, await hashPassword(PW)]);
}

beforeAll(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  await mkUser('admin@t.io', 'admin');
  await mkUser('agent@t.io', 'agent');
  app = await buildApp(cfg, db, new ChannelManager(db, cfg));
});
afterAll(async () => {
  await app.close();
  await db.end();
});

describe('crypto', () => {
  it('round-trips and detects tampering', () => {
    const c = encrypt('secret', cfg.ENCRYPTION_KEY);
    expect(decrypt(c, cfg.ENCRYPTION_KEY)).toBe('secret');
    expect(() => decrypt(c.slice(0, -2) + 'AA', cfg.ENCRYPTION_KEY)).toThrow();
  });
});

describe('auth', () => {
  it('rejects wrong password and unknown user identically', async () => {
    const a = await post('/auth/login', { email: 'admin@t.io', password: 'wrong-wrong-wrong' });
    const b = await post('/auth/login', { email: 'nobody@t.io', password: 'wrong-wrong-wrong' });
    expect(a.statusCode).toBe(401);
    expect(a.body).toBe(b.body);
  });

  it('blocks cross-origin mutating requests', async () => {
    const res = await post('/auth/login', { email: 'admin@t.io', password: PW }, undefined, 'https://evil.test');
    expect(res.statusCode).toBe(403);
    expect((await post('/auth/login', { email: 'admin@t.io', password: PW }, undefined, null)).statusCode).toBe(403);
  });

  it('logs in with HttpOnly cookie, /me works, logout revokes', async () => {
    const { res, cookie } = await login('admin@t.io');
    expect(res.statusCode).toBe(200);
    const set = res.cookies.find((c) => c.name === 'botwa_sid')!;
    expect(set.httpOnly).toBe(true);
    expect(set.sameSite).toBe('Strict');
    const me = await app.inject({ url: '/auth/me', headers: { cookie } });
    expect(me.json()).toMatchObject({ role: 'admin', mfaEnrollmentRequired: true });
    await post('/auth/logout', {}, cookie);
    expect((await app.inject({ url: '/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('enforces authz: agent cannot manage users, anonymous gets 401', async () => {
    expect((await app.inject({ url: '/users' })).statusCode).toBe(401);
    const { cookie } = await login('agent@t.io');
    expect((await app.inject({ url: '/users', headers: { cookie } })).statusCode).toBe(403);
    expect((await post('/users', { email: 'x@t.io', name: 'x', role: 'admin', password: PW }, cookie)).statusCode).toBe(403);
  });

  it('MFA enrolment then TOTP required at login', async () => {
    await mkUser('mfa@t.io', 'agent');
    const { cookie } = await login('mfa@t.io');
    const setup = (await post('/auth/mfa/setup', {}, cookie)).json();
    expect((await post('/auth/mfa/enable', { code: '000000' }, cookie)).statusCode).toBe(400);
    expect((await post('/auth/mfa/enable', { code: authenticator.generate(setup.secret) }, cookie)).statusCode).toBe(200);
    expect((await login('mfa@t.io')).res.json()).toEqual({ error: 'mfa_required' });
    expect((await login('mfa@t.io', { totp: '000000' })).res.statusCode).toBe(401);
    expect((await login('mfa@t.io', { totp: authenticator.generate(setup.secret) })).res.statusCode).toBe(200);
  });

  it('locks account after repeated failures', async () => {
    await mkUser('lock@t.io', 'agent');
    // rate limiter allows 10/min per IP; stay under it
    for (let i = 0; i < 5; i++) await post('/auth/login', { email: 'lock@t.io', password: 'bad-bad-bad-bad' });
    const { res } = await login('lock@t.io');
    expect(res.statusCode).toBe(429);
  });
});

describe('rate limit', () => {
  it('throttles login attempts from one IP', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await app.inject({
        method: 'POST', url: '/auth/login', remoteAddress: '192.168.9.9',
        payload: { email: 'ghost@t.io', password: 'bad-bad-bad-bad' }, headers: { origin: ORIGIN },
      });
      codes.push(r.statusCode);
    }
    expect(codes).toContain(429);
  });
});

describe('users admin', () => {
  it('admin creates, updates, deactivates users; cannot demote self; sessions revoked', async () => {
    const { cookie } = await login('admin@t.io');
    const created = await post('/users', { email: 'New@T.io', name: 'New', role: 'agent', password: PW }, cookie);
    expect(created.statusCode).toBe(201);
    expect(created.json().email).toBe('new@t.io');
    expect(created.body).not.toContain('password');
    expect((await post('/users', { email: 'new@t.io', name: 'n', role: 'agent', password: PW }, cookie)).statusCode).toBe(409);
    expect((await post('/users', { email: 'w@t.io', name: 'n', role: 'agent', password: 'short' }, cookie)).statusCode).toBe(400);

    const agent = await login('new@t.io');
    const id = created.json().id;
    const patch = await app.inject({ method: 'PATCH', url: `/users/${id}`, payload: { active: false }, headers: { cookie, origin: ORIGIN } });
    expect(patch.statusCode).toBe(200);
    expect((await app.inject({ url: '/auth/me', headers: { cookie: agent.cookie } })).statusCode).toBe(401);

    const me = (await app.inject({ url: '/auth/me', headers: { cookie } })).json();
    const self = await app.inject({ method: 'PATCH', url: `/users/${me.id}`, payload: { role: 'agent' }, headers: { cookie, origin: ORIGIN } });
    expect(self.statusCode).toBe(409);
    expect((await app.inject({ url: '/audit', headers: { cookie } })).json().length).toBeGreaterThan(0);
  });
});

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

  it('locks account after repeated failures, with a response indistinguishable from a wrong password', async () => {
    await mkUser('lock@t.io', 'agent');
    // rate limiter allows 10/min per IP; stay under it
    for (let i = 0; i < 5; i++) await post('/auth/login', { email: 'lock@t.io', password: 'bad-bad-bad-bad' });
    const { res } = await login('lock@t.io'); // correct password, but locked
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_credentials' });
    expect((await db.query(`SELECT locked_until FROM users WHERE email='lock@t.io'`)).rows[0].locked_until).not.toBeNull();
  });

  it('lockout counter cannot be raced: 25 concurrent wrong guesses still lock the account', async () => {
    await mkUser('race@t.io', 'agent');
    await Promise.all(Array.from({ length: 25 }, () => post('/auth/login', { email: 'race@t.io', password: 'bad-bad-bad-bad' })));
    expect((await db.query(`SELECT locked_until FROM users WHERE email='race@t.io'`)).rows[0].locked_until).not.toBeNull();
    expect((await login('race@t.io')).res.statusCode).toBe(401);
  });

  it('server enforces MFA enrolment for privileged roles (not just the UI)', async () => {
    await mkUser('sup@t.io', 'supervisor');
    const { cookie } = await login('sup@t.io');
    const get = (url: string) => app.inject({ url, headers: { cookie } });
    expect((await get('/users')).json()).toEqual({ error: 'mfa_enrollment_required' });
    expect((await get('/conversations')).statusCode).toBe(403);
    expect((await get('/auth/me')).statusCode).toBe(200); // enrolment endpoints stay reachable
    const setup = (await post('/auth/mfa/setup', {}, cookie)).json();
    await post('/auth/mfa/enable', { code: authenticator.generate(setup.secret) }, cookie);
    const again = await login('sup@t.io', { totp: authenticator.generate(setup.secret) });
    expect((await app.inject({ url: '/users', headers: { cookie: again.cookie } })).statusCode).toBe(200);
    // non-privileged roles are not affected
    const agent = await login('agent@t.io');
    expect((await app.inject({ url: '/conversations', headers: { cookie: agent.cookie } })).statusCode).toBe(200);
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
    // privileged accounts must have MFA: enrol the admin first
    const adminSecret = authenticator.generateSecret();
    await db.query('UPDATE users SET totp_enabled = true, totp_secret_enc = $1 WHERE email = $2', [encrypt(adminSecret, cfg.ENCRYPTION_KEY), 'admin@t.io']);
    const { cookie } = await login('admin@t.io', { totp: authenticator.generate(adminSecret) });
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

describe('multiple allowed origins', () => {
  it('accepts every listed origin and still rejects others (comma-separated APP_ORIGIN)', async () => {
    const multi = loadConfig({
      NODE_ENV: 'test', DATABASE_URL: cfg.DATABASE_URL, ENCRYPTION_KEY: cfg.ENCRYPTION_KEY, COOKIE_SECURE: 'false',
      APP_ORIGIN: 'https://panel.test, https://www.panel.test/',
    });
    const a2 = await buildApp(multi, db, new ChannelManager(db, multi));
    const login = (origin?: string) => a2.inject({
      method: 'POST', url: '/auth/login', remoteAddress: `10.77.0.${Math.floor(Math.random() * 250)}`,
      headers: origin ? { origin } : {}, payload: { email: 'nobody@t.io', password: 'whatever-whatever' },
    });
    expect((await login('https://panel.test')).statusCode).toBe(401);      // allowed (reaches the credential check)
    expect((await login('https://www.panel.test')).statusCode).toBe(401);  // allowed, trailing slash in config tolerated
    expect((await login('https://evil.test')).statusCode).toBe(403);
    expect((await login()).statusCode).toBe(403);
    await a2.close();
    expect(() => loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'x', ENCRYPTION_KEY: cfg.ENCRYPTION_KEY, APP_ORIGIN: 'https://ok.test,notaurl' })).toThrow();
  });
});

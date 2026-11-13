import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ChannelManager } from '../src/channels/manager.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';
import { relyingParty } from '../src/routes/passkeys.js';
import { newAuthenticator } from './helpers/authenticator.js';

const ORIGIN = 'https://panel.test';
const PW = 'correct-horse-battery';
const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test';
const db = createDb(DB_URL);
const env = { NODE_ENV: 'test', DATABASE_URL: DB_URL, ENCRYPTION_KEY: randomBytes(32).toString('base64'), COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'true' };
const RP = 'panel.test';

describe('relying party', () => {
  it('derives the RP ID from the origin(s); apex+www share the apex; override possible', () => {
    expect(relyingParty(loadConfig({ ...env, APP_ORIGIN: 'https://dreadlist.com' })).rpID).toBe('dreadlist.com');
    const both = relyingParty(loadConfig({ ...env, APP_ORIGIN: 'https://www.dreadlist.com, https://dreadlist.com' }));
    expect(both.rpID).toBe('dreadlist.com');
    expect(both.origins).toEqual(['https://www.dreadlist.com', 'https://dreadlist.com']);
    expect(relyingParty(loadConfig({ ...env, APP_ORIGIN: 'https://a.example,https://b.example' })).rpID).toBe('a.example');
    expect(relyingParty(loadConfig({ ...env, APP_ORIGIN: 'https://x.test', WEBAUTHN_RP_ID: 'test' })).rpID).toBe('test');
  });
});

describe('passkeys (software authenticator, real WebAuthn verification)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let ip = 0;
  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, who?: string, payload?: object, origin: string | null = ORIGIN) =>
    app.inject({ method, url, payload, remoteAddress: `10.80.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { ...(origin ? { origin } : {}), ...(who ? { cookie: cookies[who]! } : {}) } });

  async function mk(email: string, role: string) {
    const u = await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$1,$2,$3) RETURNING id', [email, role, await hashPassword(PW)]);
    ids[email] = u.rows[0].id;
    const res = await call('POST', '/auth/login', undefined, { email, password: PW });
    cookies[email] = `botwa_sid=${res.cookies[0]!.value}`;
  }
  async function enrol(who: string, auth = newAuthenticator(), opts: { uv?: boolean; origin?: string } = {}) {
    const o = (await call('POST', '/auth/passkeys/register/options', who)).json();
    const response = auth.register({ challenge: o.options.challenge, origin: opts.origin ?? ORIGIN, rpID: RP, uv: opts.uv });
    return { auth, o, res: await call('POST', '/auth/passkeys/register/verify', who, { challengeId: o.challengeId, response, name: 'My phone' }) };
  }
  async function login(auth: ReturnType<typeof newAuthenticator>, opts: Parameters<ReturnType<typeof newAuthenticator>['assert']>[0] extends infer T ? Partial<T> : never = {}) {
    const o = (await call('POST', '/auth/passkeys/login/options')).json();
    const response = auth.assert({ challenge: o.options.challenge, origin: ORIGIN, rpID: RP, ...opts });
    return { o, res: await call('POST', '/auth/passkeys/login/verify', undefined, { challengeId: o.challengeId, response }) };
  }

  beforeAll(async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    const cfg = loadConfig({ ...env, APP_ORIGIN: ORIGIN });
    app = await buildApp(cfg, db, new ChannelManager(db, cfg));
    await mk('admin@t.io', 'admin');
    await mk('agent@t.io', 'agent');
  });
  afterAll(async () => { await app.close(); await db.end(); });

  it('registration needs a session; stores the passkey; lists it; rejects duplicates', async () => {
    expect((await call('POST', '/auth/passkeys/register/options')).statusCode).toBe(401);
    const { auth, res } = await enrol('agent@t.io');
    expect(res.statusCode).toBe(201);
    const list = (await call('GET', '/auth/passkeys', 'agent@t.io')).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'My phone' });
    expect(Object.keys(list[0])).not.toContain('public_key');
    // the same authenticator again: the options exclude it, and a forced duplicate insert is refused
    const o = (await call('POST', '/auth/passkeys/register/options', 'agent@t.io')).json();
    expect(o.options.excludeCredentials).toHaveLength(1);
    const dup = await call('POST', '/auth/passkeys/register/verify', 'agent@t.io', { challengeId: o.challengeId, response: auth.register({ challenge: o.options.challenge, origin: ORIGIN, rpID: RP }) });
    expect(dup.statusCode).toBe(409);
    expect((await call('GET', '/auth/passkeys', 'admin@t.io')).json()).toEqual([]); // not visible to others
  });

  it('registration rejects a wrong origin, a missing user-verification flag, a wrong/expired/reused challenge', async () => {
    expect((await enrol('admin@t.io', newAuthenticator(), { origin: 'https://evil.test' })).res.statusCode).toBe(400);
    expect((await enrol('admin@t.io', newAuthenticator(), { uv: false })).res.statusCode).toBe(400);
    const o = (await call('POST', '/auth/passkeys/register/options', 'admin@t.io')).json();
    const a = newAuthenticator();
    const bad = await call('POST', '/auth/passkeys/register/verify', 'admin@t.io', { challengeId: o.challengeId, response: a.register({ challenge: 'AAAA', origin: ORIGIN, rpID: RP }) });
    expect(bad.statusCode).toBe(400);
    // challenge is one-time: the failed attempt consumed it
    const again = await call('POST', '/auth/passkeys/register/verify', 'admin@t.io', { challengeId: o.challengeId, response: a.register({ challenge: o.options.challenge, origin: ORIGIN, rpID: RP }) });
    expect(again.json()).toEqual({ error: 'challenge_expired' });
    // someone else's challenge cannot be used
    const mine = (await call('POST', '/auth/passkeys/register/options', 'admin@t.io')).json();
    const theirs = await call('POST', '/auth/passkeys/register/verify', 'agent@t.io', { challengeId: mine.challengeId, response: a.register({ challenge: mine.options.challenge, origin: ORIGIN, rpID: RP }) });
    expect(theirs.json()).toEqual({ error: 'challenge_expired' });
    // expired
    const exp = (await call('POST', '/auth/passkeys/register/options', 'admin@t.io')).json();
    await db.query(`UPDATE webauthn_challenges SET expires_at = now() - interval '1 second' WHERE id = $1`, [exp.challengeId]);
    expect((await call('POST', '/auth/passkeys/register/verify', 'admin@t.io', { challengeId: exp.challengeId, response: a.register({ challenge: exp.options.challenge, origin: ORIGIN, rpID: RP }) })).json()).toEqual({ error: 'challenge_expired' });
    expect((await call('GET', '/auth/passkeys', 'admin@t.io')).json()).toEqual([]);
  });

  it('passkey login: creates a session without a password, counter advances, audit says "passkey"', async () => {
    const { auth } = await enrol('admin@t.io');
    const { res } = await login(auth);
    expect(res.statusCode).toBe(200);
    const sid = res.cookies.find((c) => c.name === 'botwa_sid')!;
    expect(sid.httpOnly).toBe(true);
    expect(sid.sameSite).toBe('Strict');
    const me = (await call('GET', '/auth/me', undefined, undefined, null)).statusCode; // anonymous
    expect(me).toBe(401);
    const meAuthed = await app.inject({ url: '/auth/me', headers: { cookie: `botwa_sid=${sid.value}` } });
    expect(meAuthed.json()).toMatchObject({ email: 'admin@t.io', passkeys: 1, mfaEnrollmentRequired: false });
    const stored = (await db.query('SELECT counter FROM passkeys WHERE user_id = $1', [ids['admin@t.io']])).rows[0].counter;
    expect(Number(stored)).toBe(auth.counter);
    expect((await db.query(`SELECT meta FROM audit_log WHERE action='login.success' ORDER BY id DESC LIMIT 1`)).rows[0].meta).toMatchObject({ via: 'passkey' });
    await login(auth); // a second sign-in with a higher counter works
  });

  it('login failures are all the same 401: bad signature, wrong origin, no user verification, replay, stale counter, unknown key, expired challenge', async () => {
    const { auth } = await enrol('agent@t.io', newAuthenticator());
    const ok = await login(auth);
    expect(ok.res.statusCode).toBe(200);
    const same = { error: 'invalid_credentials' };
    expect((await login(auth, { tamper: true })).res.json()).toEqual(same);
    const wrongOrigin = await call('POST', '/auth/passkeys/login/options').then(async (r) => { const o = r.json(); return call('POST', '/auth/passkeys/login/verify', undefined, { challengeId: o.challengeId, response: auth.assert({ challenge: o.options.challenge, origin: 'https://evil.test', rpID: RP }) }); });
    expect(wrongOrigin.json()).toEqual(same);
    expect((await login(auth, { uv: false })).res.json()).toEqual(same);
    expect((await login(auth, { counter: 1 })).res.json()).toEqual(same); // counter went backwards => cloned authenticator
    expect((await login(newAuthenticator())).res.json()).toEqual(same);   // credential not registered
    // replay of a captured assertion with its already-consumed challenge
    const o = (await call('POST', '/auth/passkeys/login/options')).json();
    const resp = auth.assert({ challenge: o.options.challenge, origin: ORIGIN, rpID: RP });
    expect((await call('POST', '/auth/passkeys/login/verify', undefined, { challengeId: o.challengeId, response: resp })).statusCode).toBe(200);
    expect((await call('POST', '/auth/passkeys/login/verify', undefined, { challengeId: o.challengeId, response: resp })).json()).toEqual(same);
    // expired challenge
    const o2 = (await call('POST', '/auth/passkeys/login/options')).json();
    await db.query(`UPDATE webauthn_challenges SET expires_at = now() - interval '1 second' WHERE id = $1`, [o2.challengeId]);
    expect((await call('POST', '/auth/passkeys/login/verify', undefined, { challengeId: o2.challengeId, response: auth.assert({ challenge: o2.options.challenge, origin: ORIGIN, rpID: RP }) })).json()).toEqual(same);
    expect((await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action='login.fail' AND meta->>'via'='passkey'`)).rows[0].n).toBeGreaterThanOrEqual(6);
  });

  it('a deactivated user cannot sign in with a passkey; options are public but challenges are one-time', async () => {
    await mk('gone@t.io', 'agent');
    const { auth } = await enrol('gone@t.io');
    await db.query('UPDATE users SET active = false WHERE email = $1', ['gone@t.io']);
    expect((await login(auth)).res.statusCode).toBe(401);
  });

  it('a passkey satisfies the MFA requirement of privileged roles (server-side enforcement)', async () => {
    await mk('boss@t.io', 'supervisor');
    expect((await call('GET', '/reports/summary', 'boss@t.io')).json()).toEqual({ error: 'mfa_enrollment_required' });
    expect((await call('GET', '/auth/me', 'boss@t.io')).json().mfaEnrollmentRequired).toBe(true);
    expect((await call('GET', '/auth/passkeys', 'boss@t.io')).statusCode).toBe(200);          // enrolment endpoints stay reachable
    expect((await enrol('boss@t.io')).res.statusCode).toBe(201);
    expect((await call('GET', '/reports/summary', 'boss@t.io')).statusCode).toBe(200);
    expect((await call('GET', '/auth/me', 'boss@t.io')).json().mfaEnrollmentRequired).toBe(false);
  });

  it('users can delete only their own passkeys; admin MFA reset removes passkeys too', async () => {
    const mine = (await call('GET', '/auth/passkeys', 'boss@t.io')).json()[0].id;
    expect((await call('DELETE', `/auth/passkeys/${mine}`, 'agent@t.io')).statusCode).toBe(404);
    expect((await call('DELETE', `/auth/passkeys/${mine}`, 'boss@t.io')).statusCode).toBe(200);
    expect((await call('GET', '/auth/me', 'boss@t.io')).json().mfaEnrollmentRequired).toBe(true);

    await enrol('boss@t.io');
    expect((await call('POST', `/users/${ids['boss@t.io']}/reset-mfa`, 'admin@t.io')).statusCode).toBe(200);
    expect((await db.query('SELECT count(*)::int AS n FROM passkeys WHERE user_id = $1', [ids['boss@t.io']])).rows[0].n).toBe(0);
    expect((await call('GET', '/auth/me', 'boss@t.io')).statusCode).toBe(401); // signed out everywhere
  });

  it('CSRF: passkey endpoints also require the panel Origin', async () => {
    expect((await call('POST', '/auth/passkeys/login/options', undefined, undefined, 'https://evil.test')).statusCode).toBe(403);
    expect((await call('POST', '/auth/passkeys/login/options', undefined, undefined, null)).statusCode).toBe(403);
  });
});

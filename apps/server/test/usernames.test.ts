import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ChannelManager } from '../src/channels/manager.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';
import { resolveUserRef, usernameSchema } from '../src/usernames.js';

const ORIGIN = 'https://panel.test';
const PW = 'correct-horse-battery';
const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test', ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false' });
const db = createDb(cfg.DATABASE_URL);
let app: Awaited<ReturnType<typeof buildApp>>;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
let ip = 0;
const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, who: string, payload?: object) =>
  app.inject({ method, url, payload, remoteAddress: `10.98.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, cookie: cookies[who]! } });

beforeAll(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  app = await buildApp(cfg, db, new ChannelManager(db, cfg));
  for (const [e, r] of [['admin', 'admin'], ['dana.levi', 'agent'], ['x', 'agent']] as const) {
    ids[e] = (await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4) RETURNING id', [`${e}@t.io`, e, r, await hashPassword(PW)])).rows[0].id;
    cookies[e] = `botwa_sid=${(await app.inject({ method: 'POST', url: '/auth/login', payload: { email: `${e}@t.io`, password: PW }, remoteAddress: `10.98.9.${++ip}`, headers: { origin: ORIGIN } })).cookies[0]!.value}`;
  }
});
afterAll(async () => { await app.close(); await db.end(); });

describe('usernames', () => {
  it('every account gets a unique one from its e-mail, shown in "me" and the user list', async () => {
    const rows = (await db.query('SELECT email, username FROM users ORDER BY email')).rows;
    expect(rows).toEqual([{ email: 'admin@t.io', username: 'admin' }, { email: 'dana.levi@t.io', username: 'dana.levi' }, { email: 'x@t.io', username: 'userx' }]);
    await db.query(`INSERT INTO users (email,name,role,password_hash) VALUES ('dana.levi@other.io','Dana 2','agent','x')`);
    expect((await db.query(`SELECT username FROM users WHERE email = 'dana.levi@other.io'`)).rows[0].username).toBe('dana.levi2');
    expect((await call('GET', '/auth/me', 'dana.levi')).json().username).toBe('dana.levi');
    expect(((await call('GET', '/users', 'admin')).json() as { username: string }[]).map((u) => u.username)).toContain('dana.levi');
  });
  it('admins can set one (validated, unique); "@" and capitals are tidied', async () => {
    expect((await call('PATCH', `/users/${ids['x']}`, 'admin', { username: '@Yossi_K' })).json().username).toBe('yossi_k');
    expect((await call('PATCH', `/users/${ids['x']}`, 'admin', { username: 'dana.levi' })).json()).toEqual({ error: 'username_taken' });
    for (const bad of ['a', 'has space', 'עברית', '-dash', 'x'.repeat(31)]) expect((await call('PATCH', `/users/${ids['x']}`, 'admin', { username: bad })).statusCode, bad).toBe(400);
    expect((await call('PATCH', `/users/${ids['x']}`, 'dana.levi', { username: 'mine' })).statusCode).toBe(403);
    const created = await call('POST', '/users', 'admin', { email: 'new@t.io', name: 'New', role: 'agent', password: 'another-long-password-1', username: 'officer.new' });
    expect(created.json().username).toBe('officer.new');
    expect((await call('POST', '/users', 'admin', { email: 'new2@t.io', name: 'New2', role: 'agent', password: 'another-long-password-1', username: 'officer.new' })).json()).toEqual({ error: 'username_taken' });
    expect(usernameSchema.parse(' @Dana.Levi ')).toBe('dana.levi');
  });
  it('a reference means @username, username or e-mail of an active account', async () => {
    expect(await resolveUserRef(db, '@dana.levi')).toBe(ids['dana.levi']);
    expect(await resolveUserRef(db, 'DANA.LEVI')).toBe(ids['dana.levi']);
    expect(await resolveUserRef(db, 'dana.levi@t.io')).toBe(ids['dana.levi']);
    expect(await resolveUserRef(db, '@nobody')).toBeNull();
    await db.query('UPDATE users SET active = false WHERE id = $1', [ids['dana.levi']]);
    expect(await resolveUserRef(db, '@dana.levi')).toBeNull();
    await db.query('UPDATE users SET active = true WHERE id = $1', [ids['dana.levi']]);
  });
  it('pickers list the username next to the name', async () => {
    const refs = (await call('GET', '/flow/refs', 'admin')).json() as { users: { name: string; username: string }[] };
    expect(refs.users.find((u) => u.name === 'dana.levi')?.username).toBe('dana.levi');
  });
});

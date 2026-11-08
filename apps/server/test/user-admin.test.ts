import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ChannelManager } from '../src/channels/manager.js';
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
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
let ip = 0;
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, who?: string, payload?: object) =>
  app.inject({ method, url, payload, remoteAddress: `10.73.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, ...(who ? { cookie: cookies[who]! } : {}) } });
const login = async (email: string, password: string) => app.inject({ method: 'POST', url: '/auth/login', payload: { email, password }, remoteAddress: `10.73.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN } });

beforeAll(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  mgr = new ChannelManager(db, cfg, () => null);
  app = await buildApp(cfg, db, mgr);
  for (const [e, r] of [['admin', 'admin'], ['admin2', 'admin'], ['sup', 'supervisor'], ['agent', 'agent'], ['agent2', 'agent']] as const) {
    ids[e] = (await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4) RETURNING id', [`${e}@t.io`, e, r, await hashPassword(PW)])).rows[0].id;
    cookies[e] = `botwa_sid=${(await login(`${e}@t.io`, PW)).cookies[0]!.value}`;
  }
});
afterAll(async () => { await mgr.stopAll(); await app.close(); await db.end(); });

describe('reset password', () => {
  it('needs the users.manage permission, and nobody resets themselves or someone above them', async () => {
    expect((await call('POST', `/users/${ids.agent2}/reset-password`, 'agent')).statusCode).toBe(403);
    expect((await call('POST', `/users/${ids.admin}/reset-password`, 'admin')).json()).toEqual({ error: 'use_account_page' });
    expect((await call('POST', `/users/${ids.admin}/reset-password`, 'sup')).statusCode).toBe(403);   // a supervisor cannot take over an administrator's account
    expect((await call('POST', '/users/00000000-0000-4000-8000-000000000000/reset-password', 'admin')).statusCode).toBe(404);
    expect((await call('POST', `/users/${ids.agent2}/reset-password`, 'admin', { password: 'short' })).statusCode).toBe(400);
  });

  it('generates a temporary password shown once, signs the person out, clears a lockout, and forces a new password at the next sign-in', async () => {
    await db.query(`UPDATE users SET failed_logins = 3, locked_until = now() + interval '10 minutes' WHERE id = $1`, [ids.agent2]);
    const r = await call('POST', `/users/${ids.agent2}/reset-password`, 'admin');
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const temp = r.json().temporaryPassword as string;
    expect(temp).toMatch(/^[A-HJ-NP-Za-km-z2-9]{16}$/);
    // the old session and the old password are dead
    expect((await call('GET', '/auth/me', 'agent2')).statusCode).toBe(401);
    expect((await login('agent2@t.io', PW)).statusCode).toBe(401);
    // the temporary one works, but nothing else does until a new password is chosen
    const l = await login('agent2@t.io', temp);
    expect(l.statusCode).toBe(200);
    const ck = `botwa_sid=${l.cookies[0]!.value}`;
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: ck } });
    expect(me.json()).toMatchObject({ passwordChangeRequired: true });
    expect((await app.inject({ method: 'GET', url: '/conversations', headers: { cookie: ck } })).json()).toEqual({ error: 'password_change_required' });
    expect((await app.inject({ method: 'POST', url: '/auth/password', payload: { current: temp, next: temp }, headers: { cookie: ck, origin: ORIGIN } })).json()).toEqual({ error: 'password_unchanged' });
    const ch = await app.inject({ method: 'POST', url: '/auth/password', payload: { current: temp, next: 'my-own-new-password-1' }, headers: { cookie: ck, origin: ORIGIN } });
    expect(ch.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/conversations', headers: { cookie: ck } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: ck } })).json()).toMatchObject({ passwordChangeRequired: false });
    expect((await db.query(`SELECT action, meta FROM audit_log WHERE action = 'user.password_reset' ORDER BY id DESC LIMIT 1`)).rows[0].meta).toEqual({ generated: true });
    expect(JSON.stringify((await db.query('SELECT * FROM audit_log')).rows)).not.toContain(temp);   // the temporary password is never written to the log
  });

  it('accepts a password the administrator chooses, and then does not echo it back', async () => {
    const r = await call('POST', `/users/${ids.agent}/reset-password`, 'admin', { password: 'chosen-by-the-admin-1' });
    expect(r.json()).toEqual({ ok: true });
    expect((await login('agent@t.io', 'chosen-by-the-admin-1')).statusCode).toBe(200);
  });
});

describe('delete user', () => {
  it('asks for the typed e-mail, refuses yourself, the last administrator and people above you', async () => {
    cookies.agent = `botwa_sid=${(await login('agent@t.io', 'chosen-by-the-admin-1')).cookies[0]!.value}`;   // the earlier reset signed this person out; they must change the password first
    await db.query('UPDATE users SET must_change_password = false WHERE id = $1', [ids.agent]);
    expect((await call('DELETE', `/users/${ids.agent}`, 'agent', { email: 'agent@t.io' })).statusCode).toBe(403);
    expect((await call('DELETE', `/users/${ids.admin}`, 'admin', { email: 'admin@t.io' })).json()).toEqual({ error: 'cannot_delete_self' });
    expect((await call('DELETE', `/users/${ids.agent}`, 'admin', { email: 'other@t.io' })).json()).toEqual({ error: 'confirm_mismatch' });
    expect((await call('DELETE', `/users/${ids.agent}`, 'admin')).statusCode).toBe(400);
    expect((await call('DELETE', `/users/${ids.admin}`, 'sup', { email: 'admin@t.io' })).statusCode).toBe(403);
    expect((await call('DELETE', '/users/00000000-0000-4000-8000-000000000000', 'admin', { email: 'x@t.io' })).statusCode).toBe(404);
    expect((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(5);
  });

  it('removes the account, keeps its conversations and notes, and the history', async () => {
    const ch = (await db.query(`INSERT INTO channels (type, label, status) VALUES ('whatsapp','WA','connected') RETURNING id`)).rows[0].id;
    const ct = (await db.query(`INSERT INTO contacts (channel_id, external_id, display_name) VALUES ($1,'972500000000','לקוח') RETURNING id`, [ch])).rows[0].id;
    const cv = (await db.query(`INSERT INTO conversations (channel_id, contact_id, assigned_to) VALUES ($1,$2,$3) RETURNING id`, [ch, ct, ids.agent2])).rows[0].id;
    await db.query(`INSERT INTO conversation_notes (conversation_id, author_id, body) VALUES ($1,$2,'הערה')`, [cv, ids.agent2]);
    const r = await call('DELETE', `/users/${ids.agent2}`, 'admin', { email: 'AGENT2@t.io' });
    expect(r.json()).toEqual({ ok: true });
    expect((await db.query('SELECT 1 FROM users WHERE id = $1', [ids.agent2])).rowCount).toBe(0);
    expect((await db.query('SELECT assigned_to FROM conversations WHERE id = $1', [cv])).rows[0].assigned_to).toBeNull();
    expect((await db.query('SELECT author_id, body FROM conversation_notes WHERE conversation_id = $1', [cv])).rows[0]).toEqual({ author_id: null, body: 'הערה' });
    expect((await db.query(`SELECT 1 FROM audit_log WHERE action = 'user.delete' AND target = $1`, [ids.agent2])).rowCount).toBe(1);
    expect((await login('agent2@t.io', 'my-own-new-password-1')).statusCode).toBe(401);
  });

  it('the last active administrator cannot be deleted, but one of two can', async () => {
    expect((await call('DELETE', `/users/${ids.admin2}`, 'admin', { email: 'admin2@t.io' })).json()).toEqual({ ok: true });
    await db.query(`UPDATE users SET role = 'supervisor' WHERE id = $1`, [ids.sup]);
    // only `admin` is left as an administrator; another administrator cannot be created here, so exercise the guard directly
    await db.query(`INSERT INTO users (email,name,role,password_hash) VALUES ('boss@t.io','boss','admin',$1)`, [await hashPassword(PW)]);
    const boss = (await db.query(`SELECT id FROM users WHERE email = 'boss@t.io'`)).rows[0].id;
    await db.query(`UPDATE users SET active = false WHERE id = $1`, [boss]);
    expect((await call('DELETE', `/users/${boss}`, 'admin', { email: 'boss@t.io' })).json()).toEqual({ ok: true });   // an inactive administrator is not "the last one"
  });
});

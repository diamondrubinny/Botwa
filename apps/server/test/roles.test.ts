import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ChannelManager } from '../src/channels/manager.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';
import { BUILTIN_ROLES, PERMISSIONS, isSubset } from '../src/permissions.js';

const ORIGIN = 'https://panel.test';
const PW = 'correct-horse-battery';
const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test';
const db = createDb(DB_URL);
const baseEnv = { NODE_ENV: 'test', DATABASE_URL: DB_URL, ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false' };

describe('permission helpers', () => {
  it('built-in supervisor/agent are subsets of admin; admin holds everything', () => {
    expect(BUILTIN_ROLES.admin!.permissions).toEqual([...PERMISSIONS]);
    expect(isSubset(BUILTIN_ROLES.supervisor!.permissions, BUILTIN_ROLES.admin!.permissions)).toBe(true);
    expect(BUILTIN_ROLES.agent!.permissions).toEqual([]);
    expect(isSubset(['channels.manage'], BUILTIN_ROLES.supervisor!.permissions)).toBe(false);
  });
});

describe('custom roles', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let appMfa: Awaited<ReturnType<typeof buildApp>>;
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let ip = 0;
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', url: string, who?: string, payload?: object, a = app) =>
    a.inject({ method, url, payload, remoteAddress: `10.70.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, ...(who ? { cookie: cookies[who]! } : {}) } });

  async function mkUser(email: string, role: string, a = app) {
    const u = await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$1,$2,$3) RETURNING id', [email, role, await hashPassword(PW)]);
    ids[email] = u.rows[0].id;
    const res = await call('POST', '/auth/login', undefined, { email, password: PW }, a);
    cookies[email] = `botwa_sid=${res.cookies[0]!.value}`;
  }
  const mkRole = async (name: string, permissions: string[], mfaRequired = false, who = 'admin@t.io') => {
    const r = await call('POST', '/roles', who, { name, permissions, mfaRequired });
    expect(r.statusCode, name).toBe(201);
    return r.json().key as string;
  };

  beforeAll(async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    const cfg = loadConfig({ ...baseEnv, REQUIRE_MFA_FOR_PRIVILEGED: 'false' });
    app = await buildApp(cfg, db, new ChannelManager(db, cfg));
    const cfgMfa = loadConfig({ ...baseEnv, REQUIRE_MFA_FOR_PRIVILEGED: 'true' });
    appMfa = await buildApp(cfgMfa, db, new ChannelManager(db, cfgMfa));
    await mkUser('admin@t.io', 'admin');
    await mkUser('sup@t.io', 'supervisor');
    await mkUser('agent@t.io', 'agent');
  });
  afterAll(async () => { await app.close(); await appMfa.close(); await db.end(); });

  it('lists built-in roles with their permissions and user counts', async () => {
    const r = (await call('GET', '/roles', 'sup@t.io')).json();
    expect(r.permissions).toEqual([...PERMISSIONS]);
    const admin = r.roles.find((x: { key: string }) => x.key === 'admin');
    expect(admin).toMatchObject({ builtin: true, userCount: 1, mfaRequired: true });
    expect(admin.permissions).toHaveLength(PERMISSIONS.length);
    expect(r.roles.find((x: { key: string }) => x.key === 'agent').permissions).toEqual([]);
    expect((await call('GET', '/roles', 'agent@t.io')).statusCode).toBe(403);
  });

  it('only role managers create/edit/delete custom roles; built-ins are immutable; input validated', async () => {
    expect((await call('POST', '/roles', 'sup@t.io', { name: 'x', permissions: [], mfaRequired: false })).statusCode).toBe(403);
    expect((await call('POST', '/roles', 'admin@t.io', { name: 'x', permissions: ['hack.everything'], mfaRequired: false })).statusCode).toBe(400);
    expect((await call('POST', '/roles', 'admin@t.io', { name: '', permissions: [], mfaRequired: false })).statusCode).toBe(400);
    const key = await mkRole('מוקד בכיר', ['reports.view', 'inbox.view_all']);
    expect(key).toMatch(/^r_[0-9a-f]{10}$/);
    expect((await call('PATCH', `/roles/${key}`, 'admin@t.io', { name: 'מוקד בכיר+', permissions: ['reports.view'], mfaRequired: true })).statusCode).toBe(200);
    expect((await call('PATCH', '/roles/admin', 'admin@t.io', { name: 'x', permissions: [], mfaRequired: false })).json()).toEqual({ error: 'builtin_role' });
    expect((await call('DELETE', '/roles/supervisor', 'admin@t.io')).json()).toEqual({ error: 'builtin_role' });
    expect((await call('PATCH', '/roles/nope', 'admin@t.io', { name: 'x', permissions: [], mfaRequired: false })).statusCode).toBe(404);
    expect((await call('DELETE', `/roles/${key}`, 'admin@t.io')).statusCode).toBe(200);
  });

  it('a custom role grants exactly its permissions across the API', async () => {
    const key = await mkRole('אנליסט', ['reports.view', 'inbox.view_all', 'audit.view']);
    await mkUser('analyst@t.io', key);
    expect((await call('GET', '/reports/summary', 'analyst@t.io')).statusCode).toBe(200);
    expect((await call('GET', '/audit', 'analyst@t.io')).statusCode).toBe(200);
    for (const [m, url] of [['GET', '/channels'], ['GET', '/users'], ['GET', '/settings/bot'], ['GET', '/channels/health'], ['GET', '/backups'], ['GET', '/roles']] as const) {
      expect((await call(m, url, 'analyst@t.io')).statusCode, url).toBe(403);
    }
    const me = (await call('GET', '/auth/me', 'analyst@t.io')).json();
    expect(me).toMatchObject({ role: key, roleName: 'אנליסט' });
    expect(me.permissions.sort()).toEqual(['audit.view', 'inbox.view_all', 'reports.view']);

    // inbox.view_all makes the analyst see every conversation (like a supervisor)
    const ch = (await db.query(`INSERT INTO channels (type, label) VALUES ('whatsapp','x') RETURNING id`)).rows[0].id;
    const ct = (await db.query(`INSERT INTO contacts (channel_id, external_id) VALUES ($1,'c1') RETURNING id`, [ch])).rows[0].id;
    await db.query(`INSERT INTO conversations (channel_id, contact_id, assigned_to) VALUES ($1,$2,$3)`, [ch, ct, ids['sup@t.io']]);
    expect((await call('GET', '/conversations', 'analyst@t.io')).json()).toHaveLength(1);
    expect((await call('GET', '/conversations', 'agent@t.io')).json()).toHaveLength(0);
  });

  it('no privilege escalation: you cannot grant, assign or touch more than you hold', async () => {
    const hr = await mkRole('משאבי אנוש', ['users.view', 'users.manage', 'roles.manage', 'reports.view']);
    await mkUser('hr@t.io', hr);
    // create role beyond own permissions
    expect((await call('POST', '/roles', 'hr@t.io', { name: 'sneaky', permissions: ['channels.manage'], mfaRequired: false })).json()).toEqual({ error: 'role_exceeds_permissions' });
    expect((await call('POST', '/roles', 'hr@t.io', { name: 'ok', permissions: ['reports.view'], mfaRequired: false })).statusCode).toBe(201);
    // assign admin / supervisor (more than own) to a new or existing user
    expect((await call('POST', '/users', 'hr@t.io', { email: 'n@t.io', name: 'n', role: 'admin', password: PW })).json()).toEqual({ error: 'role_exceeds_permissions' });
    expect((await call('POST', '/users', 'hr@t.io', { email: 'n@t.io', name: 'n', role: 'agent', password: PW })).statusCode).toBe(201);
    expect((await call('PATCH', `/users/${ids['agent@t.io']}`, 'hr@t.io', { role: 'supervisor' })).json()).toEqual({ error: 'role_exceeds_permissions' });
    expect((await call('PATCH', `/users/${ids['agent@t.io']}`, 'hr@t.io', { name: 'renamed' })).statusCode).toBe(200);
    // cannot edit / deactivate / reset an administrator
    expect((await call('PATCH', `/users/${ids['admin@t.io']}`, 'hr@t.io', { active: false })).json()).toEqual({ error: 'role_exceeds_permissions' });
    expect((await call('POST', `/users/${ids['admin@t.io']}/reset-mfa`, 'hr@t.io')).statusCode).toBe(403);
    expect((await call('POST', '/users', 'hr@t.io', { email: 'z@t.io', name: 'z', role: 'nope_role', password: PW })).json()).toEqual({ error: 'unknown_role' });
  });

  it('cannot change own role/active; the last active administrator is protected even from an all-powerful custom role', async () => {
    expect((await call('PATCH', `/users/${ids['admin@t.io']}`, 'admin@t.io', { role: 'agent' })).json()).toEqual({ error: 'cannot_demote_self' });
    const god = await mkRole('מנהל על', [...PERMISSIONS]);
    await mkUser('god@t.io', god);
    const demote = await call('PATCH', `/users/${ids['admin@t.io']}`, 'god@t.io', { role: 'agent' });
    expect(demote.statusCode).toBe(409);
    expect(demote.json()).toEqual({ error: 'last_admin' });
    expect((await call('PATCH', `/users/${ids['admin@t.io']}`, 'god@t.io', { active: false })).json()).toEqual({ error: 'last_admin' });
    // with a second admin the first can be demoted
    await mkUser('admin2@t.io', 'admin');
    expect((await call('PATCH', `/users/${ids['admin@t.io']}`, 'god@t.io', { role: 'agent' })).statusCode).toBe(200);
  });

  it('roles in use cannot be deleted; role changes sign the user out', async () => {
    const key = await mkRole('זמני', ['reports.view'], false, 'admin2@t.io');
    await mkUser('temp@t.io', key);
    expect((await call('DELETE', `/roles/${key}`, 'admin2@t.io')).json()).toEqual({ error: 'role_in_use' });
    await call('PATCH', `/users/${ids['temp@t.io']}`, 'admin2@t.io', { role: 'agent' });
    expect((await call('GET', '/auth/me', 'temp@t.io')).statusCode).toBe(401);
    expect((await call('DELETE', `/roles/${key}`, 'admin2@t.io')).statusCode).toBe(200);
  });

  it('permission changes apply immediately to existing sessions; unknown stored permissions are ignored', async () => {
    const key = await mkRole('שינוי', ['reports.view'], false, 'admin2@t.io');
    await mkUser('live@t.io', key);
    expect((await call('GET', '/reports/summary', 'live@t.io')).statusCode).toBe(200);
    await call('PATCH', `/roles/${key}`, 'admin2@t.io', { name: 'שינוי', permissions: ['tags.manage'], mfaRequired: false });
    expect((await call('GET', '/reports/summary', 'live@t.io')).statusCode).toBe(403);
    await db.query(`UPDATE roles SET permissions = ARRAY['reports.view','bogus.perm'] WHERE key = $1`, [key]);
    expect((await call('GET', '/auth/me', 'live@t.io')).json().permissions).toEqual(['reports.view']);
  });

  it('a custom role flagged "MFA required" is blocked until the user enrols a second factor (server-side)', async () => {
    const key = await mkRole('רגיש', ['reports.view'], true, 'admin2@t.io');
    await mkUser('sens@t.io', key, appMfa);
    expect((await call('GET', '/reports/summary', 'sens@t.io', undefined, appMfa)).json()).toEqual({ error: 'mfa_enrollment_required' });
    const me = (await call('GET', '/auth/me', 'sens@t.io', undefined, appMfa)).json();
    expect(me.mfaEnrollmentRequired).toBe(true);
    // a role without the flag is not affected
    await mkUser('plain@t.io', 'agent', appMfa);
    expect((await call('GET', '/auth/me', 'plain@t.io', undefined, appMfa)).json().mfaEnrollmentRequired).toBe(false);
  });
});

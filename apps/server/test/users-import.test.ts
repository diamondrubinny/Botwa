import { randomBytes } from 'node:crypto';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ChannelManager } from '../src/channels/manager.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashPassword, verifyPassword } from '../src/password.js';
import { parseUsersWorkbook } from '../src/usersImport.js';

const book = async (rows: (string | null)[][]) => { const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('x'); rows.forEach((r) => ws.addRow(r)); return Buffer.from(await wb.xlsx.writeBuffer()); };
const ROLES = [{ key: 'admin', name: 'מנהל' }, { key: 'supervisor', name: 'מפקח' }, { key: 'agent', name: 'נציג' }];

describe('reading people from a workbook', () => {
  it('Hebrew header: name, e-mail, job title, permission; bad and repeated rows are reported', async () => {
    const p = await parseUsersWorkbook(await book([
      ['רשימת עובדים'], [],
      ['שם מלא', 'דוא"ל', 'תפקיד', 'הרשאה'],
      ['דנה כהן', 'Dana@Example.org', 'ממונת בטיחות', 'נציג'],
      ['אבי לוי', 'avi@example.org', 'רכז', 'מפקח'],
      ['', 'nobody@example.org', 'x', ''],
      ['רון', 'not-an-email', '', ''],
      ['דנה שוב', 'dana@example.org', '', ''],
      ['יעל', 'yael@example.org', '', 'מנכ״ל'],
    ]), ROLES);
    expect(p.headerFound).toBe(true);
    expect(p.rows).toEqual([
      { row: 4, name: 'דנה כהן', email: 'dana@example.org', jobTitle: 'ממונת בטיחות', role: 'agent', roleText: 'נציג' },
      { row: 5, name: 'אבי לוי', email: 'avi@example.org', jobTitle: 'רכז', role: 'supervisor', roleText: 'מפקח' },
      { row: 9, name: 'יעל', email: 'yael@example.org', jobTitle: null, role: null, roleText: 'מנכ״ל' },
    ]);
    expect(p.invalid.map((x) => x.reason)).toEqual(['missing_name', 'bad_email', 'duplicate']);
  });

  it('English header with first and last name; and a sheet with no header at all', async () => {
    const en = await parseUsersWorkbook(await book([['First name', 'Last name', 'E-mail', 'Job title'], ['Dana', 'Cohen', 'dana@x.org', 'Safety officer']]), ROLES);
    expect(en.rows[0]).toMatchObject({ name: 'Dana Cohen', email: 'dana@x.org', jobTitle: 'Safety officer' });
    const bare = await parseUsersWorkbook(await book([['דנה כהן', 'dana@x.org', 'ממונה'], ['אבי לוי', 'avi@x.org', 'רכז']]), ROLES);
    expect(bare.headerFound).toBe(false);
    expect(bare.rows.map((r) => [r.name, r.email, r.jobTitle])).toEqual([['דנה כהן', 'dana@x.org', 'ממונה'], ['אבי לוי', 'avi@x.org', 'רכז']]);
    await expect(parseUsersWorkbook(await book([['a', 'b'], ['c', 'd']]), ROLES)).rejects.toThrow('unknown_workbook');
  });
});

const ORIGIN = 'https://panel.test';
const PW = 'correct-horse-battery';
const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test', ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false', MEDIA_ALLOW_UNSCANNED: 'true' });
const db = createDb(cfg.DATABASE_URL);
let app: Awaited<ReturnType<typeof buildApp>>;
const cookies: Record<string, string> = {};
let ip = 0;
const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}) => app.inject({ method, url, payload: payload as never, remoteAddress: `10.78.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, cookie: cookies[who]!, ...headers } });
const multipart = (buf: Buffer, name = 'people.xlsx') => { const b = '----u'; return { body: Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), buf, Buffer.from(`\r\n--${b}--\r\n`)]), headers: { 'content-type': `multipart/form-data; boundary=${b}` } }; };

beforeAll(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  app = await buildApp(cfg, db, new ChannelManager(db, cfg));
  for (const [e, role] of [['admin@t.io', 'admin'], ['sup@t.io', 'supervisor'], ['ag@t.io', 'agent']] as const) {
    await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4)', [e, e, role, await hashPassword(PW)]);
    cookies[e] = `botwa_sid=${(await app.inject({ method: 'POST', url: '/auth/login', payload: { email: e, password: PW }, remoteAddress: `10.78.9.${++ip}`, headers: { origin: ORIGIN } })).cookies[0]!.value}`;
  }
});
afterAll(async () => { await app.close(); await db.end(); });

describe('creating many users at once', () => {
  it('preview shows who is new and who exists; creating uses one first password that must be changed', async () => {
    const m = multipart(await book([['שם', 'אימייל', 'תפקיד'], ['דנה כהן', 'dana@t.io', 'ממונת בטיחות'], ['הסוכן', 'ag@t.io', 'נציג ותיק']]));
    const pv = await call('admin@t.io', 'POST', '/users/import/preview', m.body, m.headers);
    expect(pv.statusCode).toBe(200);
    expect(pv.json().rows.map((r: { email: string; exists: boolean }) => [r.email, r.exists])).toEqual([['dana@t.io', false], ['ag@t.io', true]]);
    expect((await call('ag@t.io', 'POST', '/users/import/preview', m.body, m.headers)).statusCode).toBe(403);
    const bad = multipart(Buffer.from('not a workbook'), 'evil.exe');
    expect((await call('admin@t.io', 'POST', '/users/import/preview', bad.body, bad.headers)).statusCode).toBe(415);

    const first = 'Strong-First-Pass-2026';
    const r = await call('admin@t.io', 'POST', '/users/import', { password: first, defaultRole: 'agent', updateExisting: true, rows: [
      { name: 'דנה כהן', email: 'dana@t.io', jobTitle: 'ממונת בטיחות', role: null },
      { name: 'הסוכן', email: 'ag@t.io', jobTitle: 'נציג ותיק' },
      { name: 'נועה', email: 'NOA@t.io', jobTitle: null, role: 'supervisor' },
    ] });
    expect(r.json()).toEqual({ created: 2, updated: 1, skipped: [] });
    const dana = (await db.query(`SELECT role, job_title, must_change_password, password_hash FROM users WHERE email = 'dana@t.io'`)).rows[0];
    expect(dana).toMatchObject({ role: 'agent', job_title: 'ממונת בטיחות', must_change_password: true });
    expect(await verifyPassword(dana.password_hash, first)).toBe(true);
    const noa = (await db.query(`SELECT role, password_hash FROM users WHERE email = 'noa@t.io'`)).rows[0];
    expect(noa.role).toBe('supervisor');
    expect(noa.password_hash).not.toBe(dana.password_hash);                         // own salt per person
    expect((await db.query(`SELECT job_title, must_change_password FROM users WHERE email = 'ag@t.io'`)).rows[0]).toEqual({ job_title: 'נציג ותיק', must_change_password: false });
    // the new person signs in and is asked to change the password
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'dana@t.io', password: first }, remoteAddress: '10.78.9.200', headers: { origin: ORIGIN } });
    expect(login.statusCode).toBe(200);
    const me = await app.inject({ url: '/auth/me', headers: { cookie: `botwa_sid=${login.cookies[0]!.value}` } });
    expect(me.json().passwordChangeRequired).toBe(true);
  });

  it('a short password, an unknown role, or a role above your own are refused; nothing is created', async () => {
    const row = [{ name: 'x', email: 'x1@t.io' }];
    expect((await call('admin@t.io', 'POST', '/users/import', { password: 'short', defaultRole: 'agent', rows: row })).statusCode).toBe(400);
    expect((await call('admin@t.io', 'POST', '/users/import', { password: 'Long-enough-pass-1', defaultRole: 'boss', rows: row })).json().error).toBe('unknown_role');
    // a supervisor holds users.manage? only if their role allows it; either way they cannot hand out admin
    const sup = await call('sup@t.io', 'POST', '/users/import', { password: 'Long-enough-pass-1', defaultRole: 'agent', rows: [{ name: 'y', email: 'y1@t.io', role: 'admin' }] });
    expect([403]).toContain(sup.statusCode);
    expect((await db.query(`SELECT count(*)::int AS n FROM users WHERE email IN ('x1@t.io', 'y1@t.io')`)).rows[0].n).toBe(0);
    expect((await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'user.import'`)).rows[0].n).toBe(1);
  });
});

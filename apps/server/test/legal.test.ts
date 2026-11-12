import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ChannelManager } from '../src/channels/manager.js';
import type { AdapterFactory } from '../src/channels/types.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';

const ORIGIN = 'https://panel.test';
const PW = 'correct-horse-battery';
const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test', ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false', MESSAGE_RETENTION_DAYS: '180', BACKUP_KEEP: '14' });
const db = createDb(cfg.DATABASE_URL);
let app: Awaited<ReturnType<typeof buildApp>>;
let mgr: ChannelManager;
const cookies: Record<string, string> = {};
let ip = 0;
const call = (method: 'GET' | 'PUT', url: string, who?: string, payload?: object) =>
  app.inject({ method, url, payload, remoteAddress: `10.98.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, ...(who ? { cookie: cookies[who]! } : {}) } });
const good = { orgName: 'יחידת הבטיחות', email: 'privacy@example.org', phone: '+972-3-0000000', address: 'רחוב הדוגמה 1, תל אביב', officer: 'ממונה הפרטיות', approved: false };

beforeAll(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  mgr = new ChannelManager(db, cfg, (() => null) as unknown as AdapterFactory);
  app = await buildApp(cfg, db, mgr);
  for (const [e, r] of [['adm', 'admin'], ['ag', 'agent']] as const) {
    await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4)', [`${e}@t.io`, e, r, await hashPassword(PW)]);
    cookies[e] = `botwa_sid=${(await app.inject({ method: 'POST', url: '/auth/login', payload: { email: `${e}@t.io`, password: PW }, remoteAddress: `10.98.9.${++ip}`, headers: { origin: ORIGIN } })).cookies[0]!.value}`;
  }
  await db.query(`INSERT INTO channels (type, label) VALUES ('whatsapp_cloud', 'רשמי')`);
});
afterAll(async () => { await mgr.stopAll(); await app.close(); await db.end(); });

describe('public legal pages (for Meta and the public)', () => {
  it('serve plain HTML without login, scripts or a second CSP', async () => {
    for (const p of ['/legal/privacy', '/legal/terms', '/legal/data-deletion']) {
      const r = await call('GET', p);
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toContain('text/html');
      expect(r.body).toMatch(/^<!doctype html>\n<html lang="he" dir="rtl">/);
      expect(r.body).not.toContain('<script');
      expect(String(r.headers['content-security-policy'])).toBe("default-src 'none'; style-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      expect(r.body).toContain('lang="en" dir="ltr"');                                   // English summary for reviewers
      expect(r.body).toContain('[פרטי קשר: יש להשלים בהגדרות המערכת]');              // not filled yet
    }
    expect((await call('GET', '/legal/style.css')).headers['content-type']).toContain('text/css');
  });

  it('describe what the system really does: active channels, retention, backups, no external AI', async () => {
    const b = (await call('GET', '/legal/privacy')).body;
    expect(b).toContain('WhatsApp (WhatsApp Business Platform של Meta)');
    expect(b).not.toContain('<strong>Telegram:</strong>');                               // no Telegram channel here
    expect(b).toContain('לאחר 180 ימים ללא פעילות');
    expect(b).toContain('עד 14 ימים');
    expect(b).toContain('<strong>אינו</strong> משתמש בשירות בינה מלאכותית חיצוני');
    expect((await call('GET', '/legal/terms')).body).toContain('כבאות והצלה 102');
  });

  it('only settings.manage edits the details; text fields cannot carry markup', async () => {
    expect((await call('GET', '/settings/legal', 'ag')).statusCode).toBe(403);
    expect((await call('PUT', '/settings/legal', 'ag', good)).statusCode).toBe(403);
    for (const bad of [{ orgName: '<b>x</b>' }, { email: 'not-mail' }, { phone: 'abc' }, { address: 'א\nב' }]) expect((await call('PUT', '/settings/legal', 'adm', { ...good, ...bad })).statusCode).toBe(400);
    expect((await call('PUT', '/settings/legal', 'adm', good)).statusCode).toBe(200);
    const s = (await call('GET', '/settings/legal', 'adm')).json();
    expect(s).toMatchObject({ ...good, urls: { privacy: 'https://panel.test/legal/privacy', terms: 'https://panel.test/legal/terms', deletion: 'https://panel.test/legal/data-deletion' } });
    const b = (await call('GET', '/legal/privacy')).body;
    expect(b).toContain('<strong>יחידת הבטיחות</strong>');
    expect(b).toContain('<a href="mailto:privacy@example.org">privacy@example.org</a>');
    expect(b).toContain('נוסח טכני בהליך בדיקה משפטית');
    expect((await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'settings.legal'`)).rows[0].n).toBe(1);
  });

  it('escapes everything it prints, and drops the draft line once approved', async () => {
    await db.query(`UPDATE settings SET value = value || '{"orgName":"A&B \\"x\\" ''y''","approved":true}' WHERE key = 'legal'`);   // even data written around the API
    const b = (await call('GET', '/legal/privacy')).body;
    expect(b).toContain('A&amp;B &quot;x&quot; &#39;y&#39;');
    expect(b).not.toContain('נוסח טכני בהליך בדיקה משפטית');
  });

  it('stay reachable when the panel firewall limits who may open the panel', async () => {
    const put = await app.inject({ method: 'PUT', url: '/settings/firewall', payload: { enabled: true, allow: ['10.98.0.0/16'], deny: [] }, remoteAddress: '10.98.200.1', headers: { origin: ORIGIN, cookie: cookies.adm! } });
    expect(put.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/settings/legal', remoteAddress: '203.0.113.9', headers: { cookie: cookies.adm! } })).statusCode).toBe(403);   // the panel is closed to outsiders
    expect((await app.inject({ method: 'GET', url: '/legal/privacy', remoteAddress: '203.0.113.9' })).statusCode).toBe(200);                                     // the policy is not
  });
});

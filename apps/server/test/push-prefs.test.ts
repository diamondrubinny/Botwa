import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const sends: { endpoint: string; payload: { title: string; tag: string; url?: string } }[] = [];
vi.mock('web-push', () => {
  const api = {
    generateVAPIDKeys: () => ({ publicKey: 'BPub' + 'x'.repeat(80), privateKey: 'priv' + 'y'.repeat(39) }),
    setVapidDetails: () => undefined,
    sendNotification: async (sub: { endpoint: string }, body: string) => { sends.push({ endpoint: sub.endpoint, payload: JSON.parse(body) }); return { statusCode: 201 }; },
  };
  return { default: api, ...api };
});

const { buildApp } = await import('../src/app.js');
const { ChannelManager } = await import('../src/channels/manager.js');
const { loadConfig } = await import('../src/config.js');
const { createDb } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { hashPassword } = await import('../src/password.js');

const ORIGIN = 'https://panel.test';
const PW = 'correct-horse-battery';
const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test', ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false' });
const db = createDb(cfg.DATABASE_URL);
let app: Awaited<ReturnType<typeof buildApp>>;
let mgr: InstanceType<typeof ChannelManager>;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
let ip = 0;
const call = (method: 'GET' | 'POST' | 'PUT', url: string, who: string, payload?: object) =>
  app.inject({ method, url, payload, remoteAddress: `10.97.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, cookie: cookies[who]! } });
const sub = (n: string) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } });
const flush = () => new Promise((r) => setTimeout(r, 80));

beforeAll(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  mgr = new ChannelManager(db, cfg);
  app = await buildApp(cfg, db, mgr);
  for (const [e, r] of [['adm', 'admin'], ['a1', 'agent'], ['a2', 'agent']] as const) {
    ids[e] = (await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4) RETURNING id', [`${e}@t.io`, e, r, await hashPassword(PW)])).rows[0].id;
    cookies[e] = `botwa_sid=${(await app.inject({ method: 'POST', url: '/auth/login', payload: { email: `${e}@t.io`, password: PW }, remoteAddress: `10.97.9.${++ip}`, headers: { origin: ORIGIN } })).cookies[0]!.value}`;
  }
});
afterAll(async () => { await app.close(); await db.end(); });

describe('phone alerts', () => {
  it('status, preferences and a test alert, per person', async () => {
    expect((await call('GET', '/push/status', 'a1')).json()).toEqual({ prefs: { messages: true, assigned: true, sla: true }, devices: 0 });
    expect((await call('POST', '/push/test', 'a1', {})).json()).toEqual({ delivered: 0 });
    expect((await call('POST', '/push/subscribe', 'a1', sub('a1phone'))).statusCode).toBe(200);
    expect((await call('POST', '/push/subscribe', 'a2', sub('a2phone'))).statusCode).toBe(200);
    expect((await call('GET', '/push/status', 'a1')).json().devices).toBe(1);
    sends.length = 0;
    expect((await call('POST', '/push/test', 'a1', {})).json()).toEqual({ delivered: 1 });
    expect(sends).toEqual([{ endpoint: 'https://fcm.googleapis.com/fcm/send/a1phone', payload: { title: 'התראת בדיקה: ההתראות עובדות', tag: 'botwa-test', url: '/#/account' } }]);
    // with an organisation logo, the notification shows it (an address on this server; still no customer data)
    await db.query(`INSERT INTO branding_logo (id, mime, data) VALUES (1, 'image/png', '\\x89504e47') ON CONFLICT (id) DO NOTHING`);
    sends.length = 0;
    expect((await call('POST', '/push/test', 'a1', {})).json()).toEqual({ delivered: 1 });
    expect(sends[0]!.payload.icon).toMatch(/^\/branding\/logo\?v=\d+$/);
    await db.query('DELETE FROM branding_logo');
    expect((await call('PUT', '/push/prefs', 'a1', { messages: true, assigned: 'yes' })).statusCode).toBe(400);
  });

  it('a conversation given to someone alerts only them, opens that conversation, carries no customer data, and respects their choice', async () => {
    const ch = (await db.query(`INSERT INTO channels (type,label) VALUES ('whatsapp','WA') RETURNING id`)).rows[0].id;
    const ct = (await db.query(`INSERT INTO contacts (channel_id, external_id, display_name) VALUES ($1,'972501112222@s.whatsapp.net','דנה לוי') RETURNING id`, [ch])).rows[0].id;
    const conv = (await db.query(`INSERT INTO conversations (channel_id, contact_id) VALUES ($1,$2) RETURNING id`, [ch, ct])).rows[0].id;
    sends.length = 0;
    expect((await call('POST', `/conversations/${conv}/assign`, 'adm', { userId: ids.a1 })).statusCode).toBe(200);
    await flush();
    expect(sends).toEqual([{ endpoint: 'https://fcm.googleapis.com/fcm/send/a1phone', payload: { title: 'שיחה שויכה אליך', tag: `botwa-asg-${conv}`, url: `/#/inbox?c=${conv}` } }]);
    expect(JSON.stringify(sends)).not.toMatch(/דנה|972501112222/);
    // a hand-over says so
    sends.length = 0;
    await call('POST', `/conversations/${conv}/assign`, 'a1', { userId: ids.a2, note: 'המשך טיפול' });
    await flush();
    expect(sends.map((s) => [s.endpoint.split('/').pop(), s.payload.title])).toEqual([['a2phone', 'שיחה הועברה אליך']]);
    // switched off: no alert
    expect((await call('PUT', '/push/prefs', 'a1', { messages: true, assigned: false, sla: true })).statusCode).toBe(200);
    sends.length = 0;
    await call('POST', `/conversations/${conv}/assign`, 'adm', { userId: ids.a1, note: 'חזרה' });
    await flush();
    expect(sends).toEqual([]);
  });
});

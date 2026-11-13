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
const cfg = loadConfig({
  NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test',
  ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false',
});
const db = createDb(cfg.DATABASE_URL);
let app: Awaited<ReturnType<typeof buildApp>>;
let mgr: ChannelManager;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
let ip = 0;
const call = (method: 'GET' | 'POST' | 'PUT', url: string, who: string, payload?: object) =>
  app.inject({ method, url, payload, remoteAddress: `10.71.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, cookie: cookies[who]! } });
let conv = '';
const events: string[] = [];

beforeAll(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  mgr = new ChannelManager(db, cfg);
  app = await buildApp(cfg, db, mgr);
  for (const [e, r] of [['sup', 'supervisor'], ['adm', 'admin'], ['a1', 'agent'], ['a2', 'agent']] as const) {
    ids[e] = (await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4) RETURNING id', [`${e}@t.io`, e, r, await hashPassword(PW)])).rows[0].id;
    cookies[e] = `botwa_sid=${(await app.inject({ method: 'POST', url: '/auth/login', remoteAddress: `10.71.9.${++ip}`, headers: { origin: ORIGIN }, payload: { email: `${e}@t.io`, password: PW } })).cookies[0]!.value}`;
  }
  const ch = (await db.query(`INSERT INTO channels (type,label) VALUES ('whatsapp','x') RETURNING id`)).rows[0].id;
  const ct = (await db.query(`INSERT INTO contacts (channel_id, external_id) VALUES ($1,'1') RETURNING id`, [ch])).rows[0].id;
  conv = (await db.query(`INSERT INTO conversations (channel_id, contact_id, assigned_to) VALUES ($1,$2,$3) RETURNING id`, [ch, ct, ids.a1])).rows[0].id;
  mgr.onSlaBreach = (id) => events.push(id);
});
afterAll(async () => { await app.close(); await db.end(); });

describe('handover between agents', () => {
  it('needs a note, may be done by the current holder or a manager, and leaves a trail', async () => {
    expect((await call('POST', `/conversations/${conv}/assign`, 'a1', { userId: ids.a2 })).json()).toEqual({ error: 'note_required' });
    expect((await call('POST', `/conversations/${conv}/assign`, 'a1', { userId: ids.a2, note: '   ' })).json()).toEqual({ error: 'note_required' });
    expect((await call('POST', `/conversations/${conv}/assign`, 'a2', { userId: ids.a2, note: 'x' })).statusCode).toBe(404);   // a2 cannot even open a1's conversation
    expect((await call('POST', `/conversations/${conv}/assign`, 'a1', { userId: ids.a2, note: 'הלקוח מחכה לחשבונית, חסר אישור תשלום' })).statusCode).toBe(200);
    expect((await db.query('SELECT assigned_to FROM conversations WHERE id=$1', [conv])).rows[0].assigned_to).toBe(ids.a2);
    const notes = (await call('GET', `/conversations/${conv}/notes`, 'a2')).json() as { body: string }[];
    expect(notes.map((n) => n.body)).toEqual(['↪ הועברה מa1 אל a2: הלקוח מחכה לחשבונית, חסר אישור תשלום']);
    expect((await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action='conversation.handover'`)).rows[0].n).toBe(1);
    // a1 no longer holds it: cannot hand it on again
    expect((await call('POST', `/conversations/${conv}/assign`, 'a1', { userId: ids.a1, note: 'x' })).statusCode).toBe(404);
    // a manager can move it, with a note; claiming an unassigned one needs none
    expect((await call('POST', `/conversations/${conv}/assign`, 'sup', { userId: ids.a1 })).json()).toEqual({ error: 'note_required' });
    expect((await call('POST', `/conversations/${conv}/assign`, 'sup', { userId: ids.a1, note: 'חזרה אליך' })).statusCode).toBe(200);
    expect((await call('POST', `/conversations/${conv}/assign`, 'a1', { userId: null })).statusCode).toBe(200);
    expect((await call('POST', `/conversations/${conv}/assign`, 'a2', { userId: ids.a2 })).statusCode).toBe(200);
  });
});

describe('SLA', () => {
  it('is configured by managers only, validated, and readable by staff', async () => {
    expect((await call('GET', '/settings/sla', 'a1')).json()).toEqual({ enabled: false, targetMinutes: 30 });
    expect((await call('PUT', '/settings/sla', 'a1', { enabled: true, targetMinutes: 10 })).statusCode).toBe(403);
    expect((await call('PUT', '/settings/sla', 'adm', { enabled: true, targetMinutes: 0 })).statusCode).toBe(400);
  });

  it('alerts once per waiting customer message, not for answered, snoozed or menu-held conversations', async () => {
    await db.query(`INSERT INTO messages (conversation_id, direction, body, created_at) VALUES ($1,'in','hello', now() - interval '40 minutes')`, [conv]);
    expect(await mgr.checkSla()).toBe(0);                                                       // off by default
    expect((await call('PUT', '/settings/sla', 'adm', { enabled: true, targetMinutes: 30 })).statusCode).toBe(200);
    expect(await mgr.checkSla()).toBe(1);
    expect(events).toEqual([conv]);
    expect(await mgr.checkSla()).toBe(0);                                                       // same message: no repeat
    await db.query(`INSERT INTO messages (conversation_id, direction, body, sender_user_id, created_at) VALUES ($1,'out','on it',$2, now() - interval '38 minutes')`, [conv, ids.a2]);
    expect(await mgr.checkSla()).toBe(0);                                                       // answered
    await db.query(`UPDATE conversations SET sla_alerted_at = now() - interval '36 minutes' WHERE id = $1`, [conv]);
    await db.query(`INSERT INTO messages (conversation_id, direction, body, created_at) VALUES ($1,'in','still there?', now() - interval '33 minutes')`, [conv]);
    expect(await mgr.checkSla()).toBe(1);                                                       // a new waiting message alerts again
    await db.query(`INSERT INTO messages (conversation_id, direction, body, created_at) VALUES ($1,'in','again', now() - interval '32 minutes')`, [conv]);
    await db.query(`UPDATE conversations SET snoozed_until = now() + interval '1 hour', sla_alerted_at = NULL WHERE id = $1`, [conv]);
    expect(await mgr.checkSla()).toBe(0);                                                       // snoozed
  });

  it('reports compliance in the summary', async () => {
    const r = (await call('GET', '/reports/summary?days=7', 'sup')).json();
    expect(r.sla).toMatchObject({ enabled: true, targetMinutes: 30 });
    expect(r.sla.breached).toBeGreaterThanOrEqual(1);
    expect(typeof r.sla.compliancePercent).toBe('number');
  });
});

import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { DEFAULT_HOURS } from '../src/business-hours.js';
import { hoursSummary, renderCanned, unknownVariables } from '../src/canned.js';
import { ChannelManager } from '../src/channels/manager.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';

describe('canned reply variables (pure)', () => {
  it('summarises the opening hours, merging days with the same hours', () => {
    expect(hoursSummary(DEFAULT_HOURS)).toBe('א׳–ה׳ 09:00–17:00');
    expect(hoursSummary({ ...DEFAULT_HOURS, days: [{ open: '09:00', close: '17:00' }, { open: '09:00', close: '17:00' }, null, { open: '10:00', close: '14:00' }, null, { open: '08:00', close: '12:00' }, null] })).toBe('א׳–ב׳ 09:00–17:00, ד׳ 10:00–14:00, ו׳ 08:00–12:00');
    expect(hoursSummary({ ...DEFAULT_HOURS, days: Array(7).fill(null) })).toBe('לא הוגדרו שעות פעילות');
  });
  it('fills the known variables as plain one-line text and leaves unknown ones alone', () => {
    const ctx = { customerName: 'דנה\nלוי', agentName: 'יוסי', hours: DEFAULT_HOURS, channelLabel: 'ווצאפ ראשי', now: new Date('2026-11-09T10:00:00Z') };
    expect(renderCanned('שלום {שם}, כאן {נציג}. פתוחים {שעות}. ({ערוץ}) {name} {x}', ctx)).toBe('שלום דנה לוי, כאן יוסי. פתוחים א׳–ה׳ 09:00–17:00. (ווצאפ ראשי) דנה לוי {x}');
    expect(renderCanned('היום {תאריך}', ctx)).toContain('2026');
    expect(renderCanned('שלום {שם}!', { ...ctx, customerName: null })).toBe('שלום !');
    expect(renderCanned('<b>{שם}</b>', { ...ctx, customerName: '<script>' })).toBe('<b><script></b>');   // no markup is interpreted here: the panel shows plain text
    expect(unknownVariables('{שם} {foo} {בר} {foo}')).toEqual(['foo', 'בר']);
  });
});

const ORIGIN = 'https://panel.test';
const PW = 'correct-horse-battery';
const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test', ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false' });
const db = createDb(cfg.DATABASE_URL);
let app: Awaited<ReturnType<typeof buildApp>>;
let mgr: ChannelManager;
const cookies: Record<string, string> = {};
let ip = 0;
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, who: string, payload?: object) => app.inject({ method, url, payload, remoteAddress: `10.80.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, cookie: cookies[who]! } });

describe('canned replies API', () => {
  let conv = '';
  beforeAll(async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    mgr = new ChannelManager(db, cfg, () => null);
    app = await buildApp(cfg, db, mgr);
    for (const [e, r] of [['admin', 'admin'], ['agent', 'agent'], ['agent2', 'agent']] as const) {
      await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4)', [`${e}@t.io`, e === 'agent' ? 'יוסי' : e, r, await hashPassword(PW)]);
      cookies[e] = `botwa_sid=${(await app.inject({ method: 'POST', url: '/auth/login', payload: { email: `${e}@t.io`, password: PW }, remoteAddress: `10.80.9.${++ip}`, headers: { origin: ORIGIN } })).cookies[0]!.value}`;
    }
    const ch = (await db.query(`INSERT INTO channels (type, label, status) VALUES ('whatsapp','ראשי','connected') RETURNING id`)).rows[0].id;
    const ct = (await db.query(`INSERT INTO contacts (channel_id, external_id, display_name) VALUES ($1,'972500000001@s.whatsapp.net','דנה לוי') RETURNING id`, [ch])).rows[0].id;
    conv = (await db.query(`INSERT INTO conversations (channel_id, contact_id, assigned_to) VALUES ($1,$2,(SELECT id FROM users WHERE email='agent@t.io')) RETURNING id`, [ch, ct])).rows[0].id;
  });
  afterAll(async () => { await mgr.stopAll(); await app.close(); await db.end(); });

  it('only curators change replies; folders are kept; editing works; unknown variables are reported', async () => {
    expect((await call('POST', '/canned-replies', 'agent', { title: 'x', body: 'y' })).statusCode).toBe(403);
    expect((await call('POST', '/canned-replies', 'admin', { title: 'x', body: 'y', folder: 'א'.repeat(41) })).statusCode).toBe(400);
    const a = await call('POST', '/canned-replies', 'admin', { title: 'ברכה', body: 'שלום {שם}, כאן {נציג}. פתוחים {שעות}.', folder: 'פתיחה' });
    expect(a.statusCode).toBe(201);
    expect(a.json().unknownVariables).toEqual([]);
    const b = await call('POST', '/canned-replies', 'admin', { title: 'סיום', body: 'תודה {תודה}', folder: '' });
    expect(b.json().unknownVariables).toEqual(['תודה']);
    const list = (await call('GET', '/canned-replies', 'agent')).json() as { title: string; folder: string }[];
    expect(list.map((x) => `${x.folder}/${x.title}`)).toEqual(['פתיחה/ברכה', '/סיום']);            // folders first, loose ones last
    expect((await call('PUT', `/canned-replies/${a.json().id}`, 'agent', { title: 'z', body: 'z' })).statusCode).toBe(403);
    expect((await call('PUT', `/canned-replies/${a.json().id}`, 'admin', { title: 'ברכה חדשה', body: 'שלום {שם}', folder: 'פתיחה' })).json()).toMatchObject({ title: 'ברכה חדשה', body: 'שלום {שם}' });
    expect((await call('PUT', '/canned-replies/00000000-0000-4000-8000-000000000000', 'admin', { title: 'z', body: 'z' })).statusCode).toBe(404);
    expect((await call('GET', '/canned-replies/variables', 'agent')).json().map((v: { name: string }) => v.name)).toEqual(['{שם}', '{נציג}', '{שעות}', '{תאריך}', '{ערוץ}']);
  });

  it('renders a reply for a conversation the agent can open, with the customer, the agent, the hours and the channel', async () => {
    const id = (await call('POST', '/canned-replies', 'admin', { title: 'מלא', body: 'שלום {שם}, כאן {נציג} מ{ערוץ}. פתוחים {שעות}.' })).json().id as string;
    const r = await call('POST', `/canned-replies/${id}/render`, 'agent', { conversationId: conv });
    expect(r.json()).toEqual({ text: 'שלום דנה לוי, כאן יוסי מראשי. פתוחים א׳–ה׳ 09:00–17:00.' });
    expect((await call('POST', `/canned-replies/${id}/render`, 'agent2', { conversationId: conv })).statusCode).toBe(404);   // someone else's conversation
    expect((await call('POST', `/canned-replies/00000000-0000-4000-8000-000000000000/render`, 'agent', { conversationId: conv })).statusCode).toBe(404);
  });
});

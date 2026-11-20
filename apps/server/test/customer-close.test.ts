import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { DEFAULT_AUTOMATIONS, isCloseRequest } from '../src/automations.js';
import { DEFAULT_BOT } from '../src/bot.js';
import { ChannelManager } from '../src/channels/manager.js';
import type { AdapterContext, AdapterFactory, ChannelAdapter } from '../src/channels/types.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';

describe('close request detection', () => {
  it('finds "it is solved" and "close it", and leaves questions, "not yet", "but" and other closings alone', () => {
    for (const t of ['הסתדרתי', 'הסתדרתי, תודה רבה!', 'הסתדר תודה', 'הבעיה נפתרה', 'טופל, תודה', 'תסגרו את הקריאה', 'אפשר לסגור', 'אפשר לסגור את הפנייה, תודה', 'ותסגרו את השיחה', 'You can close the ticket'])
      expect(isCloseRequest(t), t).toBe(true);
    for (const t of ['', 'לא הסתדרתי', 'עדיין לא הסתדר', 'הסתדרתי?', 'אל תסגרו', 'הסתדרתי אבל יש לי עוד שאלה', 'סגרו לי את החשמל בבניין', 'תסגרו את החלון בחדר', 'איך סוגרים את הקריאה', 'זה טופל?', 'שלום', 'תודה'])
      expect(isCloseRequest(t), t).toBe(false);
  });
});

const ORIGIN = 'https://panel.test';
const PW = 'correct-horse-battery';
const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test', ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false' });
const db = createDb(cfg.DATABASE_URL);
let app: Awaited<ReturnType<typeof buildApp>>;
let mgr: ChannelManager;
let ctxA: AdapterContext;
const sent: string[] = [];
class Fake implements ChannelAdapter {
  constructor(c: AdapterContext) { ctxA = c; }
  async start() { ctxA.events.onStatus('connected'); }
  async stop() {}
  async logout() {}
  async sendText(_t: string, text: string) { sent.push(text); return { externalMessageId: `s${sent.length}` }; }
}
let cookie = '';
let ip = 0;
let mid = 0;
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => app.inject({ method, url, payload, remoteAddress: `10.76.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, cookie } });
const say = async (who: string, text: string) => { sent.length = 0; await ctxA.events.onMessage({ externalContactId: who, externalMessageId: `cc${++mid}`, text, timestamp: new Date() }); return [...sent]; };
const convOf = async (who: string) => (await db.query(`SELECT c.id, c.status, c.close_kind, c.bot_state FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.external_id = $1`, [who])).rows[0];

beforeAll(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  const factory: AdapterFactory = (_t, c) => new Fake(c);
  mgr = new ChannelManager(db, cfg, factory);
  app = await buildApp(cfg, db, mgr);
  await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4)', ['a@t.io', 'a', 'admin', await hashPassword(PW)]);
  cookie = `botwa_sid=${(await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'a@t.io', password: PW }, remoteAddress: '10.76.9.9', headers: { origin: ORIGIN } })).cookies[0]!.value}`;
  const ch = (await call('POST', '/channels', { type: 'whatsapp', label: 'WA' })).json().id;
  await call('POST', `/channels/${ch}/start`);
  await new Promise((r) => setTimeout(r, 40));
});
afterAll(async () => { await mgr.stopAll(); await app.close(); await db.end(); });

describe('the customer closes the inquiry', () => {
  it('is on by default: "הסתדרתי" closes it as closed by the customer, with a confirmation and no bot reply', async () => {
    await call('PUT', '/settings/bot', { ...DEFAULT_BOT, enabled: true });
    await say('972500000101', 'שלום, יש לי שאלה');
    expect((await convOf('972500000101')).status).toBe('open');
    const out = await say('972500000101', 'הסתדרתי, תודה רבה!');
    expect(out).toEqual([DEFAULT_AUTOMATIONS.customerClose.text]);            // only the confirmation: no menu or bot answer
    const c = await convOf('972500000101');
    expect(c).toMatchObject({ status: 'closed', close_kind: 'customer', bot_state: null });
    const kase = (await db.query('SELECT close_kind, closed_at FROM cases WHERE conversation_id = $1', [c.id])).rows[0];
    expect(kase.close_kind).toBe('customer');
    expect(kase.closed_at).not.toBeNull();
    const notes = (await db.query('SELECT body FROM conversation_notes WHERE conversation_id = $1', [c.id])).rows.map((r) => r.body).join(' ');
    expect(notes).toContain('לבקשת הלקוח');
    const hist = (await call('GET', `/conversations/${c.id}/cases`)).json();
    expect(hist[0].closeKind).toBe('customer');
    // a new message opens a new inquiry
    await say('972500000101', 'עוד שאלה בבקשה');
    expect((await convOf('972500000101')).status).toBe('open');
  });

  it('asks for a rating when feedback is on; "not solved" messages do not close; switched off it is an ordinary message', async () => {
    const base = (await call('GET', '/settings/automations')).json();
    expect((await call('PUT', '/settings/automations', { ...base, feedback: { ...base.feedback, enabled: true, question: 'דרגו 1-5' } })).statusCode).toBe(200);
    await say('972500000102', 'שאלה');
    expect(await say('972500000102', 'תסגרו את הקריאה')).toEqual([DEFAULT_AUTOMATIONS.customerClose.text, 'דרגו 1-5']);
    expect((await convOf('972500000102')).status).toBe('closed');

    await say('972500000103', 'שאלה');
    await say('972500000103', 'עדיין לא הסתדרתי');
    expect((await convOf('972500000103')).status).toBe('open');

    expect((await call('PUT', '/settings/automations', { ...base, customerClose: { enabled: false, text: '' } })).statusCode).toBe(200);
    await say('972500000104', 'שאלה');
    await say('972500000104', 'הסתדרתי');
    expect((await convOf('972500000104')).status).toBe('open');
    await call('PUT', '/settings/automations', base);
  });

  it('reports count inquiries closed by the customer', async () => {
    const r = (await call('GET', '/reports/summary?days=7')).json();
    expect(r.cases.closedByCustomer).toBeGreaterThanOrEqual(2);
  });
});

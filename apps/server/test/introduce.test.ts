import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ChannelManager } from '../src/channels/manager.js';
import type { AdapterContext, AdapterFactory, ChannelAdapter } from '../src/channels/types.js';
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
let ctxA: AdapterContext;
const sent: string[] = [];
class Fake implements ChannelAdapter {
  constructor(c: AdapterContext) { ctxA = c; }
  async start() { ctxA.events.onStatus('connected'); }
  async stop() {}
  async logout() {}
  async sendText(_t: string, text: string) { sent.push(text); return { externalMessageId: `s${sent.length}-${Math.random()}` }; }
}
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
let ip = 0;
let mid = 0;
const call = (who: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: object) => app.inject({ method, url, payload, remoteAddress: `10.77.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, cookie: cookies[who]! } });
const say = async (who: string, text: string) => { await ctxA.events.onMessage({ externalContactId: who, contactName: 'יוסי', externalMessageId: `in${++mid}`, text, timestamp: new Date() }); };
const convOf = async (who: string) => (await db.query(`SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.external_id = $1`, [who])).rows[0].id as string;
const intros = async (conv: string) => (await db.query(`SELECT body FROM messages WHERE conversation_id = $1 AND automation = 'introduce' ORDER BY created_at`, [conv])).rows.map((r) => r.body as string);

beforeAll(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  const factory: AdapterFactory = (_t, c) => new Fake(c);
  mgr = new ChannelManager(db, cfg, factory);
  app = await buildApp(cfg, db, mgr);
  for (const [e, name, role] of [['admin@t.io', 'מנהלת', 'admin'], ['dana@t.io', 'דנה כהן', 'agent'], ['avi@t.io', 'Avi Levi', 'agent']] as const) {
    ids[e] = (await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4) RETURNING id', [e, name, role, await hashPassword(PW)])).rows[0].id;
    cookies[e] = `botwa_sid=${(await app.inject({ method: 'POST', url: '/auth/login', payload: { email: e, password: PW }, remoteAddress: `10.77.9.${++ip}`, headers: { origin: ORIGIN } })).cookies[0]!.value}`;
  }
  const ch = (await call('admin@t.io', 'POST', '/channels', { type: 'whatsapp', label: 'WA' })).json().id;
  await call('admin@t.io', 'POST', `/channels/${ch}/start`);
  await new Promise((r) => setTimeout(r, 40));
});
afterAll(async () => { await mgr.stopAll(); await app.close(); await db.end(); });

describe('the handler introduces themselves to the customer', () => {
  it('each person sets their own role (validated); the admin can set it too', async () => {
    expect((await call('dana@t.io', 'PUT', '/auth/me/intro', { jobTitle: 'ממונת בטיחות, הפקולטה לכימיה', introPhone: '04-829 1234' })).statusCode).toBe(200);
    expect((await call('dana@t.io', 'GET', '/auth/me')).json()).toMatchObject({ jobTitle: 'ממונת בטיחות, הפקולטה לכימיה', introPhone: '04-829 1234' });
    expect((await call('dana@t.io', 'PUT', '/auth/me/intro', { jobTitle: 'x', introPhone: 'call me' })).statusCode).toBe(400);
    expect((await call('dana@t.io', 'PUT', '/auth/me/intro', { jobTitle: 'x'.repeat(81), introPhone: null })).statusCode).toBe(400);
    expect((await call('admin@t.io', 'PATCH', `/users/${ids['avi@t.io']}`, { jobTitle: 'נציג שירות' })).json().jobTitle).toBe('נציג שירות');
    // a Hebrew display name for an account whose name is in English: set by the person or by an admin, must contain Hebrew
    expect((await call('avi@t.io', 'PUT', '/auth/me/intro', { nameHe: 'Avi', jobTitle: 'נציג שירות', introPhone: null })).statusCode).toBe(400);
    expect((await call('avi@t.io', 'PUT', '/auth/me/intro', { nameHe: 'אבי לוי', jobTitle: 'נציג שירות', introPhone: null })).json().nameHe).toBe('אבי לוי');
    expect((await call('avi@t.io', 'PUT', '/auth/me/intro', { jobTitle: 'נציג שירות', introPhone: null })).json().nameHe).toBe('אבי לוי');   // omitted: kept
    expect((await call('admin@t.io', 'PATCH', `/users/${ids['avi@t.io']}`, { nameHe: 'abc' })).statusCode).toBe(400);
    expect((await call('admin@t.io', 'PATCH', `/users/${ids['avi@t.io']}`, { nameHe: 'אבי לוי' })).json().nameHe).toBe('אבי לוי');
    expect((await call('avi@t.io', 'PATCH', `/users/${ids['avi@t.io']}`, { jobTitle: 'מנכ״ל' })).statusCode).toBe(403);
  });

  it('on assignment: "שלום יוסי, כאן דנה כהן, <role>…" once; again only after a hand-over or in a new inquiry', async () => {
    await say('972500000201', 'שלום, יש לי שאלה על נוהל');
    const conv = await convOf('972500000201');
    expect((await call('admin@t.io', 'POST', `/conversations/${conv}/assign`, { userId: ids['dana@t.io'] })).json()).toMatchObject({ ok: true, introduced: true });
    expect(await intros(conv)).toEqual(['שלום יוסי, כאן דנה כהן, ממונת בטיחות, הפקולטה לכימיה. אני אטפל בפנייתך מעכשיו ואחזור אליך בהקדם.']);
    // the same person again: not repeated
    await call('admin@t.io', 'POST', `/conversations/${conv}/assign`, { userId: null });
    await call('admin@t.io', 'POST', `/conversations/${conv}/assign`, { userId: ids['dana@t.io'] });
    expect(await intros(conv)).toHaveLength(1);
    // hand-over to a colleague: they introduce themselves
    expect((await call('dana@t.io', 'POST', `/conversations/${conv}/assign`, { userId: ids['avi@t.io'], note: 'לטיפולך, שאלה על עבודה בגובה' })).statusCode).toBe(200);
    expect((await intros(conv))[1]).toBe('שלום יוסי, כאן אבי לוי, נציג שירות. אני אטפל בפנייתך מעכשיו ואחזור אליך בהקדם.');   // the Hebrew name, not "Avi Levi"
    const row = ((await call('admin@t.io', 'GET', '/conversations?status=open')).json() as { id: string; assignedName: string }[]).find((c) => c.id === conv)!;
    expect(row.assignedName).toBe('אבי לוי');                                                   // the inbox shows the handler in Hebrew too
    const hist = (await call('admin@t.io', 'GET', `/conversations/${conv}/cases`)).json();
    expect(hist[0].assignedName).toBe('אבי לוי');
    // closed; the customer opens a new inquiry that stays with the same person: introduced again, once
    await call('admin@t.io', 'POST', `/conversations/${conv}/status`, { status: 'closed' });
    await say('972500000201', 'עוד שאלה');
    await say('972500000201', 'ועוד פרט');
    expect(await intros(conv)).toHaveLength(3);
  });

  it('a person without a role: the name only, with no stray comma; switched off: nothing', async () => {
    await say('972500000202', 'שאלה');
    const conv = await convOf('972500000202');
    await call('admin@t.io', 'POST', `/conversations/${conv}/assign`, { userId: ids['admin@t.io'] });
    expect(await intros(conv)).toEqual(['שלום יוסי, כאן מנהלת. אני אטפל בפנייתך מעכשיו ואחזור אליך בהקדם.']);
    const base = (await call('admin@t.io', 'GET', '/settings/automations')).json();
    expect((await call('admin@t.io', 'PUT', '/settings/automations', { ...base, introduce: { enabled: false, text: base.introduce.text } })).statusCode).toBe(200);
    await say('972500000203', 'שאלה');
    const c3 = await convOf('972500000203');
    expect((await call('admin@t.io', 'POST', `/conversations/${c3}/assign`, { userId: ids['dana@t.io'] })).json().introduced).toBe(false);
    expect(await intros(c3)).toEqual([]);
    await call('admin@t.io', 'PUT', '/settings/automations', base);
  });

  it('in an English conversation: the account name in Latin letters and no Hebrew-only role, never Hebrew inside the English sentence', async () => {
    await say('972500000214', 'Hello, I have a question about lab safety');
    const conv = await convOf('972500000214');
    await call('admin@t.io', 'POST', `/conversations/${conv}/assign`, { userId: ids['avi@t.io'] });
    expect(await intros(conv)).toEqual(["Hello יוסי, this is Avi Levi. I'll be handling your request from now on and will get back to you soon."]);
    // a person with a Hebrew name only: the name as it is (better than none), still without the Hebrew role
    await say('972500000215', 'Hi, a question about chemicals please');
    const c2 = await convOf('972500000215');
    await call('admin@t.io', 'POST', `/conversations/${c2}/assign`, { userId: ids['dana@t.io'] });
    const [intro] = await intros(c2);
    expect(intro).toContain('this is דנה כהן.');
    expect(intro).not.toContain('ממונת');
  });

  it('the role in English when the person wrote one; the conversation language set by hand stays until "automatic"', async () => {
    expect((await call('avi@t.io', 'PUT', '/auth/me/intro', { jobTitle: 'נציג שירות', jobTitleEn: 'Service agent', jobTitleAr: 'موظف خدمة', introPhone: null })).json()).toMatchObject({ jobTitleEn: 'Service agent', jobTitleAr: 'موظف خدمة' });
    expect((await call('avi@t.io', 'GET', '/auth/me')).json()).toMatchObject({ jobTitleEn: 'Service agent', jobTitleAr: 'موظف خدمة' });
    expect((await call('avi@t.io', 'PUT', '/auth/me/intro', { jobTitle: 'נציג שירות', introPhone: null })).json()).toMatchObject({ jobTitleEn: 'Service agent' });   // omitted: kept
    await say('972500000216', 'Hello, a question about gas cylinders');
    const conv = await convOf('972500000216');
    await call('admin@t.io', 'POST', `/conversations/${conv}/assign`, { userId: ids['avi@t.io'] });
    expect(await intros(conv)).toEqual(["Hello יוסי, this is Avi Levi, Service agent. I'll be handling your request from now on and will get back to you soon."]);
    // the language by hand: Arabic, kept while the customer writes Hebrew; back to automatic: the text decides again
    expect((await call('admin@t.io', 'POST', `/conversations/${conv}/lang`, { lang: 'fr' })).statusCode).toBe(400);
    expect((await call('admin@t.io', 'POST', `/conversations/${conv}/lang`, { lang: 'ar' })).json()).toEqual({ ok: true, lang: 'ar' });
    await say('972500000216', 'שלום, אני כותב בעברית');
    expect((await call('admin@t.io', 'GET', `/conversations/${conv}/profile`)).json()).toMatchObject({ lang: 'ar', langLocked: true });
    expect((await db.query(`SELECT t.name FROM conversation_tags x JOIN tags t ON t.id = x.tag_id WHERE x.conversation_id = $1`, [conv])).rows.map((r) => r.name)).toContain('العربية');
    await call('admin@t.io', 'POST', `/conversations/${conv}/lang`, { lang: 'auto' });
    await say('972500000216', 'עוד שאלה בעברית');
    expect((await call('admin@t.io', 'GET', `/conversations/${conv}/profile`)).json()).toMatchObject({ lang: 'he', langLocked: false });
    expect((await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'conversation.lang' AND target = $1`, [conv])).rows[0].n).toBe(2);
  });

  it('never to a blocked customer', async () => {
    await say('972500000204', 'שאלה');
    const conv = await convOf('972500000204');
    await db.query(`UPDATE contacts SET blocked = true WHERE external_id = '972500000204'`);
    await call('admin@t.io', 'POST', `/conversations/${conv}/assign`, { userId: ids['dana@t.io'] });
    expect(await intros(conv)).toEqual([]);
  });
});

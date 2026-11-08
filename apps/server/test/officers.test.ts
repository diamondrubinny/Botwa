import { randomBytes } from 'node:crypto';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { DEFAULT_BOT } from '../src/bot.js';
import { ChannelManager } from '../src/channels/manager.js';
import type { AdapterContext, AdapterFactory, ChannelAdapter } from '../src/channels/types.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';
import { normalizePhone } from '../src/safety/officers.js';

describe('phone numbers', () => {
  it('become digits with the country code', () => {
    expect(normalizePhone('050-123 4567')).toBe('972501234567');
    expect(normalizePhone('+972 50 123 4567')).toBe('972501234567');
    expect(normalizePhone('00972501234567')).toBe('972501234567');
    expect(normalizePhone('12')).toBeNull();
    expect(normalizePhone('abc')).toBeNull();
  });
});

const ORIGIN = 'https://panel.test';
const PW = 'correct-horse-battery';
const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test', ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false', MEDIA_ALLOW_UNSCANNED: 'true' });
const db = createDb(cfg.DATABASE_URL);
let app: Awaited<ReturnType<typeof buildApp>>;
let mgr: ChannelManager;
let ctxA: AdapterContext;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
const sent: string[] = [];
let ip = 0;
class Fake implements ChannelAdapter {
  constructor(c: AdapterContext) { ctxA = c; }
  async start() { ctxA.events.onStatus('connected'); }
  async stop() {}
  async logout() {}
  async sendText(_t: string, text: string) { sent.push(text); return { externalMessageId: `s${sent.length}` }; }
}
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, who?: string, payload?: object | Buffer, headers: Record<string, string> = {}) =>
  app.inject({ method, url, payload: payload as never, remoteAddress: `10.75.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, ...(who ? { cookie: cookies[who]! } : {}), ...headers } });
let mid = 0;
const say = async (who: string, text: string) => { sent.length = 0; await ctxA.events.onMessage({ externalContactId: who, externalMessageId: `of${++mid}`, text, timestamp: new Date() }); return [...sent]; };
const conv = async (who: string) => (await db.query(`SELECT c.id, c.assigned_to FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.external_id = $1`, [who])).rows[0];
const notes = async (cid: string) => (await db.query('SELECT body FROM conversation_notes WHERE conversation_id = $1 ORDER BY id', [cid])).rows.map((r) => r.body as string);

beforeAll(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  mgr = new ChannelManager(db, cfg, ((ty, c) => (ty === 'whatsapp' ? new Fake(c) : null)) as AdapterFactory);
  app = await buildApp(cfg, db, mgr);
  for (const [e, r] of [['admin', 'admin'], ['sup', 'supervisor'], ['laser', 'agent'], ['chem', 'agent'], ['b12', 'agent']] as const) {
    ids[e] = (await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4) RETURNING id', [`${e}@t.io`, e, r, await hashPassword(PW)])).rows[0].id;
    cookies[e] = `botwa_sid=${(await call('POST', '/auth/login', undefined, { email: `${e}@t.io`, password: PW })).cookies[0]!.value}`;
  }
  const ch = (await call('POST', '/channels', 'admin', { type: 'whatsapp', label: 'WA' })).json().id;
  await call('POST', `/channels/${ch}/start`, 'admin');
  await new Promise((r) => setTimeout(r, 40));
});
afterAll(async () => { await mgr.stopAll(); await app.close(); await db.end(); });

describe('officers by topic', () => {
  it('only bot managers change the list; email, phone and account are checked', async () => {
    const body = { name: 'דנה כהן', email: 'Dana@Example.org', phone: '050-123-4567', userId: ids.laser, topics: ['לייזרים', ' לייזרים ', 'קרינה'], notes: '' };
    expect((await call('POST', '/safety/officers', 'sup', body)).statusCode).toBe(403);
    expect((await call('POST', '/safety/officers', 'admin', { ...body, email: 'not-an-email' })).statusCode).toBe(400);
    expect((await call('POST', '/safety/officers', 'admin', { ...body, phone: '12' })).json()).toEqual({ error: 'bad_phone' });
    expect((await call('POST', '/safety/officers', 'admin', { ...body, userId: '00000000-0000-4000-8000-000000000000' })).json()).toEqual({ error: 'unknown_user' });
    const ok = await call('POST', '/safety/officers', 'admin', body);
    expect(ok.statusCode).toBe(201);
    const list = (await call('GET', '/safety/officers', 'sup')).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'דנה כהן', email: 'dana@example.org', phone: '972501234567', userId: ids.laser, userName: 'laser', userActive: true, topics: ['לייזרים', 'קרינה'] });
    const id = ok.json().id as string;
    expect((await call('PUT', `/safety/officers/${id}`, 'admin', { ...body, topics: ['לייזרים'], notes: 'בבוקר בלבד' })).statusCode).toBe(200);
    expect((await call('GET', '/safety/officers', 'sup')).json()[0]).toMatchObject({ topics: ['לייזרים'], notes: 'בבוקר בלבד' });
    expect((await call('PUT', '/safety/officers/00000000-0000-4000-8000-000000000000', 'admin', body)).statusCode).toBe(404);
    // an officer with no account, for chemicals
    expect((await call('POST', '/safety/officers', 'admin', { name: 'רוברט', email: 'robert@example.org', phone: '', userId: null, topics: ['חומ״ס'] })).statusCode).toBe(201);
    const topics = (await call('GET', '/safety/officer-topics', 'sup')).json() as string[];
    expect(topics).toEqual(expect.arrayContaining(['לייזרים', 'חומ״ס', 'קרינה מייננת']));
  });

  it('imports officers from a workbook, matching by e-mail, and reports what it skipped', async () => {
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('x');
    ws.addRow(['שם', 'אימייל', 'ווצאפ', 'נושאים', 'אימייל החשבון במערכת', 'הערות']);
    ws.addRow(['רוברט כהן', 'robert@example.org', '052-000-1111', 'חומ״ס\nכימיקלים המחייבים ניטור', 'chem@t.io', '']);   // existing e-mail: updated, gets an account
    ws.addRow(['יעל לוי', 'yael@example.org', '0541112222', 'אסבסט, חלל מוקף', 'nobody@t.io', '']);                       // new, account e-mail unknown
    ws.addRow(['', 'x@y.org', '', 'חשמל', '', '']);
    ws.addRow(['דן', 'bad', '', 'חשמל', '', '']);
    ws.addRow(['גל', '', '123', 'חשמל', '', '']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const b = '----o';
    const body = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="o.xlsx"\r\nContent-Type: application/octet-stream\r\n\r\n`), buf, Buffer.from(`\r\n--${b}--\r\n`)]);
    const r = await call('POST', '/safety/officers/import', 'admin', body, { 'content-type': `multipart/form-data; boundary=${b}` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ created: 1, updated: 1, unlinked: 1, skipped: [{ row: 4, reason: 'missing_name' }, { row: 5, reason: 'bad_email' }, { row: 6, reason: 'bad_phone' }] });
    const list = (await call('GET', '/safety/officers', 'sup')).json() as { name: string; userId: string | null; phone: string; topics: string[] }[];
    expect(list.find((o) => o.name === 'רוברט כהן')).toMatchObject({ userId: ids.chem, phone: '972520001111', topics: ['חומ״ס', 'כימיקלים המחייבים ניטור'] });
    expect(list.find((o) => o.name === 'יעל לוי')).toMatchObject({ userId: null, topics: ['אסבסט', 'חלל מוקף'] });
    expect((await call('GET', '/safety/officers/template.xlsx', 'sup')).statusCode).toBe(200);
  });

  it('flow: hand over to the officer of the topic; the place wins; no account means a note, the node\'s own person and the contact shown', async () => {
    await call('POST', '/safety/areas', 'admin', { name: 'בניין 12', keywords: ['בניין 12'], userId: ids.b12 });
    const flow = {
      start: 'ask',
      nodes: [
        { id: 'ask', type: 'question', text: 'באיזה נושא ואיפה?', save: 'where', retryText: 'נא לכתוב.', next: 'laser' },
        { id: 'laser', type: 'handoff', text: 'מעבירים לממונה הלייזרים.', areaVars: ['where'], officerTopic: 'לייזרים', showContact: true },
      ],
    };
    const noAcct = { start: 'ask', nodes: [{ id: 'ask', type: 'question', text: 'נושא?', save: 'where', retryText: 'נא לכתוב.', next: 'asb' }, { id: 'asb', type: 'handoff', text: 'מעבירים.', officerTopic: 'אסבסט', showContact: true, userId: ids.sup }] };
    expect((await call('PUT', '/flow', 'admin', { flow })).statusCode).toBe(200);
    expect((await call('PUT', '/flow/mode', 'admin', { mode: 'flow' })).statusCode).toBe(200);
    expect((await call('PUT', '/settings/bot', 'admin', { ...DEFAULT_BOT, enabled: true, mode: 'flow' })).statusCode).toBe(200);

    // the topic's officer has an account: the conversation goes to it, and the customer is shown how to reach them
    await say('9725100001', 'שלום');
    const out = await say('9725100001', 'מעבדה 5');
    expect(out.join('\n')).toContain('מעבירים לממונה הלייזרים.');
    expect(out.join('\n')).toContain('הממונה על הנושא: דנה כהן');
    expect(out.join('\n')).toContain('https://wa.me/972501234567');
    expect(out.join('\n')).toContain('dana@example.org');
    expect((await conv('9725100001')).assigned_to).toBe(ids.laser);
    expect((await notes((await conv('9725100001')).id)).join('\n')).toContain('ממונה בתחום "לייזרים": דנה כהן');

    // a place named by the customer wins over the topic's officer
    await say('9725100002', 'שלום');
    await say('9725100002', 'בניין 12 קומה 2');
    expect((await conv('9725100002')).assigned_to).toBe(ids.b12);

    // an officer without an account: the node's own person gets it, the note tells whom to contact
    expect((await call('PUT', '/flow', 'admin', { flow: noAcct })).statusCode).toBe(200);
    await say('9725100003', 'שלום');
    const out3 = await say('9725100003', 'חשד לאסבסט');
    expect((await conv('9725100003')).assigned_to).toBe(ids.sup);
    expect(out3.join('\n')).toContain('הממונה על הנושא: יעל לוי');
    expect((await notes((await conv('9725100003')).id)).join('\n')).toMatch(/אין לו חשבון פעיל במערכת/);

    // an inactive officer is not used; with no officer for the topic nothing breaks
    await db.query(`UPDATE officers SET active = false WHERE name = 'יעל לוי'`);
    await say('9725100004', 'שלום');
    const out4 = await say('9725100004', 'חשד לאסבסט');
    expect(out4.join('\n')).not.toContain('הממונה על הנושא');
    expect((await conv('9725100004')).assigned_to).toBe(ids.sup);
  });

  it('the editor gets officers and topics to choose from, and the safety template points its handoffs at topics', async () => {
    const refs = (await call('GET', '/flow/refs', 'sup')).json();
    expect(refs.officers.map((o: { name: string }) => o.name)).toEqual(expect.arrayContaining(['דנה כהן', 'רוברט כהן']));
    expect(refs.topics).toEqual(expect.arrayContaining(['לייזרים', 'חומ״ס', 'מפגע']));
    const tpl = (await call('POST', '/flow/templates/safety', 'admin')).json();
    const byId = new Map((tpl.flow.nodes as { id: string; officerTopic?: string }[]).map((n) => [n.id, n]));
    expect(byId.get('chem_ho')!.officerTopic).toBe('חומ״ס');
    expect(byId.get('las_ho')!.officerTopic).toBe('לייזרים');
  });

  it('deleting an officer removes their topics', async () => {
    const list = (await call('GET', '/safety/officers', 'sup')).json() as { id: string; name: string }[];
    const id = list.find((o) => o.name === 'דנה כהן')!.id;
    expect((await call('DELETE', `/safety/officers/${id}`, 'sup')).statusCode).toBe(403);
    expect((await call('DELETE', `/safety/officers/${id}`, 'admin')).statusCode).toBe(200);
    expect((await db.query('SELECT count(*)::int AS n FROM officer_topics WHERE officer_id = $1', [id])).rows[0].n).toBe(0);
  });
});

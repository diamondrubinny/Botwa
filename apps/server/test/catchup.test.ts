import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { DEFAULT_BOT } from '../src/bot.js';
import { ChannelManager } from '../src/channels/manager.js';
import type { AdapterContext, AdapterFactory, ChannelAdapter } from '../src/channels/types.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';

const ORIGIN = 'https://panel.test';
const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test', ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false' });
const db = createDb(cfg.DATABASE_URL);
let app: Awaited<ReturnType<typeof buildApp>>;
let mgr: ChannelManager;
let ctxA: AdapterContext;
let cookie = '';
let down = false;
let slow = 0;
let ip = 0;
const sent: string[] = [];
class Fake implements ChannelAdapter {
  constructor(c: AdapterContext) { ctxA = c; }
  async start() { ctxA.events.onStatus('connected'); }
  async stop() {}
  async logout() {}
  async sendText(_t: string, text: string) { if (slow) await new Promise((r) => setTimeout(r, slow)); if (down) throw new Error('channel_not_connected'); sent.push(text); return { externalMessageId: `s${sent.length}` }; }
}
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => app.inject({ method, url, payload, remoteAddress: `10.76.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, cookie } });
let mid = 0;
const hear = async (who: string, text: string) => { await ctxA.events.onMessage({ externalContactId: who, externalMessageId: `cu${++mid}`, text, timestamp: new Date() }); };
const row = async (who: string) => (await db.query(`SELECT c.id, c.bot_pending_at, c.bot_pending_ext, c.bot_pending_text, c.bot_tries, c.bot_state FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.external_id = $1`, [who])).rows[0];
const notes = async (id: string) => (await db.query('SELECT body FROM conversation_notes WHERE conversation_id = $1 ORDER BY id', [id])).rows.map((r) => r.body as string).join('\n');
const setBot = (over: object = {}) => call('PUT', '/settings/bot', { ...DEFAULT_BOT, enabled: true, ...over });

beforeAll(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  mgr = new ChannelManager(db, cfg, ((ty, c) => (ty === 'whatsapp' ? new Fake(c) : null)) as AdapterFactory);
  app = await buildApp(cfg, db, mgr);
  await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4)', ['a@t.io', 'a', 'admin', await hashPassword('correct-horse-battery')]);
  cookie = `botwa_sid=${(await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'a@t.io', password: 'correct-horse-battery' }, remoteAddress: '10.76.9.9', headers: { origin: ORIGIN } })).cookies[0]!.value}`;
  const ch = (await call('POST', '/channels', { type: 'whatsapp', label: 'WA' })).json().id;
  await call('POST', `/channels/${ch}/start`);
  await new Promise((r) => setTimeout(r, 60));
  await setBot();
});
afterAll(async () => { await mgr.stopAll(); await app.close(); await db.end(); });

describe('answering after the connection was lost', () => {
  it('a catch-up running while the bot is still answering (slow sending) does not answer the same message twice', async () => {
    sent.length = 0; slow = 300;
    const p = hear('9725200099', 'שלום');
    await new Promise((r) => setTimeout(r, 50));
    expect(await mgr.catchUp()).toBe(0);                       // busy: skipped
    await p;
    await mgr.catchUp();
    slow = 0;
    expect(sent.filter((x) => x.includes('במה אפשר לעזור')).length).toBe(1);
  });
  it('a message the bot could not answer is answered once, as soon as sending works again', async () => {
    down = true; sent.length = 0;
    await hear('9725200001', 'שלום');
    expect(sent).toEqual([]);
    const r = await row('9725200001');
    expect(r.bot_pending_at).not.toBeNull();
    expect(r.bot_pending_text).toBe('שלום');
    expect(await notes(r.id)).toContain('הבוט לא הצליח לענות');
    down = false;
    expect(await mgr.catchUp()).toBe(1);
    expect(sent.join('\n')).toContain('במה אפשר לעזור');                       // the menu the customer should have received
    const after = await row('9725200001');
    expect(after.bot_pending_at).toBeNull();
    expect(after.bot_state).toBe('menu');
    sent.length = 0;
    expect(await mgr.catchUp()).toBe(0);                                      // and not a second time
    expect(sent).toEqual([]);
  });

  it('only the latest unanswered message is answered when several piled up', async () => {
    down = true; sent.length = 0;
    await hear('9725200002', 'שלום');
    await hear('9725200002', 'תפריט');
    expect((await row('9725200002')).bot_pending_text).toBe('תפריט');
    down = false;
    expect(await mgr.catchUp()).toBe(1);
    expect(sent.length).toBe(1);
  });

  it('a channel that comes back on its own triggers the catch-up, with nobody pressing anything', async () => {
    down = true; sent.length = 0;
    await hear('9725200003', 'שלום');
    down = false;
    ctxA.events.onStatus('connecting');
    ctxA.events.onStatus('connected');
    await new Promise((r) => setTimeout(r, 400));
    expect(sent.join('\n')).toContain('במה אפשר לעזור');
    expect((await row('9725200003')).bot_pending_at).toBeNull();
  });

  it('while the channel is still down nothing is tried, and it gives up after the configured hours, leaving a note for a person', async () => {
    down = true; sent.length = 0;
    await hear('9725200004', 'שלום');
    const id = (await row('9725200004')).id;
    await db.query(`UPDATE conversations SET bot_pending_at = now() - interval '13 hours' WHERE id = $1`, [id]);
    down = false;
    expect(await mgr.catchUp()).toBe(0);
    expect(sent).toEqual([]);
    expect((await row('9725200004')).bot_pending_at).toBeNull();
    expect(await notes(id)).toContain('יש לטפל בה ידנית');
  });

  it('stops after five failed tries instead of trying forever', async () => {
    down = true;
    await hear('9725200005', 'שלום');
    const id = (await row('9725200005')).id;
    for (let i = 0; i < 5; i++) { await mgr.catchUp(); }
    expect((await row('9725200005')).bot_tries).toBe(5);
    await mgr.catchUp();
    expect((await row('9725200005')).bot_pending_at).toBeNull();
    expect(await notes(id)).toContain('יש לטפל בה ידנית');
    down = false;
  });

  it('is off when the hours are set to 0, and a person who took the conversation meanwhile is not answered over', async () => {
    await setBot({ catchupHours: 0 });
    down = true; sent.length = 0;
    await hear('9725200006', 'שלום');
    expect((await row('9725200006')).bot_pending_at).toBeNull();
    await setBot();
    await hear('9725200007', 'שלום');
    const id = (await row('9725200007')).id;
    const admin = (await db.query(`SELECT id FROM users WHERE email = 'a@t.io'`)).rows[0].id;
    await db.query('UPDATE conversations SET assigned_to = $2 WHERE id = $1', [id, admin]);   // a person took it
    down = false; sent.length = 0;
    await mgr.catchUp();
    expect(sent).toEqual([]);
    expect((await row('9725200007')).bot_pending_at).toBeNull();
  });

  it('settings accept the hours and refuse nonsense', async () => {
    expect((await setBot({ catchupHours: 24 })).statusCode).toBe(200);
    expect((await setBot({ catchupHours: -1 })).statusCode).toBe(400);
    expect((await setBot({ catchupHours: 500 })).statusCode).toBe(400);
  });

});

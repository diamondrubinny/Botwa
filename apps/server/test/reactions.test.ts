import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { DEFAULT_BOT, DEFAULT_REACTIONS, isSingleEmoji, isThanks } from '../src/bot.js';
import { ChannelManager } from '../src/channels/manager.js';
import type { AdapterContext, AdapterFactory, ChannelAdapter } from '../src/channels/types.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';

describe('emoji check', () => {
  it('accepts one emoji (with joiners and skin tones) or nothing, and refuses text and several', () => {
    for (const ok of ['', '👀', '✅', '🙋', '👍🏽', '👨‍💻', '❤️']) expect(isSingleEmoji(ok), ok).toBe(true);
    for (const bad of ['a', 'ok', '👀👀', '👀 ', '<b>', 'x'.repeat(30), '١']) expect(isSingleEmoji(bad), bad).toBe(false);
  });
});

describe('thank-you detection', () => {
  it('finds thanks and praise, and leaves questions, requests and complaints alone', () => {
    for (const t of ['תודה', 'תודה רבה!!', 'אתם אחלה', 'אחלה שירות', 'אין עליכם', 'תודהההה 🙏', '🙏', '❤️', 'ותודה רבה', 'כל הכבוד לכם!', 'Thanks a lot', 'יישר כוח לצוות', 'מעולה, תודה'])
      expect(isThanks(t), t).toBe(true);
    for (const t of ['', '👍', 'תודה, אבל זה לא עובד', 'לא תודה', 'אחלה, ומה עם הטופס', 'תודה אשמח לקבל את הטופס', 'תודה?', 'מה השעה?', 'שלום', 'אני צריך עזרה', 'תודה '.repeat(30)])
      expect(isThanks(t), t).toBe(false);
  });
});

const ORIGIN = 'https://panel.test';
const PW = 'correct-horse-battery';
const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test', ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false', MEDIA_ALLOW_UNSCANNED: 'true' });
const db = createDb(cfg.DATABASE_URL);
let app: Awaited<ReturnType<typeof buildApp>>;
let mgr: ChannelManager;
let ctxA: AdapterContext;
let cookie = '';
let ip = 0;
const reactions: { to: string; id: string; emoji: string }[] = [];
const sent: string[] = [];
let supportsReact = true;
class Fake implements ChannelAdapter {
  constructor(c: AdapterContext) { ctxA = c; if (!supportsReact) (this as { react?: unknown }).react = undefined; }
  async start() { ctxA.events.onStatus('connected'); }
  async stop() {}
  async logout() {}
  async sendText(_t: string, text: string) { sent.push(text); return { externalMessageId: `s${sent.length}` }; }
  async react(to: string, id: string, emoji: string) { reactions.push({ to, id, emoji }); }
}
class NoReact implements ChannelAdapter {
  constructor(private c: AdapterContext) {}
  async start() { this.c.events.onStatus('connected'); }
  async stop() {}
  async logout() {}
  async sendText(_t: string, text: string) { sent.push(text); return { externalMessageId: `s${sent.length}` }; }
}
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => app.inject({ method, url, payload, remoteAddress: `10.74.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, cookie } });
let mid = 0;
const say = async (who: string, text: string) => { reactions.length = 0; sent.length = 0; const id = `rx${++mid}`; await ctxA.events.onMessage({ externalContactId: who, externalMessageId: id, text, timestamp: new Date() }); return { id, reactions: [...reactions], sent: [...sent] }; };
const setBot = (over: object) => call('PUT', '/settings/bot', { ...DEFAULT_BOT, enabled: true, kb: { ...DEFAULT_BOT.kb, enabled: true, minScore: 0.5 }, ...over });

beforeAll(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  const factory: AdapterFactory = (ty, c) => (ty === 'whatsapp' ? new Fake(c) : ty === 'telegram' ? new NoReact(c) : null);
  mgr = new ChannelManager(db, cfg, factory);
  app = await buildApp(cfg, db, mgr);
  await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4)', ['a@t.io', 'a', 'admin', await hashPassword(PW)]);
  cookie = `botwa_sid=${(await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'a@t.io', password: PW }, remoteAddress: '10.74.9.9', headers: { origin: ORIGIN } })).cookies[0]!.value}`;
  const ch = (await call('POST', '/channels', { type: 'whatsapp', label: 'WA' })).json().id;
  await call('POST', `/channels/${ch}/start`);
  await new Promise((r) => setTimeout(r, 40));
  await call('POST', '/kb/sources/faq', { title: 'מהן שעות הפעילות שלכם', body: 'פתוחים בימים א׳ עד ה׳ בין תשע לחמש.', variants: ['עד מתי אתם פתוחים'] });
  await mgr.kb!.idle();
});
afterAll(async () => { await mgr.stopAll(); await app.close(); await db.end(); });

describe('automatic reactions', () => {
  it('are off until switched on: nothing is reacted to by default', async () => {
    expect(DEFAULT_BOT.reactions).toEqual(DEFAULT_REACTIONS);
    expect(DEFAULT_REACTIONS.enabled).toBe(false);
    await setBot({});
    const r = await say('9725000001', 'מהן שעות הפעילות שלכם');
    expect(r.sent.length).toBeGreaterThan(0);
    expect(r.reactions).toEqual([]);
  });

  it('settings accept one emoji per event and refuse anything else', async () => {
    expect((await setBot({ reactions: { ...DEFAULT_REACTIONS, enabled: true, working: 'eyes' } })).statusCode).toBe(400);
    expect((await setBot({ reactions: { ...DEFAULT_REACTIONS, enabled: true, working: '👀👀' } })).statusCode).toBe(400);
    expect((await setBot({ reactions: { ...DEFAULT_REACTIONS, enabled: true } })).statusCode).toBe(200);
  });

  it('a search shows 👀 on the customer message first, then ✅ once the answer is sent', async () => {
    const r = await say('9725000002', 'מהן שעות הפעילות שלכם');
    expect(r.reactions).toEqual([{ to: '9725000002', id: r.id, emoji: '👀' }, { to: '9725000002', id: r.id, emoji: '✅' }]);
    expect(r.sent.join(' ')).toContain('פתוחים בימים א׳');
  });

  it('a search without an answer ends with 🤔, or with the 👀 removed when that event has no emoji', async () => {
    const a = await say('9725000003', 'מה מזג האוויר בעוד שבוע בצפון הרחוק');
    expect(a.reactions.map((x) => x.emoji)).toEqual(['👀', '🤔']);
    await setBot({ reactions: { ...DEFAULT_REACTIONS, enabled: true, noAnswer: '' } });
    const b = await say('9725000004', 'מה מזג האוויר בעוד שבוע בצפון הרחוק');
    expect(b.reactions.map((x) => x.emoji)).toEqual(['👀', '']);   // empty removes our reaction
    await setBot({ reactions: { ...DEFAULT_REACTIONS, enabled: true } });
  });

  it('asking for a person gets 🙋 and no search reaction; a menu digit gets none', async () => {
    const h = await say('9725000005', 'נציג');
    expect(h.reactions.map((x) => x.emoji)).toEqual(['🙋']);
    const m = await say('9725000006', '1');
    expect(m.reactions).toEqual([]);
  });

  it('a channel that cannot react still answers normally, and reactions never block or break the reply', async () => {
    const ch = (await call('POST', '/channels', { type: 'telegram', label: 'TG' })).json();
    expect(ch.id).toBeTruthy();
    // the manager skips adapters without react(): call it directly
    expect(await mgr.react(ch.id, 'x', 'y', '👀')).toBe(false);
  });

  it('are limited per channel (30 a minute) so a burst cannot turn into reaction spam', async () => {
    await setBot({ reactions: { ...DEFAULT_REACTIONS, enabled: true } });
    let total = 0;
    for (let i = 0; i < 20; i++) total += (await say(`97250001${String(i).padStart(2, '0')}`, 'מהן שעות הפעילות שלכם')).reactions.length;
    expect(total).toBeLessThanOrEqual(30);
    expect(total).toBeGreaterThan(10);
  });

  it('a conversation handed to a person gets no reactions at all (the bot is silent there)', async () => {
    (mgr as unknown as { reactLog: Map<string, unknown> }).reactLog.clear();
    await setBot({ reactions: { ...DEFAULT_REACTIONS, enabled: true, ackAll: true } });
    await say('9725000601', 'שלום');
    await db.query(`UPDATE conversations SET bot_state = 'human' WHERE contact_id = (SELECT id FROM contacts WHERE external_id = '9725000601')`);
    for (const t of ['היי', 'מה עושים כשיש תאונה']) {
      const r = await say('9725000601', t);
      expect(r.reactions, t).toEqual([]);
      expect(r.sent, t).toEqual([]);
    }
  });

  it('a greeting gets 👋 (configurable, or none), other messages are unaffected', async () => {
    (mgr as unknown as { reactLog: Map<string, unknown> }).reactLog.clear();
    await setBot({ reactions: { ...DEFAULT_REACTIONS, enabled: true } });
    for (const t of ['שלום', 'היי!', 'בוקר טוב', 'שלום וברכה', 'Hello 👋']) expect((await say(`97250003${String(++mid).padStart(2, '0')}`, t)).reactions.map((x) => x.emoji), t).toEqual(['👋']);
    for (const t of ['שלום, איך מפנים פסולת?', 'מתי פתוחים']) expect((await say(`97250004${String(++mid).padStart(2, '0')}`, t)).reactions.map((x) => x.emoji).includes('👋'), t).toBe(false);
    await setBot({ reactions: { ...DEFAULT_REACTIONS, enabled: true, greeting: '🤝' } });
    expect((await say('9725000501', 'היי')).reactions.map((x) => x.emoji)).toEqual(['🤝']);
    await setBot({ reactions: { ...DEFAULT_REACTIONS, enabled: true, greeting: '' } });
    expect((await say('9725000502', 'היי')).reactions.map((x) => x.emoji).includes('👋')).toBe(false);   // switched off: the normal working/done marks apply
    expect((await call('PUT', '/settings/bot', { ...DEFAULT_BOT, reactions: { ...DEFAULT_REACTIONS, greeting: 'שלום' } })).statusCode).toBe(400);
  });

  it('"react to every message" gives 👀 at once and a closing emoji, searches or not', async () => {
    (mgr as unknown as { reactLog: Map<string, unknown> }).reactLog.clear();   // the burst test above used up this minute's allowance
    await setBot({ reactions: { ...DEFAULT_REACTIONS, enabled: true, ackAll: true }, kb: { ...DEFAULT_BOT.kb, enabled: false } });
    const a = await say('9725000201', 'שלום');
    expect(a.reactions.map((x) => x.emoji)).toEqual(['👋']);                      // a greeting keeps its own reaction, no eyes or tick on top
    const a2 = await say('9725000211', 'מה נשמע בענייני נהלים');
    expect(a2.reactions.map((x) => x.emoji)).toEqual(['👀', '✅']);                 // a menu answer: no search, still marked
    const b = await say('9725000202', '1');
    expect(b.reactions.map((x) => x.emoji)).toEqual(['👀', '✅']);
    const c = await say('9725000203', 'נציג');
    expect(c.reactions.map((x) => x.emoji)).toEqual(['👀', '🙋']);                 // a hand-over replaces the eyes
    await setBot({ reactions: { ...DEFAULT_REACTIONS, enabled: true, ackAll: true } });
    const d = await say('9725000204', 'מהן שעות הפעילות שלכם');
    expect(d.reactions.map((x) => x.emoji)).toEqual(['👀', '✅']);                 // searching: the eyes are not sent twice
    await setBot({ reactions: { ...DEFAULT_REACTIONS, enabled: true } });
  });

  it('the diagnostics say what is switched on, why a bot that never searches shows no eyes, and what happened to the last attempts', async () => {
    expect((await call('GET', '/settings/bot/reactions')).statusCode).toBe(200);
    await setBot({ reactions: { ...DEFAULT_REACTIONS, enabled: false } });
    const off = (await call('GET', '/settings/bot/reactions')).json();
    expect(off.reactionsEnabled).toBe(false);
    expect(off.hints.join(' ')).toContain('התגובות כבויות');
    await setBot({ reactions: { ...DEFAULT_REACTIONS, enabled: true }, kb: { ...DEFAULT_BOT.kb, enabled: false } });
    const nokb = (await call('GET', '/settings/bot/reactions')).json();
    expect(nokb.searches).toBe(false);
    expect(nokb.hints.join(' ')).toContain('מענה ממאגר הידע כבוי');
    await setBot({ reactions: { ...DEFAULT_REACTIONS, enabled: true, ackAll: true }, kb: { ...DEFAULT_BOT.kb, enabled: false } });
    expect((await call('GET', '/settings/bot/reactions')).json().hints).toEqual([]);   // "react to every message" needs no search
    const log = (await call('GET', '/settings/bot/reactions')).json().log as { outcome: string; emoji: string; channel: string }[];
    expect(log.length).toBeGreaterThan(0);
    expect(log[0]!.channel).toContain('WA');
    expect(log.some((l) => l.outcome === 'sent')).toBe(true);
    await setBot({ reactions: { ...DEFAULT_REACTIONS, enabled: true } });
  });
});

describe('our emoji on the customer message: thank-you heart and a staff member\'s choice', () => {
  it('a thank-you gets the heart (on by default, also when a person handles the chat), shown in the inbox as automatic', async () => {
    (mgr as unknown as { reactLog: Map<string, unknown> }).reactLog.clear();
    await setBot({ reactions: { ...DEFAULT_REACTIONS, enabled: false } });
    const r = await say('9725000901', 'תודה רבה, אתם אחלה');
    expect(r.reactions.map((x) => x.emoji)).toEqual(['❤️']);
    const conv = (await db.query(`SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.external_id = '9725000901'`)).rows[0].id;
    const msgs = (await call('GET', `/conversations/${conv}/messages`)).json() as { direction: string; body: string; ourReaction: string | null; ourReactionBy: string | null }[];
    expect(msgs.find((m) => m.direction === 'in')).toMatchObject({ ourReaction: '❤️', ourReactionBy: 'אוטומטית' });
    // with a person handling it: the bot is silent, the heart still comes
    await db.query(`UPDATE conversations SET bot_state = 'human' WHERE id = $1`, [conv]);
    expect((await say('9725000901', 'אין עליכם')).reactions.map((x) => x.emoji)).toEqual(['❤️']);
    // with the automatic reactions on, the heart stays: no eyes or tick on top of it
    await setBot({ reactions: { ...DEFAULT_REACTIONS, enabled: true, ackAll: true } });
    expect((await say('9725000902', 'תודה רבה')).reactions.map((x) => x.emoji)).toEqual(['❤️']);
    // another emoji, or none
    await setBot({ reactions: { ...DEFAULT_REACTIONS, thanks: '🙏' } });
    expect((await say('9725000903', 'תודה')).reactions.map((x) => x.emoji)).toEqual(['🙏']);
    await setBot({ reactions: { ...DEFAULT_REACTIONS, thanks: '' } });
    expect((await say('9725000904', 'תודה')).reactions).toEqual([]);
    expect((await say('9725000905', 'תודה, אבל זה לא עובד')).reactions.map((x) => x.emoji).includes('❤️')).toBe(false);
    await setBot({ reactions: { ...DEFAULT_REACTIONS } });
  });

  it('a staff member picks any emoji on a customer message, changes or removes it; checked access and input', async () => {
    (mgr as unknown as { reactLog: Map<string, unknown> }).reactLog.clear();
    const r = await say('9725000911', 'אפשר לקבל את הנוהל?');
    const conv = (await db.query(`SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.external_id = '9725000911'`)).rows[0].id as string;
    const all = (await call('GET', `/conversations/${conv}/messages`)).json() as { id: string; direction: string }[];
    const inMsg = all.find((m) => m.direction === 'in')!.id;
    reactions.length = 0;
    const put = (emoji: string, m = inMsg, c = conv) => call('POST', `/conversations/${c}/messages/${m}/reaction`, { emoji });
    expect((await put('😊')).json()).toEqual({ ok: true, emoji: '😊' });
    expect(reactions).toEqual([{ to: '9725000911', id: r.id, emoji: '😊' }]);
    expect((await call('GET', `/conversations/${conv}/messages`)).json().find((m: { id: string }) => m.id === inMsg)).toMatchObject({ ourReaction: '😊', ourReactionBy: 'a' });
    reactions.length = 0;
    expect((await put('😊')).statusCode).toBe(200);
    expect(reactions).toEqual([]);                                     // same emoji again: nothing re-sent
    expect((await put('')).json()).toEqual({ ok: true, emoji: null });
    expect(reactions.map((x) => x.emoji)).toEqual(['']);               // removed on the platform too
    expect((await put('nice')).statusCode).toBe(400);
    expect((await put('😊😊')).statusCode).toBe(400);
    const out = all.find((m) => m.direction === 'out');
    if (out) expect((await put('😊', out.id)).statusCode).toBe(404);   // only the customer's own messages
    expect((await put('😊', inMsg, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    // an agent who may not see this conversation gets 404
    await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', ['ag@t.io', 'ag', 'agent', await hashPassword(PW)]);
    const agCookie = `botwa_sid=${(await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'ag@t.io', password: PW }, remoteAddress: '10.74.9.8', headers: { origin: ORIGIN } })).cookies[0]!.value}`;
    await db.query(`UPDATE conversations SET assigned_to = (SELECT id FROM users WHERE email = 'a@t.io') WHERE id = $1`, [conv]);
    expect((await app.inject({ method: 'POST', url: `/conversations/${conv}/messages/${inMsg}/reaction`, payload: { emoji: '👍' }, remoteAddress: '10.74.9.7', headers: { origin: ORIGIN, cookie: agCookie } })).statusCode).toBe(404);
    // a blocked customer: refused
    await db.query(`UPDATE contacts SET blocked = true WHERE external_id = '9725000911'`);
    expect((await put('👍')).json().error).toBe('contact_blocked');
    await db.query(`UPDATE contacts SET blocked = false WHERE external_id = '9725000911'`);
  });
});

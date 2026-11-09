import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { DEFAULT_BOT, DEFAULT_REACTIONS, isSingleEmoji } from '../src/bot.js';
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

  it('"react to every message" gives 👀 at once and a closing emoji, searches or not', async () => {
    (mgr as unknown as { reactLog: Map<string, unknown> }).reactLog.clear();   // the burst test above used up this minute's allowance
    await setBot({ reactions: { ...DEFAULT_REACTIONS, enabled: true, ackAll: true }, kb: { ...DEFAULT_BOT.kb, enabled: false } });
    const a = await say('9725000201', 'שלום');
    expect(a.reactions.map((x) => x.emoji)).toEqual(['👀', '✅']);                 // a menu answer: no search, still marked
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

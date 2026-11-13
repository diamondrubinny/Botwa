import { DEFAULT_AUTOMATIONS } from '../src/automations.js';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { botSchema, DEFAULT_BOT, decide, formatMenu, normalize, waLink, type BotConfig } from '../src/bot.js';
import { DEFAULT_HOURS } from '../src/business-hours.js';
import { ChannelManager } from '../src/channels/manager.js';
import type { AdapterContext, AdapterFactory, ChannelAdapter } from '../src/channels/types.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';

const bot: BotConfig = { ...DEFAULT_BOT, enabled: true, invalidRetries: 1 };

describe('decide (pure)', () => {
  it('normalises digits, keycaps, punctuation and direction marks', () => {
    expect(normalize(' ١. ')).toBe('1');
    expect(normalize('1️⃣')).toBe('1');
    expect(normalize('‏"תפריט"!')).toBe('תפריט');
  });
  it('first message gets the menu; menu lists items and the human option', () => {
    const d = decide(bot, { state: null, invalid: 0 }, 'שלום');
    expect(d.next).toEqual({ state: 'menu', invalid: 0 });
    expect(d.replies[0]).toContain('1. שעות פעילות');
    expect(d.replies[0]).toContain('0. נציג אנושי');
    expect(formatMenu({ ...bot, humanOption: false })).not.toContain('0.');
  });
  it('answers by number, by title and in other digit systems; keeps the footer', () => {
    const st = { state: 'menu' as const, invalid: 1 };
    expect(decide(bot, st, '1').replies[0]).toContain('9:00');
    expect(decide(bot, st, '١').replies[0]).toContain('9:00');
    expect(decide(bot, st, 'פרטי יצירת קשר').replies[0]).toContain('[להשלים]');
    expect(decide(bot, st, '1').replies[0]).toContain('"נציג"');
    expect(decide(bot, st, '1').next.invalid).toBe(0);
  });
  it('hands over on 0, on a keyword anywhere in the sentence, and for non-text', () => {
    const st = { state: 'menu' as const, invalid: 0 };
    expect(decide(bot, st, '0').handoff).toBe('requested');
    expect(decide(bot, st, 'אני רוצה נציג בבקשה').handoff).toBe('requested');
    expect(decide(bot, { state: null, invalid: 0 }, 'AGENT').handoff).toBe('requested');
    expect(decide(bot, st, null).handoff).toBe('media');
    expect(decide({ ...bot, humanOption: false }, st, '0').handoff).toBeUndefined(); // "0" is then just an invalid choice
  });
  it('unknown input: menu again, then hand over after the allowed retries', () => {
    const a = decide(bot, { state: 'menu', invalid: 0 }, '9');
    expect(a.handoff).toBeUndefined();
    expect(a.replies[0]).toContain(bot.invalidMessage);
    expect(a.next.invalid).toBe(1);
    expect(decide(bot, { state: 'menu', invalid: 1 }, 'blah').handoff).toBe('unrecognized');
    expect(decide({ ...bot, invalidRetries: 0 }, { state: 'menu', invalid: 0 }, 'blah').handoff).toBe('unrecognized');
  });
  it('is silent when disabled or once a person has the conversation; "menu" restarts', () => {
    expect(decide({ ...bot, enabled: false }, { state: null, invalid: 0 }, 'hi').replies).toEqual([]);
    expect(decide(bot, { state: 'human', invalid: 0 }, '1').replies).toEqual([]);
    expect(decide(bot, { state: 'menu', invalid: 1 }, 'תפריט').next.invalid).toBe(0);
  });
});

describe('referral to a personal WhatsApp (e.g. a safety officer)', () => {
  const withContact: BotConfig = { ...bot, items: [...bot.items, { title: 'בטיחות בגובה', answer: 'לשאלות בטיחות בעבודה בגובה פנו לממונה:', contact: { name: 'דני כהן, ממונה בטיחות', phone: '050-123 4567', message: 'שלום, אני פונה בנושא בטיחות בגובה' } }] };
  it('adds a click-to-chat link with a pre-filled message, converts Israeli local numbers, keeps the footer', () => {
    const d = decide(withContact, { state: 'menu', invalid: 0 }, '3');
    expect(d.replies[0]).toContain('דני כהן, ממונה בטיחות');
    expect(d.replies[0]).toContain('https://wa.me/972501234567?text=' + encodeURIComponent('שלום, אני פונה בנושא בטיחות בגובה'));
    expect(d.replies[0]).toContain('"נציג"'); // footer still present
    expect(d.next).toEqual({ state: 'menu', invalid: 0 }); // stays with the bot
    expect(waLink('+972-50-123-4567')).toBe('https://wa.me/972501234567');
    expect(waLink('00972501234567', 'x y')).toBe('https://wa.me/972501234567?text=x%20y');
    expect(decide(withContact, { state: 'menu', invalid: 0 }, '1').replies[0]).not.toContain('wa.me');
  });
  it('validates the contact in settings', () => {
    expect(botSchema.safeParse({ ...withContact, items: [{ title: 'x', answer: 'y', contact: { name: 'a', phone: 'abc' } }] }).success).toBe(false);
    expect(botSchema.safeParse(withContact).success).toBe(true);
    expect(botSchema.safeParse({ ...withContact, items: [{ title: 'x', answer: 'y', contact: { name: '', phone: '0501234567' } }] }).success).toBe(false);
  });
});

describe('menu bot end to end', () => {
  const ORIGIN = 'https://panel.test';
  const PW = 'correct-horse-battery';
  const cfg = loadConfig({
    NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test',
    ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false',
  });
  const db = createDb(cfg.DATABASE_URL);
  let app: Awaited<ReturnType<typeof buildApp>>;
  let mgr: ChannelManager;
  let ctx: AdapterContext;
  const sent: string[] = [];
  let outId = 0;
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let ip = 0;
  class Fake implements ChannelAdapter {
    constructor(c: AdapterContext) { ctx = c; }
    async start() { ctx.events.onStatus('connected'); }
    async stop() {}
    async logout() {}
    async sendText(_t: string, text: string) { sent.push(text); return { externalMessageId: `b${++outId}` }; }
  }
  const factory: AdapterFactory = (t, c) => (t === 'whatsapp' ? new Fake(c) : null);
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, who?: string, payload?: object) =>
    app.inject({ method, url, payload, remoteAddress: `10.40.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, ...(who ? { cookie: cookies[who]! } : {}) } });
  let mid = 0;
  const say = async (who: string, text: string, media = false) => {
    sent.length = 0;
    await ctx.events.onMessage({
      externalContactId: who, externalMessageId: `m${++mid}`, text, timestamp: new Date(),
      media: media ? { download: async () => Buffer.alloc(0) } : undefined,
    });
    return [...sent];
  };
  const conv = async (who: string) => (await db.query(`SELECT c.id, c.bot_state, c.assigned_to FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE ct.external_id=$1`, [who])).rows[0];
  const notes = async (id: string) => (await db.query('SELECT body FROM conversation_notes WHERE conversation_id=$1', [id])).rows.map((r) => r.body as string);

  beforeAll(async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    await db.query(`INSERT INTO settings (key, value) VALUES ('automations', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ ...DEFAULT_AUTOMATIONS, introduce: { ...DEFAULT_AUTOMATIONS.introduce, enabled: false } })]);   // these tests check the exact replies; the introduction has its own tests
    mgr = new ChannelManager(db, cfg, factory);
    app = await buildApp(cfg, db, mgr);
    for (const [e, r] of [['admin', 'admin'], ['sup', 'supervisor'], ['a1', 'agent'], ['a2', 'agent']] as const) {
      const u = await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4) RETURNING id', [`${e}@t.io`, e, r, await hashPassword(PW)]);
      ids[e] = u.rows[0].id;
      const res = await call('POST', '/auth/login', undefined, { email: `${e}@t.io`, password: PW });
      cookies[`${e}@t.io`] = `botwa_sid=${res.cookies[0]!.value}`;
    }
    const ch = (await call('POST', '/channels', 'admin@t.io', { type: 'whatsapp', label: 'WA' })).json().id;
    await call('POST', `/channels/${ch}/start`, 'admin@t.io');
    await new Promise((r) => setTimeout(r, 40));
  });
  afterAll(async () => { await mgr.stopAll(); await app.close(); await db.end(); });

  it('settings: validated, admin writes, supervisor reads, preview rendered by the server', async () => {
    expect((await call('GET', '/settings/bot', 'a1@t.io')).statusCode).toBe(403);
    expect((await call('PUT', '/settings/bot', 'sup@t.io', bot)).statusCode).toBe(403);
    expect((await call('PUT', '/settings/bot', 'admin@t.io', { ...bot, items: Array(10).fill({ title: 't', answer: 'a' }) })).statusCode).toBe(400);
    expect((await call('PUT', '/settings/bot', 'admin@t.io', { ...bot, invalidRetries: 9 })).statusCode).toBe(400);
    const ok = await call('PUT', '/settings/bot', 'admin@t.io', { ...bot, enabled: true });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().preview).toContain('0. נציג אנושי');
    expect((await call('GET', '/settings/bot', 'sup@t.io')).json().enabled).toBe(true);
  });

  it('new customer: menu, answers, then unknown input twice -> hand over with note, routing and notice', async () => {
    await call('PUT', '/settings/routing', 'admin@t.io', { mode: 'round_robin' });
    const first = await say('c1', 'היי');
    expect(first).toHaveLength(1);
    expect(first[0]).toContain('1. שעות פעילות');
    expect((await conv('c1')).bot_state).toBe('menu');
    expect((await conv('c1')).assigned_to).toBeNull(); // not assigned while the bot handles it

    expect((await say('c1', '1'))[0]).toContain('9:00');
    const retry = await say('c1', 'מה קורה?');
    expect(retry[0]).toContain('לא הבנתי');
    expect(retry[0]).toContain('1. שעות פעילות');

    const handoff = await say('c1', 'עדיין לא ברור');
    expect(handoff).toEqual([DEFAULT_BOT.humanMessage]);
    const c = await conv('c1');
    expect(c.bot_state).toBe('human');
    expect([ids.a1, ids.a2]).toContain(c.assigned_to);
    expect((await notes(c.id)).join()).toContain('לא זיהה');

    expect(await say('c1', '1')).toEqual([]); // bot is silent once a person has it
  });

  it('"נציג", "0" and files hand over immediately, even as the first message', async () => {
    expect(await say('c2', 'אפשר נציג?')).toEqual([DEFAULT_BOT.humanMessage]);
    expect((await conv('c2')).bot_state).toBe('human');
    await say('c3', 'שלום');
    expect(await say('c3', '0')).toEqual([DEFAULT_BOT.humanMessage]);
    await say('c4', 'שלום');
    expect(await say('c4', '', true)).toEqual([DEFAULT_BOT.humanMessage]);
    expect((await notes((await conv('c4')).id)).join()).toContain('קובץ');
  });

  it('agents do not see bot-handled conversations; they appear after hand-over; waiting time follows the human', async () => {
    await say('c5', 'שלום'); // bot is handling
    const id = (await conv('c5')).id;
    expect((await call('GET', '/conversations', 'a1@t.io')).json().some((c: { id: string }) => c.id === id)).toBe(false);
    const asManager = (await call('GET', '/conversations', 'sup@t.io')).json().find((c: { id: string }) => c.id === id);
    expect(asManager.botState).toBe('menu');
    expect(asManager.waitingSince).toBeNull(); // the bot is answering, nobody is "waiting for staff"
    await say('c5', 'נציג');
    const after = (await call('GET', '/conversations', 'sup@t.io')).json().find((c: { id: string }) => c.id === id);
    expect(after.botState).toBe('human');
    expect(after.waitingSince).not.toBeNull();
  });

  it('a staff reply or assignment stops the bot; closing the conversation restarts it', async () => {
    await say('c6', 'שלום');
    const id = (await conv('c6')).id;
    expect((await call('POST', `/conversations/${id}/messages`, 'sup@t.io', { text: 'אני כאן' })).statusCode).toBe(201);
    expect((await conv('c6')).bot_state).toBe('human');
    expect(await say('c6', '1')).toEqual([]);
    await call('POST', `/conversations/${id}/status`, 'sup@t.io', { status: 'closed' });
    expect((await conv('c6')).bot_state).toBeNull(); // closing resets the bot...
    expect(await say('c6', 'שלום שוב')).toEqual([]); // ...but a conversation that has an owner stays with that person

    // an unowned conversation closed by a manager starts over with the menu
    await say('c9', 'שלום');
    const id9 = (await conv('c9')).id;
    await call('POST', `/conversations/${id9}/status`, 'sup@t.io', { status: 'closed' });
    expect((await say('c9', 'שלום שוב'))[0]).toContain('1. שעות פעילות');
    expect((await conv('c9')).bot_state).toBe('menu');
  });

  it('outside business hours the hand-over sends the away notice instead', async () => {
    await call('PUT', '/settings/business-hours', 'admin@t.io', { ...DEFAULT_HOURS, enabled: true, days: Array(7).fill(null), awayMessage: 'סגורים כרגע' });
    await say('c7', 'שלום');
    expect(await say('c7', 'נציג')).toEqual(['סגורים כרגע']);
    await call('PUT', '/settings/business-hours', 'admin@t.io', { ...DEFAULT_HOURS, enabled: false });
  });

  it('loop guard: a customer-side bot cannot keep ours talking forever', async () => {
    const before = (await db.query(`SELECT count(*)::int AS n FROM messages WHERE auto`)).rows[0].n;
    for (let i = 0; i < 14; i++) await say('loop', i % 2 ? 'לא מבין' : 'שלום');
    const c = await conv('loop');
    expect(c.bot_state).toBe('human');
    const total = (await db.query(`SELECT count(*)::int AS n FROM messages m JOIN conversations v ON v.id=m.conversation_id JOIN contacts ct ON ct.id=v.contact_id WHERE ct.external_id='loop' AND m.auto`)).rows[0].n;
    expect(total).toBeLessThanOrEqual(12);
    expect(before).toBeGreaterThan(0);
  });

  it('loop guard: a person answering a run of questions quickly is not mistaken for a bot', async () => {
    for (const t of ['שלום', 'דנה לוי', 'דלג', 'דלג', 'הנדסה', 'פרופ׳ כהן', '2', '3', 'בניין 5']) await say('fast-human', t);
    const n = (await db.query(`SELECT count(*)::int AS n FROM conversation_notes cn JOIN conversations v ON v.id = cn.conversation_id JOIN contacts ct ON ct.id = v.contact_id WHERE ct.external_id = 'fast-human' AND cn.body LIKE 'הבוט נעצר%'`)).rows[0].n;
    expect(n).toBe(0);
  });

  it('bot disabled: previous behaviour (routing + away reply path) is untouched', async () => {
    await call('PUT', '/settings/bot', 'admin@t.io', { ...bot, enabled: false });
    expect(await say('c8', 'hello')).toEqual([]);
    expect((await conv('c8')).bot_state).toBeNull();
    expect([ids.a1, ids.a2]).toContain((await conv('c8')).assigned_to); // routed immediately as before
  });

  it('a menu item can hand the conversation to the person responsible (and/or send their WhatsApp link)', async () => {
    const items = [...bot.items, { title: 'בטיחות בגובה', answer: 'מעביר לממונה על התחום.', route: { userId: ids.a2 }, contact: { name: 'דני, ממונה בטיחות', phone: '0501234567', message: '' } }];
    expect((await call('PUT', '/settings/bot', 'admin@t.io', { ...bot, enabled: true, items: [...items.slice(0, 2), { ...items[2], route: { userId: '00000000-0000-4000-8000-000000000000' } }] })).statusCode).toBe(400); // unknown person
    expect((await call('PUT', '/settings/bot', 'admin@t.io', { ...bot, enabled: true, items })).statusCode).toBe(200);
    expect((await call('GET', '/settings/bot/assignees', 'sup@t.io')).json().map((u: { id: string }) => u.id)).toContain(ids.a2);
    expect((await call('GET', '/settings/bot/assignees', 'a1@t.io')).statusCode).toBe(403);

    await say('rt1', 'שלום');
    const r = await say('rt1', '3');
    expect(r[0]).toContain('מעביר לממונה');
    expect(r[0]).toContain('https://wa.me/972501234567'); // both: link and hand-over
    expect(r[1]).toBe(DEFAULT_BOT.humanMessage);
    const c = await conv('rt1');
    expect(c.assigned_to).toBe(ids.a2);
    expect(c.bot_state).toBe('human');
    expect((await notes(c.id)).join()).toContain('בטיחות בגובה');
    expect((await db.query(`SELECT 1 FROM audit_log WHERE action = 'conversation.topic_assign'`)).rowCount).toBe(1);

    // the responsible person is no longer active: normal routing takes over instead of leaving it unassigned
    await db.query('UPDATE users SET active = false WHERE id = $1', [ids.a2]);
    await say('rt2', 'שלום');
    await say('rt2', '3');
    expect((await conv('rt2')).assigned_to).not.toBe(ids.a2);
    await db.query('UPDATE users SET active = true WHERE id = $1', [ids.a2]);
    await call('PUT', '/settings/bot', 'admin@t.io', { ...bot, enabled: false });
  });
});

describe('topics routed by area (numbered menu)', () => {
  const U1 = '11111111-1111-4111-8111-111111111111';
  const bot: BotConfig = { ...DEFAULT_BOT, enabled: true, items: [{ title: 'מפגע', answer: 'תודה על הדיווח.', route: { userId: U1, byArea: true } }, { title: 'שעות', answer: 'א׳-ה׳' }] };
  it('asks for the place, then hands over with the place and the fallback officer', () => {
    const a = decide(bot, { state: 'menu', invalid: 0 }, '1');
    expect(a.next).toEqual({ state: 'area', invalid: 0, item: 0 });
    expect(a.replies[0]).toContain('באיזה בניין או מקום');
    expect(a.handoff).toBeUndefined();
    const b = decide(bot, { state: 'area', invalid: 0, item: 0 }, 'מעבדה 214 בניין 12');
    expect(b).toMatchObject({ handoff: 'topic', next: { state: 'human' }, topic: { title: 'מפגע', userId: U1, place: 'מעבדה 214 בניין 12' }, replies: [] });
    expect(decide(bot, { state: 'area', invalid: 0, item: 0 }, 'דלג').topic?.place).toBe('');
    expect(decide(bot, { state: 'area', invalid: 0, item: 0 }, null).topic).toMatchObject({ userId: U1, place: '' });   // a photo instead of a place
    expect(decide(bot, { state: 'area', invalid: 0, item: 0 }, '0').handoff).toBe('requested');                         // "talk to a person" still works
    expect(decide(bot, { state: 'area', invalid: 0, item: 0 }, 'תפריט').next.state).toBe('menu');
  });
  it('the schema accepts byArea', () => {
    expect(botSchema.safeParse({ ...DEFAULT_BOT, items: bot.items }).success).toBe(true);
  });
});

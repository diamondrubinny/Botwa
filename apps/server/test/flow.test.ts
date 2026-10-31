import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { DEFAULT_BOT } from '../src/bot.js';
import { ChannelManager } from '../src/channels/manager.js';
import type { AdapterContext, AdapterFactory, ChannelAdapter } from '../src/channels/types.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { runFlow, type FlowContext, type FlowState } from '../src/flow/engine.js';
import { flowFromMenu } from '../src/flow/fromMenu.js';
import { matchOptionLexical } from '../src/flow/match.js';
import { flowSchema, unreachable, validateFlow, type Flow } from '../src/flow/schema.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';

const TAG = '11111111-1111-4111-8111-111111111111';
const flow: Flow = flowSchema.parse({
  start: 'hours', nodes: [
    { id: 'hours', type: 'condition', check: { kind: 'hours' }, yes: 'menu', no: 'closed' },
    { id: 'closed', type: 'message', text: 'סגורים כרגע, נחזור אליכם.', next: 'name' },
    { id: 'menu', type: 'menu', text: 'במה נוכל לעזור?', options: [{ label: 'בטיחות בגובה', next: 'name', examples: ['פיגומים'] }, { label: 'שעות פעילות', next: 'info' }, { label: 'שאלה אחרת', next: 'kb' }] },
    { id: 'info', type: 'message', text: 'פתוחים 9-17.', next: 'menu' },
    { id: 'kb', type: 'kb', intro: 'מצאתי:', found: 'menu', notFound: 'name' },
    { id: 'name', type: 'question', text: 'מה שמך?', save: 'name', next: 'phone' },
    { id: 'phone', type: 'question', text: 'מספר טלפון?', save: 'phone', retryText: 'מספר לא תקין', next: 'tag' },
    { id: 'tag', type: 'tag', tagId: TAG, next: 'ref' },
    { id: 'ref', type: 'referral', text: 'הממונה:', contactName: 'דני', phone: '0501234567', message: 'היי', next: 'bye' },
    { id: 'bye', type: 'handoff', text: '', userId: undefined },
  ],
});
const ctx = (over: Partial<FlowContext> = {}): FlowContext => ({
  isOpen: true, channelType: 'whatsapp', humanKeywords: ['נציג'], humanOption: true, invalidRetries: 1, invalidMessage: 'לא הבנתי', now: 1_000_000,
  kbAnswer: async () => null, matchOption: async () => null, ...over,
});

describe('flow validation', () => {
  it('rejects dangling targets, duplicate ids, missing start and loops that never wait for the customer', () => {
    expect(validateFlow(flow)).toEqual([]);
    expect(unreachable(flow)).toEqual([]);
    const bad = flowSchema.parse({ start: 'a', nodes: [{ id: 'a', type: 'message', text: 'x', next: 'b' }, { id: 'b', type: 'message', text: 'y', next: 'a' }, { id: 'a', type: 'end', text: '' }, { id: 'c', type: 'message', text: 'z', next: 'nowhere' }] });
    const codes = validateFlow(bad).join(' ');
    expect(codes).toContain('duplicate_id:a');
    expect(codes).toContain('missing_target:c->nowhere');
    expect(validateFlow(flowSchema.parse({ start: 'zz', nodes: [{ id: 'a', type: 'end', text: '' }] }))).toContain('missing_start');
    expect(validateFlow(flowSchema.parse({ start: 'a', nodes: [{ id: 'a', type: 'message', text: 'x', next: 'b' }, { id: 'b', type: 'message', text: 'y', next: 'a' }] })).join()).toContain('loop:');
    // a menu in the loop is fine: it waits for the customer
    expect(validateFlow(flowSchema.parse({ start: 'm', nodes: [{ id: 'm', type: 'menu', text: 'x', options: [{ label: 'a', next: 'i' }] }, { id: 'i', type: 'message', text: 'y', next: 'm' }] }))).toEqual([]);
    expect(unreachable(flowSchema.parse({ start: 'a', nodes: [{ id: 'a', type: 'end', text: '' }, { id: 'orphan', type: 'end', text: '' }] }))).toEqual(['orphan']);
    expect(flowSchema.safeParse({ start: 'a', nodes: [{ id: 'a', type: 'message', text: 'x', next: 'b' }, { id: 'Bad Id', type: 'end' }] }).success).toBe(false);
    expect(flowSchema.safeParse({ start: 'a', nodes: [{ id: 'a', type: 'referral', text: 'x', contactName: 'n', phone: 'abc' }] }).success).toBe(false);
  });
  it('converts the current numbered menu into an equivalent, valid flow', () => {
    const f = flowFromMenu({ ...DEFAULT_BOT, items: [...DEFAULT_BOT.items, { title: 'בטיחות', answer: 'לממונה', contact: { name: 'דני', phone: '0501234567', message: '' }, route: { userId: '22222222-2222-4222-8222-222222222222' } }] });
    expect(validateFlow(f)).toEqual([]);
    expect(f.nodes.find((n) => n.type === 'handoff' && n.userId)).toBeTruthy();
    expect(f.nodes.find((n) => n.id === 'a1')).toMatchObject({ type: 'message', next: 'menu' });
  });
});

describe('flow engine', () => {
  it('walks: condition -> menu, free text matched by words, questions validated, tag, referral, hand-over with a summary note', async () => {
    let r = await runFlow(flow, null, 'שלום', ctx());
    expect(r.replies[0]).toContain('1. בטיחות בגובה');
    expect(r.replies[0]).toContain('0. נציג אנושי');
    expect(r.state.node).toBe('menu');
    r = await runFlow(flow, r.state, '2', ctx());
    expect(r.replies).toEqual(['פתוחים 9-17.', expect.stringContaining('במה נוכל לעזור')]); // answer, then back to the menu
    r = await runFlow(flow, r.state, 'אני צריך משהו עם פיגומים', ctx({ matchOption: async (t, o) => matchOptionLexical(t, o) }));
    expect(r.replies).toEqual(['מה שמך?']);
    expect(r.state.node).toBe('name');
    r = await runFlow(flow, r.state, 'a', ctx());               // too short: asks again, up to twice
    expect(r.replies).toEqual(['לא הצלחתי להבין, אפשר לנסות שוב?']);
    r = await runFlow(flow, r.state, 'דנה לוי', ctx());
    expect(r.effects).toContainEqual({ kind: 'name', value: 'דנה לוי' });
    expect(r.replies).toEqual(['מספר טלפון?']);
    r = await runFlow(flow, r.state, 'abc', ctx());
    expect(r.replies).toEqual(['מספר לא תקין']);
    r = await runFlow(flow, r.state, '050-123 4567', ctx());
    expect(r.state.vars).toEqual({ name: 'דנה לוי', phone: '0501234567' });
    expect(r.effects).toContainEqual({ kind: 'tag', tagId: TAG });
    expect(r.replies[0]).toContain('https://wa.me/972501234567?text=%D7%94%D7%99%D7%99');
    expect(r.effects.find((e) => e.kind === 'note')).toMatchObject({ text: expect.stringContaining('דנה לוי') });
    expect(r.effects.find((e) => e.kind === 'handoff')).toMatchObject({ reason: 'flow' });
    expect(r.state.done).toBe(true);
    expect((await runFlow(flow, r.state, 'עוד משהו', ctx())).replies).toEqual([]); // silent once a person has it
  });

  it('hours branch, knowledge base inside the menu, unknown input retries then hands over, keywords and files hand over', async () => {
    expect((await runFlow(flow, null, 'שלום', ctx({ isOpen: false }))).replies).toEqual(['סגורים כרגע, נחזור אליכם.', 'מה שמך?']);
    const kbCtx = ctx({ kbAnswer: async (t) => (t.includes('חניה') ? 'יש חניה חינם.' : null) });
    let r = await runFlow(flow, null, 'שלום', kbCtx);
    r = await runFlow(flow, r.state, 'יש חניה?', kbCtx);
    expect(r.replies[0]).toBe('יש חניה חינם.');
    expect(r.replies[1]).toContain('במה נוכל לעזור'); // stays at the menu
    expect(r.state.node).toBe('menu');
    const first = await runFlow({ ...flow, start: 'menu' }, null, 'יש חניה?', kbCtx); // even the very first message when the flow starts at a menu
    expect(first.replies[0]).toBe('יש חניה חינם.');
    r = await runFlow(flow, r.state, 'בלה בלה', ctx());
    expect(r.replies[0]).toContain('לא הבנתי');
    r = await runFlow(flow, r.state, 'עוד בלה', ctx());
    expect(r.effects).toContainEqual(expect.objectContaining({ kind: 'handoff', reason: 'unrecognized' }));
    expect((await runFlow(flow, (await runFlow(flow, null, 'x', ctx())).state, 'אפשר נציג', ctx())).effects).toContainEqual(expect.objectContaining({ kind: 'handoff', reason: 'requested' }));
    expect((await runFlow(flow, (await runFlow(flow, null, 'x', ctx())).state, '0', ctx())).effects).toContainEqual(expect.objectContaining({ kind: 'handoff', reason: 'requested' }));
    expect((await runFlow(flow, (await runFlow(flow, null, 'x', ctx())).state, null, ctx())).effects).toContainEqual(expect.objectContaining({ kind: 'handoff', reason: 'media' }));
  });

  it('a finished flow without a hand-over starts again after 30 minutes; "תפריט" restarts at any time', async () => {
    const f = flowSchema.parse({ start: 'm', nodes: [{ id: 'm', type: 'menu', text: 'בחרו', options: [{ label: 'תודה', next: 'e' }] }, { id: 'e', type: 'end', text: 'להתראות' }] });
    let r = await runFlow(f, null, 'היי', ctx());
    r = await runFlow(f, r.state, '1', ctx());
    expect(r.replies).toEqual(['להתראות']);
    expect(r.state).toMatchObject({ done: true, endedAt: 1_000_000 });
    expect((await runFlow(f, r.state, 'תודה', ctx({ now: 1_000_000 + 60_000 }))).replies).toEqual([]);
    expect((await runFlow(f, r.state, 'שלום שוב', ctx({ now: 1_000_000 + 31 * 60_000 }))).replies[0]).toContain('בחרו');
    const mid = await runFlow(flow, null, 'שלום', ctx());
    const q = await runFlow(flow, { ...mid.state, node: 'name' } as FlowState, 'תפריט', ctx());
    expect(q.replies[0]).toContain('1. בטיחות בגובה');
  });

  it('matches free text to an option only when exactly one option fits all its words', () => {
    const opts = [{ label: 'בטיחות בגובה', examples: ['פיגומים'] }, { label: 'בטיחות אש', examples: [] }, { label: 'שעות פעילות', examples: [] }];
    expect(matchOptionLexical('אני רוצה לשאול על בטיחות בגובה', opts)).toBe(0);
    expect(matchOptionLexical('יש לי שאלה על פיגומים', opts)).toBe(0);
    expect(matchOptionLexical('מתי שעות הפעילות', opts)).toBe(2);
    expect(matchOptionLexical('בטיחות', opts)).toBeNull();            // ambiguous: two options share it
    expect(matchOptionLexical('מה מזג האוויר', opts)).toBeNull();
  });
});

describe('flow bot end to end', () => {
  const ORIGIN = 'https://panel.test';
  const PW = 'correct-horse-battery';
  const cfg = loadConfig({
    NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test',
    ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false',
  });
  const db = createDb(cfg.DATABASE_URL);
  let app: Awaited<ReturnType<typeof buildApp>>;
  let mgr: ChannelManager;
  let ctxA: AdapterContext;
  const sent: string[] = [];
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let ip = 0;
  class Fake implements ChannelAdapter {
    constructor(c: AdapterContext) { ctxA = c; }
    async start() { ctxA.events.onStatus('connected'); }
    async stop() {}
    async logout() {}
    async sendText(_t: string, text: string) { sent.push(text); return { externalMessageId: `f${sent.length}` }; }
  }
  const factory: AdapterFactory = (t, c) => (t === 'whatsapp' ? new Fake(c) : null);
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, who?: string, payload?: object) =>
    app.inject({ method, url, payload, remoteAddress: `10.62.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, ...(who ? { cookie: cookies[who]! } : {}) } });
  let mid = 0;
  const say = async (who: string, text: string) => {
    sent.length = 0;
    await ctxA.events.onMessage({ externalContactId: who, externalMessageId: `w${++mid}`, text, timestamp: new Date() });
    return [...sent];
  };
  let tagId = '';

  beforeAll(async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    mgr = new ChannelManager(db, cfg, factory);
    app = await buildApp(cfg, db, mgr);
    for (const [e, r] of [['admin', 'admin'], ['sup', 'supervisor'], ['a1', 'agent']] as const) {
      ids[e] = (await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4) RETURNING id', [`${e}@t.io`, e, r, await hashPassword(PW)])).rows[0].id;
      cookies[`${e}@t.io`] = `botwa_sid=${(await call('POST', '/auth/login', undefined, { email: `${e}@t.io`, password: PW })).cookies[0]!.value}`;
    }
    tagId = (await db.query(`INSERT INTO tags (name) VALUES ('בטיחות') RETURNING id`)).rows[0].id;
    const ch = (await call('POST', '/channels', 'admin@t.io', { type: 'whatsapp', label: 'WA' })).json().id;
    await call('POST', `/channels/${ch}/start`, 'admin@t.io');
    await new Promise((r) => setTimeout(r, 40));
  });
  afterAll(async () => { await mgr.stopAll(); await app.close(); await db.end(); });

  const myFlow = (): Flow => flowSchema.parse({
    start: 'menu', nodes: [
      { id: 'menu', type: 'menu', text: 'ברוכים הבאים', options: [{ label: 'בטיחות בגובה', next: 'name' }, { label: 'שעות', next: 'hrs' }] },
      { id: 'hrs', type: 'message', text: 'פתוחים 9-17', next: 'menu' },
      { id: 'name', type: 'question', text: 'איך קוראים לך?', save: 'name', next: 'tag' },
      { id: 'tag', type: 'tag', tagId, next: 'go' },
      { id: 'go', type: 'handoff', text: 'מעביר אותך לממונה', userId: ids.a1 },
    ],
  });

  it('only people who manage the bot can save; invalid flows and unknown people/tags are refused; permissions are enforced', async () => {
    expect((await call('GET', '/flow', 'a1@t.io')).statusCode).toBe(403);
    expect((await call('PUT', '/flow', 'sup@t.io', { flow: myFlow() })).statusCode).toBe(403);
    expect((await call('GET', '/flow', 'sup@t.io')).json()).toMatchObject({ flow: null, mode: 'menu' });
    const bad = await call('PUT', '/flow', 'admin@t.io', { flow: { start: 'x', nodes: [{ id: 'a', type: 'end', text: '' }] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().problems).toContain('missing_start');
    const f = myFlow();
    (f.nodes.find((n) => n.id === 'go') as { userId?: string }).userId = '33333333-3333-4333-8333-333333333333';
    expect((await call('PUT', '/flow', 'admin@t.io', { flow: f })).json()).toEqual({ error: 'unknown_user' });
    (f.nodes.find((n) => n.id === 'go') as { userId?: string }).userId = ids.a1;
    (f.nodes.find((n) => n.id === 'tag') as { tagId?: string }).tagId = '44444444-4444-4444-8444-444444444444';
    expect((await call('PUT', '/flow', 'admin@t.io', { flow: f })).json()).toEqual({ error: 'unknown_tag' });
    expect((await call('PUT', '/flow', 'admin@t.io', { flow: myFlow() })).statusCode).toBe(200);
    expect((await call('GET', '/flow/refs', 'sup@t.io')).json().tags[0].name).toBe('בטיחות');
  });

  it('simulate runs the engine without storing anything', async () => {
    const r1 = (await call('POST', '/flow/simulate', 'sup@t.io', { state: null, text: 'שלום' })).json();
    expect(r1.replies[0]).toContain('1. בטיחות בגובה');
    const r2 = (await call('POST', '/flow/simulate', 'sup@t.io', { state: r1.state, text: '2' })).json();
    expect(r2.replies[0]).toBe('פתוחים 9-17');
    expect((await db.query('SELECT count(*)::int AS n FROM conversations')).rows[0].n).toBe(0);
    expect((await call('POST', '/flow/simulate', 'a1@t.io', { state: null, text: 'x' })).statusCode).toBe(403);
    expect((await call('POST', '/flow/from-menu', 'admin@t.io')).json().flow.nodes.length).toBeGreaterThan(1);
  });

  it('live: the flow drives a real conversation (menu, question, tag, contact name, summary note, assignment)', async () => {
    await call('PUT', '/settings/bot', 'admin@t.io', { ...DEFAULT_BOT, enabled: true, mode: 'flow' });
    expect((await say('fl1', 'היי'))[0]).toContain('1. בטיחות בגובה');
    expect(await say('fl1', '2')).toEqual(['פתוחים 9-17', expect.stringContaining('ברוכים הבאים')]);
    expect(await say('fl1', '1')).toEqual(['איך קוראים לך?']);
    const out = await say('fl1', 'דנה לוי');
    expect(out[0]).toBe('מעביר אותך לממונה');
    const c = (await db.query(`SELECT c.id, c.assigned_to, c.bot_state, ct.display_name FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.external_id = 'fl1'`)).rows[0];
    expect(c).toMatchObject({ assigned_to: ids.a1, bot_state: 'human', display_name: 'דנה לוי' });
    expect((await db.query('SELECT count(*)::int AS n FROM conversation_tags WHERE conversation_id = $1 AND tag_id = $2', [c.id, tagId])).rows[0].n).toBe(1);
    expect((await db.query('SELECT body FROM conversation_notes WHERE conversation_id = $1', [c.id])).rows.map((r) => r.body).join('|')).toContain('דנה לוי');
    expect(await say('fl1', 'עוד שאלה')).toEqual([]); // a person has it
    // switching back to the menu bot uses the numbered menu again
    await call('PUT', '/settings/bot', 'admin@t.io', { ...DEFAULT_BOT, enabled: true, mode: 'menu' });
    expect((await say('fl2', 'היי'))[0]).toContain('1. שעות פעילות');
  });
});

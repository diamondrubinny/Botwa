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

describe('flow engine: identification, reports with photos, lists, areas', () => {
  const U1 = '55555555-5555-4555-8555-555555555555';
  const f: Flow = flowSchema.parse({
    start: 'known', labels: { fullName: 'שם מלא', building: 'בניין', chemicals: 'כימיקלים', status: 'סטטוס', where: 'מיקום' },
    nodes: [
      { id: 'known', type: 'condition', check: { kind: 'has', name: 'fullName' }, yes: 'topics', no: 'q_name' },
      { id: 'q_name', type: 'question', text: 'שם מלא?', save: 'fullName', kind: 'name', next: 'q_bld' },
      { id: 'q_bld', type: 'question', text: 'שם בניין? (אפשר לדלג)', save: 'building', optional: true, next: 'm_status' },
      { id: 'm_status', type: 'menu', text: 'מה הסטטוס שלך?', save: 'status', options: [{ label: 'משתלם', next: 'keep' }, { label: 'עובד טכני', next: 'keep' }] },
      { id: 'keep', type: 'remember', vars: ['fullName', 'building', 'status'], next: 'topics' },
      { id: 'topics', type: 'menu', text: 'נושא?', kbOnFreeText: false, options: Array.from({ length: 12 }, (_, i) => ({ label: i === 0 ? 'חומרים' : i === 1 ? 'מפגע' : `נושא ${i + 1}`, next: i === 0 ? 'chem' : i === 1 ? 'haz' : undefined })) },
      { id: 'chem', type: 'list', text: 'שם הכימיקל?', save: 'chemicals', max: 3, moreText: 'עוד כימיקל?', next: 'sds' },
      { id: 'sds', type: 'media', text: 'אפשר להעלות SDS (או דלגו)', optional: true, allowText: false, next: 'q', },
      { id: 'q', type: 'question', text: 'מה השאלה?', save: 'question', next: 'tag' },
      { id: 'tag', type: 'tag', tagId: TAG, next: 'ho' },
      { id: 'ho', type: 'handoff', text: 'הועבר לרוברט', userId: U1 },
      { id: 'haz', type: 'media', text: 'שלחו תמונה או תארו', save: 'description', next: 'where' },
      { id: 'where', type: 'question', text: 'מיקום מדויק?', save: 'where', next: 'ho2' },
      { id: 'ho2', type: 'handoff', text: 'הועבר לממונה האזור', areaVars: ['where', 'building'], userId: U1 },
    ],
  });
  const c = (over: Partial<FlowContext> = {}) => ctx(over);
  const say = async (st: FlowState | null, text: string | null, over: Partial<FlowContext> = {}, media = false) => runFlow(f, st, { text, media }, c(over));

  it('identifies a new customer, allows skipping optional questions, offers more than nine menu options, and remembers the answers', async () => {
    expect(validateFlow(f)).toEqual([]);
    let r = await say(null, 'שלום');
    expect(r.replies).toEqual(['שם מלא?']);
    r = await say(r.state, 'ד');                                  // too short
    expect(r.replies).toEqual(['לא הצלחתי להבין, אפשר לנסות שוב?']);
    r = await say(r.state, 'דנה לוי');
    expect(r.effects).toContainEqual({ kind: 'name', value: 'דנה לוי' });
    r = await say(r.state, 'דלג');                                 // optional building skipped
    expect(r.replies[0]).toContain('מה הסטטוס שלך?');
    r = await say(r.state, '1');
    expect(r.state.vars).toEqual({ fullName: 'דנה לוי', status: 'משתלם' });
    expect(r.effects).toContainEqual({ kind: 'profile', vars: { fullName: 'דנה לוי', status: 'משתלם' } });
    expect(r.replies[0]).toContain('12. נושא 12');                   // two-digit options work
    // next conversation: the profile is known, identification is skipped
    const again = await say(null, 'היי', { profile: { fullName: 'דנה לוי', status: 'משתלם' } });
    expect(again.replies[0]).toContain('נושא?');
  });

  it('collects up to N items, an optional file, then the question; the summary note has labelled details', async () => {
    const known = { profile: { fullName: 'דנה לוי', building: '12' } };
    let r = await say(null, 'x', known);
    r = await say(r.state, '1', known);
    expect(r.replies).toEqual(['שם הכימיקל?']);
    r = await say(r.state, 'אצטון');
    expect(r.replies[0]).toContain('עוד כימיקל?');
    r = await say(r.state, 'כן');
    expect(r.replies).toEqual(['שם הכימיקל?']);
    r = await say(r.state, 'אתנול');
    r = await say(r.state, '2');                                   // no more
    expect(r.state.vars.chemicals).toBe('אצטון; אתנול');
    expect(r.replies[0]).toContain('SDS');
    r = await say(r.state, null, {}, true);                         // a file
    expect(r.state.files).toBe(1);
    expect(r.replies).toEqual(['מה השאלה?']);
    r = await say(r.state, 'האם מותר לערבב?');
    const note = r.effects.find((e) => e.kind === 'note') as { text: string };
    expect(note.text).toContain('שם מלא: דנה לוי');
    expect(note.text).toContain('כימיקלים: אצטון; אתנול');
    expect(note.text).toContain('קבצים שנשלחו: 1');
    expect(r.effects).toContainEqual({ kind: 'tag', tagId: TAG });
    expect(r.effects.find((e) => e.kind === 'handoff')).toMatchObject({ userId: U1, text: 'הועבר לרוברט' });
    expect(r.replies).toEqual([]);                                  // the hand-over text is sent by the hand-over itself, once

    // the list stops by itself at its maximum
    let l = await say(null, 'x', known); l = await say(l.state, '1', known);
    for (const item of ['א', 'ב']) { l = await say(l.state, item); l = await say(l.state, 'כן'); }
    l = await say(l.state, 'ג');
    expect(l.state.vars.chemicals).toBe('א; ב; ג');
    // the optional file can be skipped
    const skip = await say(null, 'x', known).then((a) => say(a.state, '1')).then((a) => say(a.state, 'אצטון')).then((a) => say(a.state, '2')).then((a) => say(a.state, 'דלג'));
    expect(skip.replies).toEqual(['מה השאלה?']);
  });

  it('a report takes a photo or a description, asks where, and sends it to the officer of that area', async () => {
    const known = { profile: { fullName: 'דנה לוי', building: 'בניין 5' } };
    let r = await say(null, 'x', known);
    r = await say(r.state, '2', known);
    expect(r.replies).toEqual(['שלחו תמונה או תארו']);
    r = await say(r.state, null, {}, true);                         // photo only
    expect(r.replies).toEqual(['מיקום מדויק?']);
    r = await say(r.state, 'מעבדה 214 בניין 12 קומה 2', { resolveArea: async (t) => (/בניין 12/.test(t) ? '66666666-6666-4666-8666-666666666666' : null) });
    expect(r.effects.find((e) => e.kind === 'handoff')).toMatchObject({ userId: '66666666-6666-4666-8666-666666666666' });
    // no area matches: the fallback officer
    let r2 = await say(null, 'x', known); r2 = await say(r2.state, '2'); r2 = await say(r2.state, 'דליפה');
    r2 = await say(r2.state, 'מקום לא ידוע', { resolveArea: async () => null });
    expect(r2.effects.find((e) => e.kind === 'handoff')).toMatchObject({ userId: U1 });
    // a description alone is also accepted; an empty retry asks again
    let r3 = await say(null, 'x', known); r3 = await say(r3.state, '2');
    r3 = await say(r3.state, '   ');
    expect(r3.effects.find((e) => e.kind === 'handoff')).toMatchObject({ reason: 'media' });
  });

  it('extra photos in a row do not interrupt, and a stray first photo at a text question goes to a person', async () => {
    let r = await say(null, 'x', { profile: { fullName: 'דנה' } });
    r = await say(r.state, '2');
    r = await say(r.state, null, {}, true);                         // photo 1 accepted by the media node
    expect(r.replies).toEqual(['מיקום מדויק?']);
    const p2 = await say(r.state, null, {}, true);                  // photo 2 arrives while it asks where
    expect(p2.replies).toEqual([]);
    expect(p2.state.node).toBe('where');
    expect(p2.effects).toEqual([]);
    const stray = await say((await say(null, 'x')).state, null, {}, true); // first message of a new customer is a question; a photo there needs a person
    expect(stray.effects.find((e) => e.kind === 'handoff')).toMatchObject({ reason: 'media' });
  });
});

import { buildSafetyFlow, STATUSES, TEMPLATE_TAGS } from '../src/flow/safetyTemplate.js';
import { unfinished } from '../src/flow/schema.js';

describe('the safety unit template', () => {
  const tagIds = new Map(TEMPLATE_TAGS.map((n, i) => [n, `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`]));
  const t = buildSafetyFlow((n) => tagIds.get(n as never) ?? '');
  const byId = new Map(t.nodes.map((n) => [n.id, n]));
  const U = '77777777-7777-4777-8777-777777777777';

  it('is a valid flow that follows the specification: 15 topics, 9 statuses, forms as links still to be filled in', () => {
    expect(validateFlow(t)).toEqual([]);
    expect(unreachable(t)).toEqual([]);
    expect(t.nodes.length).toBeLessThanOrEqual(150);
    const topics = byId.get('topics')!;
    expect(topics.type === 'menu' && topics.options.length).toBe(15);
    expect(byId.get('m_status')!.type === 'menu' && (byId.get('m_status') as { options: unknown[] }).options.length).toBe(STATUSES.length);
    expect(STATUSES).toHaveLength(9);
    expect(unfinished(t).sort()).toEqual(['accident', 'event', 'offsite', 'waste']);          // the four form links
    const required = ['q_name', 'q_faculty', 'q_pi'].map((id) => (byId.get(id) as { optional: boolean }).optional);
    expect(required).toEqual([false, false, false]);                                         // name, faculty, PI are mandatory
    expect(['q_building', 'q_room'].map((id) => (byId.get(id) as { optional: boolean }).optional)).toEqual([true, true]);
    const chem = byId.get('chem_list') as { max: number };
    expect(chem.max).toBe(10);
    const unknownTags = t.nodes.filter((n) => n.type === 'tag' && !n.tagId);
    expect(unknownTags).toEqual([]);
    // every report ends in a hand-over, hazards by area
    expect((byId.get('hz_ho') as { areaVars?: string[] }).areaVars).toEqual(['where', 'building']);
    expect(['waste', 'accident', 'event', 'offsite'].every((id) => byId.get(id)!.type === 'message')).toBe(true);
  });

  const run = (state: FlowState | null, text: string | null, over: Partial<FlowContext> = {}, media = false) => runFlow(t, state, { text, media }, ctx({ humanOption: true, matchOption: async (x, o) => matchOptionLexical(x, o), ...over }));

  it('walks a new customer through identification and a laser report, then a returning customer straight to the topics', async () => {
    let r = await run(null, 'היי');
    expect(r.replies.join('\n')).toContain('שם מלא:');
    for (const a of ['דנה לוי', 'דלג', 'דלג', 'הנדסה', 'פרופ׳ כהן']) r = await run(r.state, a);
    expect(r.replies[0]).toContain('מה הסטטוס שלך?');
    r = await run(r.state, '2');                                                                // משתלם
    expect(r.effects).toContainEqual({ kind: 'profile', vars: { fullName: 'דנה לוי', faculty: 'הנדסה', pi: 'פרופ׳ כהן', status: 'משתלם' } });
    expect(r.replies[0]).toContain('15. שאלה כללית / דיווח אחר');
    r = await run(r.state, 'יש לי שאלה על לייזר במעבדה');                                         // free text -> the laser topic by words
    expect(r.replies.join('\n')).toContain('שלחו תמונה של האזור');
    r = await run(r.state, null, {}, true);                                                     // photo
    expect(r.replies).toEqual(['ציינו מיקום מדויק (בניין, קומה, חדר, ליד מה):']);
    r = await run(r.state, 'בניין 3 חדר 12');
    expect(r.replies[0]).toContain('מסמכים של המכשור');
    r = await run(r.state, 'דלג');
    expect(r.effects).toContainEqual({ kind: 'tag', tagId: tagIds.get('לייזרים') });
    expect(r.effects.find((e) => e.kind === 'handoff')).toMatchObject({ reason: 'flow', text: expect.stringContaining('הועברה לטיפול') });
    const note = (r.effects.find((e) => e.kind === 'note') as { text: string }).text;
    for (const part of ['שם מלא: דנה לוי', 'פקולטה: הנדסה', 'שם ה-PI: פרופ׳ כהן', 'סטטוס: משתלם', 'מיקום: בניין 3 חדר 12', 'קבצים שנשלחו: 1']) expect(note).toContain(part);

    const back = await run(null, 'שלום', { profile: { fullName: 'דנה לוי', faculty: 'הנדסה', pi: 'פרופ׳ כהן', status: 'משתלם' } });
    expect(back.replies[0]).toContain('ברצוני לקבל מידע / לדווח על:');
  });

  it('forms are links, chemicals take up to ten items and an optional SDS, the question goes to the officer, hazards to the area officer', async () => {
    const known = { profile: { fullName: 'דנה', faculty: 'x', pi: 'y', status: 'משתלם', building: 'בניין 7' } };
    let r = await run(null, 'x', known);
    r = await run(r.state, '1');                                                                 // waste form
    expect(r.replies[0]).toContain('[להשלים: קישור לטופס פינוי פסולת כימית]');
    expect(r.replies[1]).toContain('1. שאלתא'.slice(0, 0) + 'שאילתא בנושא פינוי פסולת כימית');       // back at the topics
    r = await run(r.state, '5');                                                                 // chemicals
    r = await run(r.state, 'אצטון');
    r = await run(r.state, 'כן');
    r = await run(r.state, 'אתנול');
    r = await run(r.state, '2');
    r = await run(r.state, null, {}, true);                                                      // SDS file
    r = await run(r.state, 'האם אפשר לאחסן יחד?');
    expect(r.state.vars.chemicals).toBe('אצטון; אתנול');
    expect(r.effects.filter((e) => e.kind === 'tag').map((e) => (e as { tagId: string }).tagId)).toEqual([tagIds.get('חומ״ס'), tagIds.get('כימיקלים המחייבים ניטור')]);
    expect(r.effects.find((e) => e.kind === 'handoff')).toMatchObject({ reason: 'flow' });

    let h = await run(null, 'x', known);
    h = await run(h.state, '6');
    h = await run(h.state, 'כבל חשוף על הרצפה');
    h = await run(h.state, 'ליד המעלית');
    const hh = await run(h.state, 'x'); void hh;
    // officer by area: the answer to "where" names a building that belongs to an area
    let a = await run(null, 'x', known); a = await run(a.state, '6'); a = await run(a.state, 'כבל חשוף');
    a = await run(a.state, 'בניין 12 קומה 1', { resolveArea: async (s) => (s.includes('בניין 12') ? U : null) });
    expect(a.effects.find((e) => e.kind === 'handoff')).toMatchObject({ userId: U });
    // when the place is not recognised the identification building is tried, then the default
    let b = await run(null, 'x', known); b = await run(b.state, '6'); b = await run(b.state, 'כבל חשוף');
    b = await run(b.state, 'מקום לא מוכר', { resolveArea: async (s) => (s.includes('בניין 7') ? U : null) });
    expect(b.effects.find((e) => e.kind === 'handoff')).toMatchObject({ userId: U });
  });
});

describe('safety flow live: areas, template endpoint, placeholders, profile, files', () => {
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
    async sendText(_t: string, text: string) { sent.push(text); return { externalMessageId: `s${sent.length}` }; }
  }
  const factory: AdapterFactory = (ty, c) => (ty === 'whatsapp' ? new Fake(c) : null);
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, who?: string, payload?: object) =>
    app.inject({ method, url, payload, remoteAddress: `10.68.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, ...(who ? { cookie: cookies[who]! } : {}) } });
  let mid = 0;
  const say = async (who: string, text: string, media = false) => {
    sent.length = 0;
    await ctxA.events.onMessage({ externalContactId: who, externalMessageId: `sf${++mid}`, text, timestamp: new Date(), media: media ? { fileName: 'p.png', download: async () => Buffer.alloc(0) } : undefined });
    return [...sent];
  };
  const conv = async (who: string) => (await db.query(`SELECT c.id, c.assigned_to, c.bot_state, ct.display_name, ct.profile FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.external_id = $1`, [who])).rows[0];

  beforeAll(async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    mgr = new ChannelManager(db, cfg, factory);
    app = await buildApp(cfg, db, mgr);
    for (const [e, r] of [['admin', 'admin'], ['sup', 'supervisor'], ['o1', 'agent'], ['o2', 'agent']] as const) {
      ids[e] = (await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4) RETURNING id', [`${e}@t.io`, e, r, await hashPassword(PW)])).rows[0].id;
      cookies[`${e}@t.io`] = `botwa_sid=${(await call('POST', '/auth/login', undefined, { email: `${e}@t.io`, password: PW })).cookies[0]!.value}`;
    }
    const ch = (await call('POST', '/channels', 'admin@t.io', { type: 'whatsapp', label: 'WA' })).json().id;
    await call('POST', `/channels/${ch}/start`, 'admin@t.io');
    await new Promise((r) => setTimeout(r, 40));
  });
  afterAll(async () => { await mgr.stopAll(); await app.close(); await db.end(); });

  it('areas: only bot managers edit, active users only; matching is by whole words and in order', async () => {
    expect((await call('POST', '/safety/areas', 'sup@t.io', { name: 'x', keywords: ['a'], userId: ids.o1 })).statusCode).toBe(403);
    expect((await call('POST', '/safety/areas', 'admin@t.io', { name: 'x', keywords: ['a'], userId: '00000000-0000-4000-8000-000000000000' })).json()).toEqual({ error: 'unknown_user' });
    expect((await call('POST', '/safety/areas', 'admin@t.io', { name: 'מדעי החיים', keywords: ['בניין 12', 'בניין 13'], userId: ids.o1 })).statusCode).toBe(201);
    const second = (await call('POST', '/safety/areas', 'admin@t.io', { name: 'הנדסה', keywords: ['בניין 5', 'חדר מחשבים'], userId: ids.o2 })).json().id as string;
    const { resolveArea } = await import('../src/safety/areas.js');
    expect(await resolveArea(db, 'מעבדה 214, בניין 12, קומה 2')).toBe(ids.o1);
    expect(await resolveArea(db, 'בניין 125')).toBeNull();                 // "בניין 12" is not a prefix match of 125
    expect(await resolveArea(db, 'ליד חדר המחשבים בקומה 1')).toBeNull();   // different phrase
    expect(await resolveArea(db, 'חדר מחשבים בבניין 5')).toBe(ids.o2);
    expect((await call('GET', '/safety/areas', 'sup@t.io')).json()).toHaveLength(2);
    await db.query('UPDATE users SET active = false WHERE id = $1', [ids.o2]);
    expect(await resolveArea(db, 'בניין 5')).toBeNull();                    // an inactive officer is skipped
    await db.query('UPDATE users SET active = true WHERE id = $1', [ids.o2]);
    expect((await call('PUT', `/safety/areas/${second}`, 'admin@t.io', { name: 'הנדסה', keywords: ['בניין 5'], userId: ids.o2 })).statusCode).toBe(200);
    expect((await call('DELETE', `/safety/areas/${second}`, 'admin@t.io')).statusCode).toBe(200);
    expect((await call('GET', '/safety/areas', 'sup@t.io')).json()).toHaveLength(1);
  });

  it('the template endpoint creates the tags, and the bot cannot be switched on while placeholders remain', async () => {
    expect((await call('POST', '/flow/templates/safety', 'sup@t.io')).statusCode).toBe(403);
    const tpl = (await call('POST', '/flow/templates/safety', 'admin@t.io')).json();
    expect(tpl.flow.nodes.length).toBeGreaterThan(60);
    expect((await db.query(`SELECT count(*)::int AS n FROM tags WHERE name IN ('לייזרים','חומ״ס','מפגע','Biosafety','סולמות')`)).rows[0].n).toBe(5);
    expect((await call('PUT', '/flow', 'admin@t.io', { flow: tpl.flow })).statusCode).toBe(200);
    expect((await call('GET', '/flow', 'admin@t.io')).json().unfinished.sort()).toEqual(['accident', 'event', 'offsite', 'waste']);
    const blocked = await call('PUT', '/flow/mode', 'admin@t.io', { mode: 'flow' });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ error: 'unfinished_flow' });
    // the unit fills in the form links and an officer for chemicals
    const f = JSON.parse(JSON.stringify(tpl.flow)) as { nodes: { id: string; text?: string; userId?: string }[] };
    for (const n of f.nodes) { if (n.text?.includes('[להשלים')) n.text = n.text.replace(/\[להשלים: [^\]]*\]/, 'https://forms.example.com/x'); if (n.id === 'chem_ho') n.userId = ids.o2; }
    expect((await call('PUT', '/flow', 'admin@t.io', { flow: f })).statusCode).toBe(200);
    expect((await call('PUT', '/flow/mode', 'admin@t.io', { mode: 'flow' })).statusCode).toBe(200);
  });

  it('a real conversation: identification once, a hazard with a photo routed by area, a chemicals question routed to its officer, tags and the summary note', async () => {
    await call('PUT', '/settings/bot', 'admin@t.io', { ...DEFAULT_BOT, enabled: true, mode: 'flow' });
    const first = await say('wa1', 'שלום'); expect(first.join(' ')).toContain('שם מלא');
    await say('wa1', 'רונית כהן'); await say('wa1', 'דלג'); await say('wa1', 'דלג'); await say('wa1', 'מדעי החיים'); await say('wa1', 'פרופ׳ לוי');
    const topics = await say('wa1', '1');                                                    // status: manager
    expect(topics[0]).toContain('ברצוני לקבל מידע / לדווח על:');
    const c0 = await conv('wa1');
    expect(c0.display_name).toBe('רונית כהן');
    expect(c0.profile).toMatchObject({ fullName: 'רונית כהן', faculty: 'מדעי החיים', pi: 'פרופ׳ לוי', status: 'מנהל / מהנדס מעבדה' });
    expect(await say('wa1', '6')).toEqual(['שלחו תמונה של המפגע או תארו אותו בכתב:']);
    expect(await say('wa1', '', true)).toEqual(['ציינו מיקום מדויק (בניין, קומה, חדר, ליד מה):']);   // photo only
    const out = await say('wa1', 'מעבדה 214 בניין 12 קומה 2');
    expect(out).toEqual(['הפנייה התקבלה והועברה לטיפול. נחזור אליך בהקדם.']);                    // one confirmation, not two
    const c1 = await conv('wa1');
    expect(c1).toMatchObject({ assigned_to: ids.o1, bot_state: 'human' });                   // officer of building 12
    expect((await db.query(`SELECT t.name FROM conversation_tags x JOIN tags t ON t.id = x.tag_id WHERE x.conversation_id = $1`, [c1.id])).rows.map((r) => r.name)).toEqual(['מפגע']);
    const note = (await db.query(`SELECT body FROM conversation_notes WHERE conversation_id = $1 AND body LIKE 'פרטים שנאספו%'`, [c1.id])).rows[0].body as string;
    for (const part of ['שם מלא: רונית כהן', 'פקולטה: מדעי החיים', 'מיקום: מעבדה 214 בניין 12 קומה 2', 'קבצים שנשלחו: 1']) expect(note).toContain(part);

    // the same person writes again from a new contact id? no: same contact, new topic after a person closed the case
    await db.query(`UPDATE conversations SET status = 'closed', flow_state = NULL, bot_state = NULL, assigned_to = NULL WHERE id = $1`, [c1.id]);
    const again = await say('wa1', 'שלום שוב');
    expect(again[0]).toContain('ברצוני לקבל מידע / לדווח על:');                                 // identification is not asked again
    await say('wa1', '5');                                                                    // chemicals
    await say('wa1', 'אצטון'); await say('wa1', '2');                                          // one item, no more
    await say('wa1', 'דלג');                                                                  // no SDS
    await say('wa1', 'האם אפשר לאחסן אצטון ליד חומצה?');
    const c2 = await conv('wa1');
    expect(c2.assigned_to).toBe(ids.o2);                                                     // the chemicals officer chosen in the flow
    expect((await db.query(`SELECT t.name FROM conversation_tags x JOIN tags t ON t.id = x.tag_id WHERE x.conversation_id = $1 ORDER BY t.name`, [c2.id])).rows.map((r) => r.name)).toEqual(['חומ״ס', 'כימיקלים המחייבים ניטור', 'מפגע']);  // the earlier hazard tag stays on the same thread
  });
});

import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { DEFAULT_BOT } from '../src/bot.js';
import { ChannelManager } from '../src/channels/manager.js';
import type { AdapterContext, AdapterFactory, ChannelAdapter } from '../src/channels/types.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { learnNorm, reactionMeaning, scrubPII } from '../src/learn.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';

describe('learning helpers', () => {
  it('removes phones, e-mails, ID numbers and the customer\'s names from a staff answer', () => {
    const s = scrubPII('שלום דנה, התקשרי ל-050-123-4567 או כתבי ל dana.levi@mail.co.il. ת"ז 123456789. סעיף 12 בתקנות.', ['דנה לוי']);
    expect(s).toBe('שלום [שם], התקשרי ל-[טלפון/מספר] או כתבי ל [אימייל]. ת"ז [מספר מזהה]. סעיף 12 בתקנות.');
    expect(scrubPII('גובה 2 מטר, תקנה 4(א)')).toBe('גובה 2 מטר, תקנה 4(א)');                 // short numbers stay
  });
  it('reads reactions as helpful / not helpful / meaningless', () => {
    expect(reactionMeaning('👍')).toBe(true);
    expect(reactionMeaning('🙏🏽')).toBe(true);
    expect(reactionMeaning('👎')).toBe(false);
    expect(reactionMeaning('😂')).toBeNull();
    expect(reactionMeaning('')).toBeNull();
    expect(learnNorm('  מה  הגובה?! ')).toBe(learnNorm('מה הגובה'));
  });
});

const ORIGIN = 'https://panel.test';
const PW = 'correct-horse-battery';
const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test', ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false' });
const db = createDb(cfg.DATABASE_URL);
let app: Awaited<ReturnType<typeof buildApp>>;
let mgr: ChannelManager;
let ctxA: AdapterContext;
const sent: { to: string; text: string; id: string }[] = [];
let sid = 0;
class Fake implements ChannelAdapter {
  constructor(c: AdapterContext) { ctxA = c; }
  async start() { ctxA.events.onStatus('connected'); }
  async stop() {}
  async logout() {}
  async sendText(to: string, text: string) { const id = `out${++sid}`; sent.push({ to, text, id }); return { externalMessageId: id }; }
}
const cookies: Record<string, string> = {};
let ip = 0;
const call = (method: 'GET' | 'POST' | 'PUT', url: string, who: string, payload?: object) =>
  app.inject({ method, url, payload, remoteAddress: `10.95.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, cookie: cookies[who]! } });
let mid = 0;
const say = async (who: string, text: string) => { sent.length = 0; await ctxA.events.onMessage({ externalContactId: who, externalMessageId: `in${++mid}`, text, timestamp: new Date() }); return sent.map((x) => x.text); };
const convOf = async (who: string) => (await db.query(`SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.external_id = $1`, [who])).rows[0].id as string;
const pending = async (kind: string) => ((await call('GET', '/kb/learning', 'adm')).json() as { id: string; kind: string; text: string; answer: string | null; hits: number; node?: string; option?: string }[]).filter((x) => x.kind === kind);
let ladder = '';

const FLOW = {
  start: 'menu', kbFirst: true, nodes: [
    { id: 'menu', type: 'menu', text: 'במה אפשר לעזור?', kbOnFreeText: true, options: [{ label: 'פינוי פסולת', next: 'w', examples: [] }, { label: 'הדרכות', next: 'w', examples: [] }] },
    { id: 'w', type: 'message', text: 'טופס: פנו ליחידה.', next: 'menu' },
  ],
};

beforeAll(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  mgr = new ChannelManager(db, cfg, ((ty, c) => (ty === 'whatsapp' ? new Fake(c) : null)) as AdapterFactory);
  app = await buildApp(cfg, db, mgr);
  for (const [e, r] of [['adm', 'admin'], ['ag', 'agent']] as const) {
    await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4)', [`${e}@t.io`, e, r, await hashPassword(PW)]);
    cookies[e] = `botwa_sid=${(await app.inject({ method: 'POST', url: '/auth/login', payload: { email: `${e}@t.io`, password: PW }, remoteAddress: `10.95.9.${++ip}`, headers: { origin: ORIGIN } })).cookies[0]!.value}`;
  }
  const ch = (await call('POST', '/channels', 'adm', { type: 'whatsapp', label: 'WA' })).json().id;
  await call('POST', `/channels/${ch}/start`, 'adm');
  await new Promise((r) => setTimeout(r, 60));
  ladder = (await call('POST', '/kb/sources/faq', 'adm', { title: 'באיזה גובה מותר לעבוד על סולם נייד', body: 'סולם נייד: עד גובה 2 מטר בלי אמצעי נוסף.', variants: [] })).json().id;
  await call('POST', '/kb/sources/faq', 'adm', { title: 'כל כמה זמן בודקים מטף כיבוי', body: 'בדיקה חודשית חזותית ושנתית על ידי טכנאי.', variants: [] });
  await call('POST', '/kb/sources/faq', 'adm', { title: 'שעות הפעילות של היחידה', body: 'א׳–ה׳ 8:00–16:00.', variants: [] });
  await mgr.kb!.idle();
  expect((await call('PUT', '/flow', 'adm', { flow: FLOW })).statusCode).toBe(200);
  expect((await call('PUT', '/settings/bot', 'adm', { ...DEFAULT_BOT, enabled: true, mode: 'flow', kb: { ...DEFAULT_BOT.kb, minScore: 0.6 } })).statusCode).toBe(200);
});
afterAll(async () => { await mgr.stopAll(); await app.close(); await db.end(); });

describe('the bot learns (with approval)', () => {
  it('only kb.manage sees and decides', async () => {
    expect((await call('GET', '/kb/learning', 'ag')).statusCode).toBe(403);
    expect((await call('GET', '/kb/learning/stats', 'ag')).statusCode).toBe(403);
  });

  it('1. a did-you-mean pick suggests the customer\'s wording; approved, the bot answers it directly next time', async () => {
    await say('9720001', 'היי');
    const sug = await say('9720001', 'האם אפשר לעבוד מעל 7 שלבים בסולם ללא היתר');
    expect(sug.join('\n')).toContain('א. באיזה גובה מותר לעבוד על סולם נייד');
    const ans = await say('9720001', 'א');
    expect(ans.join('\n')).toContain('עד גובה 2 מטר');
    const v = await pending('variant');
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ text: 'האם אפשר לעבוד מעל 7 שלבים בסולם ללא היתר', hits: 1 });
    // before approval the same question still only gets suggestions
    await say('9720002', 'היי');
    expect((await say('9720002', 'האם אפשר לעבוד מעל 7 שלבים בסולם ללא היתר')).join('\n')).toContain('האם התכוונתם');
    expect((await call('POST', `/kb/learning/${v[0]!.id}/approve`, 'adm', {})).json()).toMatchObject({ ok: true, sourceId: ladder });
    await mgr.kb!.idle();
    expect((await db.query('SELECT variants FROM kb_sources WHERE id = $1', [ladder])).rows[0].variants).toEqual(['האם אפשר לעבוד מעל 7 שלבים בסולם ללא היתר']);
    await say('9720003', 'היי');
    expect((await say('9720003', 'האם אפשר לעבוד מעל 7 שלבים בסולם ללא היתר')).join('\n')).toContain('עד גובה 2 מטר');   // learned
    expect((await call('POST', `/kb/learning/${v[0]!.id}/approve`, 'adm', {})).json()).toEqual({ error: 'not_pending' });
  });

  it('1b. optional: approved automatically once enough different customers picked the same entry', async () => {
    expect((await call('PUT', '/kb/learning/settings', 'adm', { enabled: true, autoVariants: true, autoAfter: 2 })).statusCode).toBe(200);
    for (const who of ['9720011', '9720012']) { await say(who, 'היי'); await say(who, 'כמה גבוה מותר לטפס על סולם'); await say(who, 'א'); }
    expect((await db.query('SELECT variants FROM kb_sources WHERE id = $1', [ladder])).rows[0].variants).toContain('כמה גבוה מותר לטפס על סולם');
    await call('PUT', '/kb/learning/settings', 'adm', { enabled: true, autoVariants: false, autoAfter: 3 });
  });

  it('2. a staff answer to a question the bot could not answer becomes a scrubbed draft FAQ; approved, the bot uses it', async () => {
    await say('9720021', 'היי');
    const q = 'מה עושים כשעובד נפגע בעין מכימיקל';
    await say('9720021', q);                                                            // nothing found
    const conv = await convOf('9720021');
    await db.query(`UPDATE conversations SET bot_state = 'human' WHERE id = $1`, [conv]);
    expect((await call('POST', `/conversations/${conv}/messages`, 'adm', { text: 'לשטוף מיד 15 דקות במים זורמים ולפנות לרופא. אפשר להתקשר אליי 050-765-4321.' })).statusCode).toBe(201);
    await new Promise((r) => setTimeout(r, 100));
    const d = await pending('faq_draft');
    expect(d).toHaveLength(1);
    expect(d[0]!.text).toBe(q);
    expect(d[0]!.answer).toBe('לשטוף מיד 15 דקות במים זורמים ולפנות לרופא. אפשר להתקשר אליי [טלפון/מספר].');
    // a second staff message is not another draft
    await call('POST', `/conversations/${conv}/messages`, 'adm', { text: 'ובנוסף לדווח לממונה הבטיחות בהקדם האפשרי.' });
    await new Promise((r) => setTimeout(r, 100));
    expect(await pending('faq_draft')).toHaveLength(1);
    const ok = (await call('POST', `/kb/learning/${d[0]!.id}/approve`, 'adm', { answer: 'לשטוף מיד 15 דקות במים זורמים ולפנות לרופא.' })).json();
    expect(ok.sourceId).toBeTruthy();
    await mgr.kb!.idle();
    await say('9720022', 'היי');
    expect((await say('9720022', q)).join('\n')).toContain('לשטוף מיד 15 דקות');
  });

  it('3. customers\' reactions on answers count; an answer marked unhelpful again and again is held back until reviewed', async () => {
    const react = (who: string, id: string, emoji: string) => mgr.customerReaction((Object.values({}) as string[])[0] ?? '', { externalContactId: who, targetMessageId: id, emoji });
    const ch = (await db.query(`SELECT id FROM channels LIMIT 1`)).rows[0].id as string;
    const ask = async (who: string) => { await say(who, 'היי'); await say(who, 'מה שעות הפעילות של היחידה'); return sent.find((x) => x.text.includes('8:00'))!; };
    void react;
    for (const who of ['9720031', '9720032', '9720033']) {
      const m = await ask(who);
      expect(m).toBeTruthy();
      expect(await mgr.customerReaction(ch, { externalContactId: who, targetMessageId: m.id, emoji: '👎' })).toBe('counted');
    }
    const fb = (await call('GET', '/kb/learning/feedback', 'adm')).json() as { title: string; up: number; down: number; flagged: boolean; id: string }[];
    expect(fb[0]).toMatchObject({ title: 'שעות הפעילות של היחידה', down: 3, up: 0, flagged: true });
    await say('9720034', 'היי');
    expect((await say('9720034', 'מה שעות הפעילות של היחידה')).join('\n')).not.toContain('8:00');   // held back (offered instead)
    expect((await call('POST', `/kb/learning/feedback/${fb[0]!.id}/reviewed`, 'adm', {})).statusCode).toBe(200);
    await say('9720035', 'היי');
    expect((await say('9720035', 'מה שעות הפעילות של היחידה')).join('\n')).toContain('8:00');
    // a reaction on a message that is not an answer, or a meaningless emoji, changes nothing; removing a reaction undoes it
    const m = await ask('9720036');
    expect(await mgr.customerReaction(ch, { externalContactId: '9720036', targetMessageId: m.id, emoji: '👍' })).toBe('counted');
    expect(await mgr.customerReaction(ch, { externalContactId: '9720036', targetMessageId: m.id, emoji: '' })).toBe('removed');
    expect(await mgr.customerReaction(ch, { externalContactId: '9720036', targetMessageId: 'nope', emoji: '👍' })).toBe('ignored');
    // the adapter event path: a reaction never starts the bot
    sent.length = 0;
    ctxA.events.onReaction?.({ externalContactId: '9720036', targetMessageId: m.id, emoji: '👍' });
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toEqual([]);
    expect((await db.query(`SELECT count(*)::int AS n FROM kb_answer_reactions WHERE positive`)).rows[0].n).toBe(1);
  });

  it('4. free text the menu did not understand, then an option: suggested as an example for that option; approved into the flow', async () => {
    expect((await call('PUT', '/flow', 'adm', { flow: { ...FLOW, nodes: [{ ...FLOW.nodes[0], kbOnFreeText: false }, FLOW.nodes[1]] } })).statusCode).toBe(200);
    await say('9720041', 'היי');
    await say('9720041', 'לזרוק בקבוקים של חומרים');
    await say('9720041', '1');
    const o = await pending('option_example');
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ node: 'menu', option: 'פינוי פסולת', text: 'לזרוק בקבוקים של חומרים' });
    expect((await call('POST', `/kb/learning/${o[0]!.id}/approve`, 'adm', {})).statusCode).toBe(200);
    const flow = (await db.query(`SELECT value FROM settings WHERE key = 'flow'`)).rows[0].value;
    expect(flow.nodes[0].options[0].examples).toEqual(['לזרוק בקבוקים של חומרים']);
  });

  it('rejected suggestions are not offered again; stats show the answered share', async () => {
    await say('9720051', 'היי');
    await say('9720051', 'משהו על לזרוק ציוד ישן');
    await say('9720051', '2');
    const o = (await pending('option_example')).find((x) => x.text === 'משהו על לזרוק ציוד ישן')!;
    expect((await call('POST', `/kb/learning/${o.id}/reject`, 'adm', {})).statusCode).toBe(200);
    await say('9720052', 'היי'); await say('9720052', 'משהו על לזרוק ציוד ישן'); await say('9720052', '2');
    expect((await pending('option_example')).some((x) => x.text === 'משהו על לזרוק ציוד ישן')).toBe(false);
    const st = (await call('GET', '/kb/learning/stats', 'adm')).json();
    expect(st.thisWeek).toBeGreaterThan(0);
    expect(typeof st.thisWeekRate).toBe('number');
  });
});

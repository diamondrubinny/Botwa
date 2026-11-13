import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { parseRating } from '../src/automations.js';
import { ChannelManager } from '../src/channels/manager.js';
import type { ChannelAdapter, AdapterContext } from '../src/channels/types.js';
import { hashPassword } from '../src/password.js';
import { DEFAULT_AUTOMATIONS, runAutomations, type AutoSender, type Automations } from '../src/automations.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { ingestInbound } from '../src/inbox.js';
import { migrate } from '../src/migrate.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test';
const db = createDb(DB_URL);
const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: DB_URL, ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: 'https://p.test', COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false' });

const sent: { to: string; text: string }[] = [];
let fail = false;
const out: AutoSender = {
  async sendText(_ch, to, text) { if (fail) throw new Error('channel_not_connected'); sent.push({ to, text }); return { externalMessageId: `x${sent.length}` }; },
  notifyMessage() {},
};
const setA = (a: Automations) => db.query(`INSERT INTO settings (key, value) VALUES ('automations', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(a)]);
const ago = (min: number) => new Date(Date.now() - min * 60_000);
let ch = '';
let n = 0;
async function conv(name: string, opts: { inAgo?: number; outAgo?: number; bot?: boolean; contact?: string } = {}) {
  const ext = opts.contact ?? `9725000${String(++n).padStart(5, '0')}@s.whatsapp.net`;
  await ingestInbound(db, ch, { externalContactId: ext, contactName: name, externalMessageId: `in-${n}`, text: 'שאלה', timestamp: ago(opts.inAgo ?? 300) });
  const id = (await db.query(`SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.external_id = $1`, [ext])).rows[0].id as string;
  await db.query(`UPDATE messages SET created_at = $2 WHERE conversation_id = $1`, [id, ago(opts.inAgo ?? 300)]);
  if (opts.outAgo !== undefined) await db.query(`INSERT INTO messages (conversation_id, direction, body, auto, created_at) VALUES ($1, 'out', 'תשובה', $2, $3)`, [id, !!opts.bot, ago(opts.outAgo)]);
  return { id, ext };
}
const status = async (id: string) => (await db.query('SELECT status FROM conversations WHERE id = $1', [id])).rows[0].status as string;
const autoKinds = async (id: string) => (await db.query(`SELECT automation FROM messages WHERE conversation_id = $1 AND automation IS NOT NULL ORDER BY created_at`, [id])).rows.map((r) => r.automation);

describe('conversation automations', () => {
  beforeAll(async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    ch = (await db.query(`INSERT INTO channels (type, label) VALUES ('whatsapp', 'WA') RETURNING id`)).rows[0].id;
  });
  afterAll(async () => { await app?.close(); await db.end(); });

  it('does nothing while switched off (the default)', async () => {
    const c = await conv('דנה', { inAgo: 500, outAgo: 400 });
    expect(await runAutomations(db, out)).toEqual({ reminded: 0, closed: 0, held: 0 });
    expect(await status(c.id)).toBe('open');
    await db.query('DELETE FROM conversations');
  });

  it('customer silent: one reminder after the wait, then closes with a message; a reply in between cancels it', async () => {
    await setA({ ...DEFAULT_AUTOMATIONS, idle: { ...DEFAULT_AUTOMATIONS.idle, enabled: true, reminderAfter: 60, closeAfter: 120 } });
    const quiet = await conv('דנה', { inAgo: 300, outAgo: 90 });       // we answered 90 min ago, no reply
    const early = await conv('רון', { inAgo: 300, outAgo: 30 });       // only 30 min: nothing yet
    const answered = await conv('נועה', { inAgo: 10, outAgo: 90 });     // the customer wrote after us: their turn is over
    sent.length = 0;
    expect(await runAutomations(db, out)).toMatchObject({ reminded: 1, closed: 0 });
    expect(sent[0]).toMatchObject({ to: quiet.ext });
    expect(sent[0]!.text).toContain('היי דנה');                           // {שם} filled in
    expect(await runAutomations(db, out)).toMatchObject({ reminded: 0 }); // one reminder per wait
    // 2 more hours pass after the reminder: closed with the closing message and a note
    await db.query(`UPDATE messages SET created_at = created_at - interval '121 minutes' WHERE conversation_id = $1`, [quiet.id]);
    expect(await runAutomations(db, out)).toMatchObject({ closed: 1 });
    expect(await status(quiet.id)).toBe('closed');
    expect(await autoKinds(quiet.id)).toEqual(['idle_reminder', 'idle_close']);
    expect((await db.query(`SELECT body FROM conversation_notes WHERE conversation_id = $1`, [quiet.id])).rows[0].body).toContain('גם אחרי תזכורת');
    expect(await status(early.id)).toBe('open');
    expect(await status(answered.id)).toBe('open');
    // the customer writes again: the conversation reopens (as before) and the timers start over
    await ingestInbound(db, ch, { externalContactId: quiet.ext, contactName: 'דנה', externalMessageId: 'back-1', text: 'חזרתי', timestamp: new Date() });
    expect(await status(quiet.id)).toBe('open');
    await db.query('DELETE FROM conversations');
  });

  it('never writes to blocked or opted-out customers, or comment threads; still closes them quietly when the time is up', async () => {
    const blocked = await conv('חסום', { inAgo: 600, outAgo: 400 });
    await db.query(`UPDATE contacts SET blocked = true WHERE external_id = $1`, [blocked.ext]);
    const comment = await conv('מגיב', { inAgo: 600, outAgo: 400, contact: '8880001@fbcomment' });
    sent.length = 0;
    await runAutomations(db, out);
    expect(sent).toHaveLength(0);
    expect(await status(blocked.id)).toBe('closed');            // reminder impossible, full time passed: closed without a message
    expect(await status(comment.id)).toBe('open');              // comment threads are left to people
    await db.query('DELETE FROM conversations');
  });

  it('a bot question left unanswered counts as our turn too; without a reminder it closes directly', async () => {
    await setA({ ...DEFAULT_AUTOMATIONS, idle: { ...DEFAULT_AUTOMATIONS.idle, enabled: true, reminderAfter: 0, closeAfter: 60, closeText: '' } });
    const c = await conv('בוט', { inAgo: 200, outAgo: 70, bot: true });
    sent.length = 0;
    expect(await runAutomations(db, out)).toMatchObject({ closed: 1 });
    expect(sent).toHaveLength(0);                                // empty closing text: closed silently
    expect(await status(c.id)).toBe('closed');
    await db.query('DELETE FROM conversations');
  });

  it('holding message: once per wait when nobody answered, not while the bot handles it', async () => {
    await setA({ ...DEFAULT_AUTOMATIONS, holding: { enabled: true, after: 10, text: 'קיבלנו, {שם}' } });
    const waiting = await conv('מחכה', { inAgo: 15 });
    const fresh = await conv('חדש', { inAgo: 3 });
    const menu = await conv('בתפריט', { inAgo: 30 });
    await db.query(`UPDATE conversations SET bot_state = 'menu' WHERE id = $1`, [menu.id]);
    sent.length = 0;
    expect(await runAutomations(db, out)).toMatchObject({ held: 1 });
    expect(sent).toEqual([{ to: waiting.ext, text: 'קיבלנו, מחכה' }]);
    expect(await runAutomations(db, out)).toMatchObject({ held: 0 });   // once per wait
    expect(await autoKinds(fresh.id)).toEqual([]);
    // a channel that is down: nothing recorded, tried again next time
    fail = true;
    await db.query(`UPDATE messages SET created_at = $2 WHERE conversation_id = $1`, [fresh.id, ago(20)]);
    expect(await runAutomations(db, out)).toMatchObject({ held: 0 });
    fail = false;
    expect(await runAutomations(db, out)).toMatchObject({ held: 1 });
  });

  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  it('closing by a person: the closing message goes out only when chosen; agents can read its text', async () => {
    const texts: string[] = [];
    class Fake implements ChannelAdapter {
      constructor(private ctx: AdapterContext) {}
      async start() { this.ctx.events.onStatus('connected'); }
      async stop() {}
      async logout() {}
      async sendText(_to: string, t: string) { texts.push(t); return { externalMessageId: `c${texts.length}` }; }
    }
    const mgr = new ChannelManager(db, cfg, (_t, ctx) => new Fake(ctx));
    app = await buildApp(cfg, db, mgr);
    await mgr.start(ch);
    await db.query(`INSERT INTO users (email,name,role,password_hash) VALUES ('ag@t.io','סיגל','agent',$1)`, [await hashPassword('correct-horse-battery')]);
    const ck = `botwa_sid=${(await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'ag@t.io', password: 'correct-horse-battery' }, remoteAddress: '10.99.0.1', headers: { origin: 'https://p.test' } })).cookies[0]!.value}`;
    const call = (url: string, payload?: object) => app!.inject({ method: payload ? 'POST' : 'GET', url, payload, remoteAddress: '10.99.0.2', headers: { origin: 'https://p.test', cookie: ck } });
    await setA({ ...DEFAULT_AUTOMATIONS, closing: { defaultOn: true, text: 'תודה {שם}, {נציג} כאן' } });
    expect((await call('/automations/closing')).json()).toEqual({ defaultOn: true, text: 'תודה {שם}, {נציג} כאן' });
    const a1 = await conv('ליאת', { inAgo: 5 });
    await db.query('UPDATE conversations SET assigned_to = (SELECT id FROM users WHERE email = $2) WHERE id = $1', [a1.id, 'ag@t.io']);
    expect((await call(`/conversations/${a1.id}/status`, { status: 'closed', closingMessage: true })).json()).toEqual({ ok: true, closingSent: true });
    expect(texts).toEqual(['תודה ליאת, סיגל כאן']);
    expect(await autoKinds(a1.id)).toEqual(['closing']);
    const a2 = await conv('עומר', { inAgo: 5 });
    expect((await call(`/conversations/${a2.id}/status`, { status: 'closed' })).json()).toEqual({ ok: true });
    expect(texts).toHaveLength(1);
    expect(await status(a2.id)).toBe('closed');
  });

  it('every inquiry is a case: opened by the customer, closed by a person or an automation, reopened as a new case', async () => {
    await db.query('DELETE FROM conversations');
    await setA({ ...DEFAULT_AUTOMATIONS, idle: { ...DEFAULT_AUTOMATIONS.idle, enabled: true, reminderAfter: 0, closeAfter: 30, closeText: '' } });
    const c = await conv('יעל', { inAgo: 100, outAgo: 60 });
    let cases = (await db.query('SELECT * FROM cases WHERE conversation_id = $1 ORDER BY opened_at', [c.id])).rows;
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ closed_at: null, first_message: 'שאלה' });
    await runAutomations(db, out);                                   // closed by the automation
    cases = (await db.query('SELECT * FROM cases WHERE conversation_id = $1 ORDER BY opened_at', [c.id])).rows;
    expect(cases[0]).toMatchObject({ close_kind: 'auto' });
    expect(cases[0].closed_at).not.toBeNull();
    await ingestInbound(db, ch, { externalContactId: c.ext, contactName: 'יעל', externalMessageId: 'again-1', text: 'יש לי שאלה חדשה על לייזר', timestamp: new Date() });
    cases = (await db.query('SELECT * FROM cases WHERE conversation_id = $1 ORDER BY opened_at', [c.id])).rows;
    expect(cases).toHaveLength(2);
    expect(cases[1]).toMatchObject({ closed_at: null, first_message: 'יש לי שאלה חדשה על לייזר' });
    expect(Number(cases[1].number)).toBeGreaterThan(Number(cases[0].number));
    await setA(DEFAULT_AUTOMATIONS);
  });

  it('reads a rating from a digit or stars only', () => {
    expect(parseRating('5')).toBe(5);
    expect(parseRating(' 3 ')).toBe(3);
    expect(parseRating('⭐⭐⭐⭐')).toBe(4);
    expect(parseRating('6')).toBeNull();
    expect(parseRating('5 שעות')).toBeNull();
    expect(parseRating('תודה')).toBeNull();
  });

  it('feedback after a person closes: the question goes out, a digit is stored on that case and does not reopen; anything else does', async () => {
    await setA({ ...DEFAULT_AUTOMATIONS, feedback: { enabled: true, question: 'איך היה? 1-5', thanks: 'תודה!', afterAuto: false } });
    const texts: string[] = [];
    const ck = `botwa_sid=${(await app!.inject({ method: 'POST', url: '/auth/login', payload: { email: 'ag@t.io', password: 'correct-horse-battery' }, remoteAddress: '10.99.0.3', headers: { origin: 'https://p.test' } })).cookies[0]!.value}`;
    const call = (url: string, payload?: object) => app!.inject({ method: payload ? 'POST' : 'GET', url, payload, remoteAddress: '10.99.0.4', headers: { origin: 'https://p.test', cookie: ck } });
    void texts;
    const c = await conv('מיכל', { inAgo: 5 });
    await db.query('UPDATE conversations SET assigned_to = (SELECT id FROM users WHERE email = $2) WHERE id = $1', [c.id, 'ag@t.io']);
    await call(`/conversations/${c.id}/status`, { status: 'closed' });
    expect(await autoKinds(c.id)).toEqual(['feedback']);
    const kase = (await db.query('SELECT id, close_kind, closed_by FROM cases WHERE conversation_id = $1', [c.id])).rows[0];
    expect(kase.close_kind).toBe('staff');
    expect(kase.closed_by).not.toBeNull();
    // the manager's own inbound path (rating -> thanks, stays closed)
    const mgrAny = (app as unknown as { mgrForTests?: unknown });
    void mgrAny;
    const r = await ingestInbound(db, ch, { externalContactId: c.ext, contactName: 'מיכל', externalMessageId: 'rate-1', text: '5', timestamp: new Date() });
    expect(r.rated).toBe(5);
    expect(await status(c.id)).toBe('closed');
    expect((await db.query('SELECT rating FROM cases WHERE id = $1', [kase.id])).rows[0].rating).toBe(5);
    expect((await db.query('SELECT count(*)::int AS n FROM cases WHERE conversation_id = $1', [c.id])).rows[0].n).toBe(1);   // no new case
    // a second "5" is an ordinary message (one answer per question): it reopens as a new inquiry
    const r2 = await ingestInbound(db, ch, { externalContactId: c.ext, contactName: 'מיכל', externalMessageId: 'rate-2', text: '5', timestamp: new Date() });
    expect(r2.rated).toBeNull();
    expect(await status(c.id)).toBe('open');
    // the history: both inquiries, newest first, with the rating
    const hist = (await call(`/conversations/${c.id}/cases`)).json();
    expect(hist).toHaveLength(2);
    expect(hist[1]).toMatchObject({ rating: 5, closeKind: 'staff', closedByName: 'סיגל' });
    const msgs = (await call(`/cases/${hist[1].id}/messages`)).json();
    expect(msgs.map((m: { body: string }) => m.body)).toContain('שאלה');
    await setA(DEFAULT_AUTOMATIONS);
  });
});

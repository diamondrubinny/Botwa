import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { DEFAULT_BOT } from '../src/bot.js';
import { DEFAULT_HOURS } from '../src/business-hours.js';
import { ChannelManager } from '../src/channels/manager.js';
import { ChannelSender, DEFAULT_SENDING, type SendingSettings } from '../src/channels/sender.js';
import type { AdapterContext, AdapterFactory, ChannelAdapter } from '../src/channels/types.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { isStopMessage } from '../src/optout.js';
import { hashPassword } from '../src/password.js';
import { assessRisk } from '../src/routes/channels.js';

const ORIGIN = 'https://panel.test';
const PW = 'correct-horse-battery';
const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test';
const db = createDb(DB_URL);
const hookBodies: Record<string, unknown>[] = [];
const hook = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { hookBodies.push(JSON.parse(b)); res.end('ok'); }); });

describe('stop-word detection', () => {
  it('matches only whole "stop" messages', () => {
    for (const t of ['STOP', 'stop.', 'הסר', ' "הפסק"! ', 'הסר אותי', 'Unsubscribe']) expect(isStopMessage(t), t).toBe(true);
    for (const t of ['please stop the delivery', 'לא להסיר', 'מה זה הסרה?', '1', '', null, undefined]) expect(isStopMessage(t as string), String(t)).toBe(false);
  });
});

describe('risk assessment (advisory)', () => {
  const base = { status: 'connected', day: 5, cap: 500, inbound24h: 20, ageDays: 30, recentAutoPauses: 0 };
  it('low for normal use, escalates with the signals platforms care about', () => {
    expect(assessRisk(base)).toEqual({ level: 'low', reasons: [] });
    expect(assessRisk({ ...base, day: 450 }).level).toBe('medium');
    expect(assessRisk({ ...base, day: 450, inbound24h: 2, recentAutoPauses: 1 }).level).toBe('high');
    expect(assessRisk({ ...base, status: 'restricted' })).toMatchObject({ level: 'high', reasons: ['restricted'] });
    expect(assessRisk({ ...base, ageDays: 1, day: 18, cap: 60 }).reasons).toContain('new_number_busy');
  });
});

describe('cool-down after repeated failures (unit)', () => {
  it('pauses after N consecutive failures without calling the platform, resumes later; success resets the counter', async () => {
    const ch = (await db.query(`INSERT INTO channels (type, label) VALUES ('whatsapp','cd') RETURNING id`)).rows[0].id;
    let t = 5_000_000;
    const sender = new ChannelSender(db, () => t, async (ms) => { t += ms; });
    const pauses: number[] = [];
    sender.onAutoPause = (_c, _u, n) => pauses.push(n);
    const S: SendingSettings = { ...DEFAULT_SENDING, minDelayMs: 0, maxDelayMs: 0, perMinute: 120, warmup: false, failuresBeforePause: 2, pauseMinutes: 10 };
    const fail = async () => { throw new Error('platform said no'); };
    let calls = 0;
    const ok = async () => { calls++; return 'sent'; };

    await expect(sender.run(ch, S, fail)).rejects.toThrow('platform said no');
    await expect(sender.run(ch, S, ok)).resolves.toBe('sent');            // success resets the streak
    await expect(sender.run(ch, S, fail)).rejects.toThrow();
    await expect(sender.run(ch, S, fail)).rejects.toThrow();              // 2nd in a row -> pause
    expect(pauses).toEqual([2]);
    calls = 0;
    await expect(sender.run(ch, S, ok)).rejects.toMatchObject({ code: 'channel_paused' });
    expect(calls).toBe(0);                                                 // nothing reached the platform
    t += 11 * 60_000;
    await expect(sender.run(ch, S, ok)).resolves.toBe('sent');
  });
});

describe('policies through the API', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let mgr: ChannelManager;
  let ctx: AdapterContext;
  const sent: string[] = [];
  const reads: { to: string; ids: string[] }[] = [];
  let failSends = false;
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let ip = 0;
  let channelId = '';

  class Fake implements ChannelAdapter {
    constructor(c: AdapterContext) { ctx = c; }
    async start() { ctx.events.onStatus('connected'); }
    async stop() {}
    async logout() {}
    async sendText(_t: string, text: string) { if (failSends) throw new Error('rejected'); sent.push(text); return { externalMessageId: `o${sent.length}-${Math.random()}` }; }
    async markRead(to: string, i: string[]) { reads.push({ to, ids: i }); }
  }
  const factory: AdapterFactory = (t, c) => (t === 'whatsapp' ? new Fake(c) : null);
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, who?: string, payload?: object) =>
    app.inject({ method, url, payload, remoteAddress: `10.60.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, ...(who ? { cookie: cookies[who]! } : {}) } });
  let mid = 0;
  const inbound = (who: string, text = 'hello') => ctx.events.onMessage({ externalContactId: who, externalMessageId: `in${++mid}`, text, timestamp: new Date() });
  const convOf = async (who: string) => (await db.query(`SELECT c.* FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE ct.external_id=$1`, [who])).rows[0];
  const contactOf = async (who: string) => (await db.query('SELECT * FROM contacts WHERE external_id=$1', [who])).rows[0];
  const setSending = (patch: Partial<SendingSettings>) => call('PUT', '/settings/sending', 'admin@t.io', { ...DEFAULT_SENDING, minDelayMs: 0, maxDelayMs: 0, perDay: 5000, warmup: false, typing: false, ...patch });

  beforeAll(async () => {
    await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()));
    const cfg = loadConfig({
      NODE_ENV: 'test', DATABASE_URL: DB_URL, ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false',
      REQUIRE_MFA_FOR_PRIVILEGED: 'false', ALERT_WEBHOOK_URL: `http://127.0.0.1:${(hook.address() as { port: number }).port}/h`,
    });
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    mgr = new ChannelManager(db, cfg, factory);
    app = await buildApp(cfg, db, mgr);
    for (const [e, r] of [['admin', 'admin'], ['sup', 'supervisor'], ['a1', 'agent']] as const) {
      const u = await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4) RETURNING id', [`${e}@t.io`, e, r, await hashPassword(PW)]);
      ids[e] = u.rows[0].id;
      const res = await call('POST', '/auth/login', undefined, { email: `${e}@t.io`, password: PW });
      cookies[`${e}@t.io`] = `botwa_sid=${res.cookies[0]!.value}`;
    }
    channelId = (await call('POST', '/channels', 'admin@t.io', { type: 'whatsapp', label: 'WA' })).json().id;
    await call('POST', `/channels/${channelId}/start`, 'admin@t.io');
    await new Promise((r) => setTimeout(r, 40));
    await setSending({});
  });
  afterAll(async () => { await mgr.stopAll(); await app.close(); await db.end(); hook.close(); });

  it('reply window: staff cannot write to a customer who has not messaged recently; new message reopens the window; 0 disables', async () => {
    await inbound('old1');
    const conv = (await convOf('old1')).id;
    await call('POST', `/conversations/${conv}/assign`, 'admin@t.io', { userId: ids.a1 });
    await db.query(`UPDATE messages SET created_at = now() - interval '9 days' WHERE conversation_id = $1`, [conv]);
    const refused = await call('POST', `/conversations/${conv}/messages`, 'a1@t.io', { text: 'hello?' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: 'outside_reply_window' });
    expect(sent).not.toContain('hello?');
    await inbound('old1', 'I am back');
    expect((await call('POST', `/conversations/${conv}/messages`, 'a1@t.io', { text: 'welcome back' })).statusCode).toBe(201);
    await db.query(`UPDATE messages SET created_at = now() - interval '30 days' WHERE conversation_id = $1`, [conv]);
    await setSending({ replyWindowHours: 0 });
    expect((await call('POST', `/conversations/${conv}/messages`, 'a1@t.io', { text: 'ok anyway' })).statusCode).toBe(201);
    await setSending({});
  });

  it('opt-out: "הסר" silences bot, away reply and staff; writing again restores; manager can opt the customer back in', async () => {
    await call('PUT', '/settings/bot', 'admin@t.io', { ...DEFAULT_BOT, enabled: true });
    await call('PUT', '/settings/business-hours', 'admin@t.io', { ...DEFAULT_HOURS, enabled: true, days: Array(7).fill(null), awayMessage: 'closed' });
    sent.length = 0;
    await inbound('stop1', 'שלום');                       // bot greets (menu)
    expect(sent.length).toBe(1);
    sent.length = 0;
    await inbound('stop1', 'הסר');
    expect(sent).toEqual([]);                              // no bot reply, no away reply
    expect((await contactOf('stop1')).opted_out).toBe(true);
    const conv = await convOf('stop1');
    expect((await db.query('SELECT body FROM conversation_notes WHERE conversation_id=$1', [conv.id])).rows.map((r) => r.body).join()).toContain('להפסיק לקבל הודעות');
    const list = (await call('GET', '/conversations', 'sup@t.io')).json().find((c: { id: string }) => c.id === conv.id);
    expect(list.optedOut).toBe(true);

    expect((await call('POST', `/conversations/${conv.id}/messages`, 'sup@t.io', { text: 'but wait' })).json()).toEqual({ error: 'contact_opted_out' });
    expect((await call('POST', `/contacts/${(await contactOf('stop1')).id}/opt-in`, 'a1@t.io')).statusCode).toBe(403);
    expect((await call('POST', `/contacts/${(await contactOf('stop1')).id}/opt-in`, 'sup@t.io')).statusCode).toBe(200);
    expect((await contactOf('stop1')).opted_out).toBe(false);

    await inbound('stop1', 'stop');
    expect((await contactOf('stop1')).opted_out).toBe(true);
    await inbound('stop1', 'actually I have a question');  // customer wrote again -> welcome again
    expect((await contactOf('stop1')).opted_out).toBe(false);
    await inbound('stop2', 'please stop the delivery');     // not a stop-word message
    expect((await contactOf('stop2')).opted_out).toBe(false);

    await call('PUT', '/settings/bot', 'admin@t.io', { ...DEFAULT_BOT, enabled: false });
    await call('PUT', '/settings/business-hours', 'admin@t.io', { ...DEFAULT_HOURS, enabled: false });
  });

  it('manual pause: supervisor can pause/resume; sends are refused, incoming still stored; resume restores', async () => {
    expect((await call('POST', `/channels/${channelId}/pause`, 'a1@t.io')).statusCode).toBe(403);
    expect((await call('POST', `/channels/${channelId}/pause`, 'sup@t.io')).statusCode).toBe(200);
    await inbound('pz1', 'hi');
    const conv = (await convOf('pz1')).id;
    await call('POST', `/conversations/${conv}/assign`, 'admin@t.io', { userId: ids.a1 });
    const r = await call('POST', `/conversations/${conv}/messages`, 'a1@t.io', { text: 'x' });
    expect(r.statusCode).toBe(429);
    expect(r.json()).toEqual({ error: 'channel_paused' });
    expect((await db.query(`SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1 AND direction='in'`, [conv])).rows[0].n).toBe(1);
    const h = (await call('GET', '/channels/health', 'sup@t.io')).json().find((c: { id: string }) => c.id === channelId);
    expect(h.paused).toBe(true);
    expect((await call('POST', `/channels/${channelId}/resume`, 'sup@t.io')).statusCode).toBe(200);
    expect((await call('POST', `/conversations/${conv}/messages`, 'a1@t.io', { text: 'back' })).statusCode).toBe(201);
    expect((await db.query(`SELECT action FROM audit_log WHERE action IN ('channel.pause','channel.resume') ORDER BY id`)).rows.map((x) => x.action)).toEqual(['channel.pause', 'channel.resume']);
  });

  it('automatic pause after repeated platform failures: event, audit, alert; health shows it; no further attempts', async () => {
    hookBodies.length = 0;
    await inbound('fail1', 'hi');
    const conv = (await convOf('fail1')).id;
    await call('POST', `/conversations/${conv}/assign`, 'admin@t.io', { userId: ids.a1 });
    failSends = true;
    for (let i = 0; i < 3; i++) expect((await call('POST', `/conversations/${conv}/messages`, 'a1@t.io', { text: `t${i}` })).statusCode).toBe(502);
    const after = await call('POST', `/conversations/${conv}/messages`, 'a1@t.io', { text: 'again' });
    expect(after.statusCode).toBe(429);
    expect(after.json()).toEqual({ error: 'channel_paused' });
    failSends = false;
    await new Promise((r) => setTimeout(r, 150));
    expect((await db.query(`SELECT kind FROM channel_events WHERE channel_id=$1 AND kind='auto_paused'`, [channelId])).rowCount).toBe(1);
    expect(hookBodies.some((b) => String(b.text).includes('הושהה אוטומטית'))).toBe(true);
    const h = (await call('GET', '/channels/health', 'sup@t.io')).json().find((c: { id: string }) => c.id === channelId);
    expect(h.autoPausedUntil).not.toBeNull();
    expect(h.risk.reasons).toContain('auto_paused_recently');
    mgr['sender'].resume(channelId);
  });

  it('read receipts: sent once when staff open a conversation; switchable', async () => {
    await inbound('rd1', 'one');
    await inbound('rd1', 'two');
    const conv = (await convOf('rd1')).id;
    reads.length = 0;
    expect((await call('POST', `/conversations/${conv}/read`, 'sup@t.io')).statusCode).toBe(200);
    expect(reads).toHaveLength(1);
    expect(reads[0]!.to).toBe('rd1');
    expect(reads[0]!.ids).toHaveLength(2);
    await call('POST', `/conversations/${conv}/read`, 'sup@t.io');
    expect(reads).toHaveLength(1);                                   // not re-sent
    await setSending({ readReceipts: false });
    await inbound('rd1', 'three');
    await call('POST', `/conversations/${conv}/read`, 'sup@t.io');
    expect(reads).toHaveLength(1);
    await setSending({});
  });

  it('settings accept and persist the new fields; old stored settings (without them) still load with defaults', async () => {
    const got = (await call('GET', '/settings/sending', 'sup@t.io')).json();
    expect(got).toMatchObject({ replyWindowHours: 168, failuresBeforePause: 3, pauseMinutes: 15, readReceipts: true });
    await db.query(`UPDATE settings SET value = '{"minDelayMs":100,"maxDelayMs":200,"perMinute":5,"perDay":50,"warmup":false,"typing":false}'::jsonb WHERE key='sending'`);
    expect((await call('GET', '/settings/sending', 'sup@t.io')).json()).toMatchObject({ perDay: 50, replyWindowHours: 168, readReceipts: true });
    expect((await call('PUT', '/settings/sending', 'admin@t.io', { ...DEFAULT_SENDING, replyWindowHours: 5000 })).statusCode).toBe(400);
    await setSending({});
  });
});

import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { DEFAULT_HOURS, isOpen, type BusinessHours } from '../src/business-hours.js';
import { ChannelManager } from '../src/channels/manager.js';
import type { AdapterContext, AdapterFactory, ChannelAdapter } from '../src/channels/types.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';

const ORIGIN = 'https://panel.test';
const PW = 'correct-horse-battery';
const cfg = loadConfig({
  NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test',
  ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false',
});
const db = createDb(cfg.DATABASE_URL);

describe('business hours', () => {
  const h: BusinessHours = { ...DEFAULT_HOURS, enabled: true };
  it('evaluates in the configured time zone (Sun-Thu 09-17, Fri/Sat closed)', () => {
    // winter (IST, UTC+2) – Sun 2026-11-01
    expect(isOpen(h, new Date('2026-11-01T07:00:00Z'))).toBe(true);  // 09:00 open (start inclusive)
    expect(isOpen(h, new Date('2026-11-01T06:30:00Z'))).toBe(false); // 08:30
    expect(isOpen(h, new Date('2026-11-01T15:00:00Z'))).toBe(false); // 17:00 closed (end exclusive)
    expect(isOpen(h, new Date('2026-11-06T10:00:00Z'))).toBe(false); // Friday
    // summer (IDT, UTC+3): the same UTC instant means a different local time
    expect(isOpen(h, new Date('2026-07-05T06:30:00Z'))).toBe(true);  // 09:30 local
    expect(isOpen({ ...h, timezone: 'UTC' }, new Date('2026-11-01T05:30:00Z'))).toBe(false);
    expect(isOpen({ ...h, timezone: 'UTC' }, new Date('2026-11-01T10:00:00Z'))).toBe(true);
  });
});

describe('tags, settings, audit, away reply, waiting time', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let mgr: ChannelManager;
  let ctxRef: AdapterContext;
  const sent: string[] = [];
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let ip = 0;
  let channelId = '';

  class Fake implements ChannelAdapter {
    constructor(ctx: AdapterContext) { ctxRef = ctx; }
    async start() { ctxRef.events.onStatus('connected'); }
    async stop() {}
    async logout() {}
    async sendText(_to: string, text: string) { sent.push(text); return { externalMessageId: `o${sent.length}` }; }
  }
  const factory: AdapterFactory = (t, ctx) => (t === 'whatsapp' ? new Fake(ctx) : null);
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, who?: string, payload?: object) =>
    app.inject({ method, url, payload, remoteAddress: `10.20.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, ...(who ? { cookie: cookies[who]! } : {}) } });
  const inbound = (ext: string, id: string, text = 'שלום') =>
    ctxRef.events.onMessage({ externalContactId: ext, contactName: ext, externalMessageId: id, text, timestamp: new Date() });
  const convOf = async (ext: string) => (await db.query(`SELECT c.id FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE ct.external_id=$1`, [ext])).rows[0].id as string;

  const closedAllWeek = (extra: Partial<BusinessHours> = {}): BusinessHours => ({ ...DEFAULT_HOURS, enabled: true, days: Array(7).fill(null), awayMessage: 'מחוץ לשעות', ...extra });

  beforeAll(async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    mgr = new ChannelManager(db, cfg, factory);
    app = await buildApp(cfg, db, mgr);
    for (const [e, r] of [['admin', 'admin'], ['sup', 'supervisor'], ['a1', 'agent'], ['a2', 'agent']] as const) {
      const u = await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4) RETURNING id', [`${e}@t.io`, e, r, await hashPassword(PW)]);
      ids[e] = u.rows[0].id;
      const res = await call('POST', '/auth/login', undefined, { email: `${e}@t.io`, password: PW });
      cookies[`${e}@t.io`] = `botwa_sid=${res.cookies[0]!.value}`;
    }
    channelId = (await call('POST', '/channels', 'admin@t.io', { type: 'whatsapp', label: 'WA' })).json().id;
    await call('POST', `/channels/${channelId}/start`, 'admin@t.io');
    await new Promise((r) => setTimeout(r, 50));
  });
  afterAll(async () => { await mgr.stopAll(); await app.close(); await db.end(); });

  it('settings: only admin writes, supervisor reads, input validated', async () => {
    expect((await call('GET', '/settings/business-hours', 'a1@t.io')).statusCode).toBe(403);
    expect((await call('GET', '/settings/business-hours', 'sup@t.io')).json()).toMatchObject({ enabled: false });
    expect((await call('PUT', '/settings/business-hours', 'sup@t.io', closedAllWeek())).statusCode).toBe(403);
    expect((await call('PUT', '/settings/business-hours', 'admin@t.io', closedAllWeek({ timezone: 'Mars/Base' }))).statusCode).toBe(400);
    expect((await call('PUT', '/settings/business-hours', 'admin@t.io', closedAllWeek({ days: [null] }))).statusCode).toBe(400);
    expect((await call('PUT', '/settings/business-hours', 'admin@t.io', { ...closedAllWeek(), days: Array(7).fill({ open: '9:00', close: '17:00' }) })).statusCode).toBe(400);
    expect((await call('PUT', '/settings/business-hours', 'admin@t.io', closedAllWeek({ enabled: false }))).statusCode).toBe(200);
  });

  it('away reply: only when closed, once per 12h, marked auto, never counted as a human reply', async () => {
    await inbound('c1', 'a1', 'hello');
    expect(sent).toHaveLength(0); // feature disabled
    await call('PUT', '/settings/business-hours', 'admin@t.io', closedAllWeek());
    await inbound('c2', 'b1', 'hello');
    expect(sent).toEqual(['מחוץ לשעות']);
    await inbound('c2', 'b2', 'anyone?');
    expect(sent).toHaveLength(1); // not repeated within 12h
    const conv = await convOf('c2');
    const msgs = (await call('GET', `/conversations/${conv}/messages`, 'sup@t.io')).json();
    expect(msgs.filter((m: { auto: boolean }) => m.auto)).toHaveLength(1);
    const list = (await call('GET', '/conversations', 'sup@t.io')).json();
    expect(list.find((c: { id: string }) => c.id === conv).waitingSince).not.toBeNull(); // still waiting for a human

    // 12h later a new message triggers it again
    await db.query(`UPDATE conversations SET last_away_at = now() - interval '13 hours' WHERE id = $1`, [conv]);
    await inbound('c2', 'b3', 'hello again');
    expect(sent).toHaveLength(2);

    const rep = (await call('GET', '/reports/summary?days=7', 'sup@t.io')).json();
    expect(rep.responseTime.answered).toBe(0);   // auto replies do not answer anyone
    expect(rep.responseTime.unanswered).toBeGreaterThanOrEqual(1);

    await call('PUT', '/settings/business-hours', 'admin@t.io', closedAllWeek({ enabled: false }));
  });

  it('waiting time: set while the customer awaits a reply, cleared after staff answer', async () => {
    await inbound('c3', 'w1', 'help');
    const conv = await convOf('c3');
    const wait = async () => (await call('GET', '/conversations', 'sup@t.io')).json().find((c: { id: string }) => c.id === conv).waitingSince;
    expect(await wait()).not.toBeNull();
    expect((await call('POST', `/conversations/${conv}/messages`, 'a1@t.io', { text: 'on it' })).statusCode).toBe(201);
    expect(await wait()).toBeNull();
  });

  it('tags: curated by supervisors, applied by staff with access, filterable, case-insensitive unique', async () => {
    expect((await call('POST', '/tags', 'a1@t.io', { name: 'x' })).statusCode).toBe(403);
    const vip = (await call('POST', '/tags', 'sup@t.io', { name: 'VIP' })).json();
    expect((await call('POST', '/tags', 'sup@t.io', { name: 'vip' })).statusCode).toBe(409);
    const bug = (await call('POST', '/tags', 'sup@t.io', { name: 'תקלה' })).json();
    expect((await call('GET', '/tags', 'a2@t.io')).json()).toHaveLength(2);

    const conv = await convOf('c3'); // assigned to a1 by replying
    expect((await call('POST', `/conversations/${conv}/tags`, 'a2@t.io', { tagId: vip.id })).statusCode).toBe(404); // no access
    expect((await call('POST', `/conversations/${conv}/tags`, 'a1@t.io', { tagId: vip.id })).statusCode).toBe(200);
    expect((await call('POST', `/conversations/${conv}/tags`, 'a1@t.io', { tagId: vip.id })).statusCode).toBe(200); // idempotent
    expect((await call('POST', `/conversations/${conv}/tags`, 'a1@t.io', { tagId: '00000000-0000-4000-8000-000000000000' })).statusCode).toBe(400);

    const tagged = (await call('GET', `/conversations?tag=${vip.id}`, 'sup@t.io')).json();
    expect(tagged).toHaveLength(1);
    expect(tagged[0].tags).toEqual([{ id: vip.id, name: 'VIP' }]);
    expect((await call('GET', `/conversations?tag=${bug.id}`, 'sup@t.io')).json()).toHaveLength(0);
    expect((await call('GET', `/conversations?tag=${vip.id}`, 'a2@t.io')).json()).toHaveLength(0); // a2 may not see it

    expect((await call('DELETE', `/conversations/${conv}/tags/${vip.id}`, 'a2@t.io')).statusCode).toBe(404);
    expect((await call('DELETE', `/conversations/${conv}/tags/${vip.id}`, 'a1@t.io')).statusCode).toBe(200);
    await call('POST', `/conversations/${conv}/tags`, 'a1@t.io', { tagId: bug.id });
    expect((await call('DELETE', `/tags/${bug.id}`, 'a1@t.io')).statusCode).toBe(403);
    expect((await call('DELETE', `/tags/${bug.id}`, 'sup@t.io')).statusCode).toBe(200);
    expect((await db.query('SELECT 1 FROM conversation_tags')).rowCount).toBe(0);
  });

  it('audit: admin only, actor names, prefix filter, keyset pagination', async () => {
    expect((await call('GET', '/audit', 'sup@t.io')).statusCode).toBe(403);
    const all = (await call('GET', '/audit?limit=200', 'admin@t.io')).json();
    expect(all.length).toBeGreaterThan(5);
    expect(all.some((r: { actorName: string | null }) => r.actorName === 'admin')).toBe(true);
    const logins = (await call('GET', '/audit?action=login', 'admin@t.io')).json();
    expect(logins.length).toBeGreaterThan(0);
    expect(logins.every((r: { action: string }) => r.action.startsWith('login'))).toBe(true);
    const page1 = (await call('GET', '/audit?limit=2', 'admin@t.io')).json();
    const page2 = (await call('GET', `/audit?limit=2&before=${page1[1].id}`, 'admin@t.io')).json();
    expect(Number(page2[0].id)).toBeLessThan(Number(page1[1].id));
    expect((await call('GET', '/audit?action=a%27%3B--', 'admin@t.io')).statusCode).toBe(400); // injection-shaped input rejected
    expect(JSON.stringify(all)).not.toContain('hello'); // no message content in the audit log
  });
});

describe('unread counter endpoint', () => {
  it('counts unread in open conversations the caller may see (agents: own + unassigned non-bot)', async () => {
    const db2 = createDb(cfg.DATABASE_URL);
    const app2 = await buildApp(cfg, db2, new ChannelManager(db2, cfg));
    const login = async (email: string) => {
      const r = await app2.inject({ method: 'POST', url: '/auth/login', remoteAddress: `10.99.0.${Math.floor(Math.random() * 250)}`, headers: { origin: ORIGIN }, payload: { email, password: PW } });
      return `botwa_sid=${r.cookies[0]!.value}`;
    };
    const ch = (await db2.query(`SELECT id FROM channels LIMIT 1`)).rows[0].id;
    const mk = async (ext: string, unread: number, assigned: string | null, status = 'open', bot: string | null = null) => {
      const c = (await db2.query(`INSERT INTO contacts (channel_id, external_id) VALUES ($1,$2) RETURNING id`, [ch, ext])).rows[0].id;
      await db2.query(`INSERT INTO conversations (channel_id, contact_id, unread_count, assigned_to, status, bot_state) VALUES ($1,$2,$3,$4,$5,$6)`, [ch, c, unread, assigned, status, bot]);
    };
    const a1 = (await db2.query(`SELECT id FROM users WHERE email='a1@t.io'`)).rows[0].id;
    const a2 = (await db2.query(`SELECT id FROM users WHERE email='a2@t.io'`)).rows[0].id;
    await db2.query(`DELETE FROM conversations`);
    await mk('u1', 2, a1); await mk('u2', 3, a2); await mk('u3', 4, null); await mk('u4', 5, null, 'open', 'menu'); await mk('u5', 7, a1, 'closed');
    const get = async (email: string) => (await app2.inject({ url: '/conversations/unread', headers: { cookie: await login(email) } })).json();
    expect(await get('a1@t.io')).toEqual({ count: 2 + 4 });          // own + unassigned (bot-handled and closed excluded)
    expect(await get('sup@t.io')).toEqual({ count: 2 + 3 + 4 + 5 }); // manager sees everything open
    expect((await app2.inject({ url: '/conversations/unread' })).statusCode).toBe(401);
    await app2.close(); await db2.end();
  });
});

describe('snooze, star, mark unread', () => {
  it('hides snoozed chats, keeps stars private, wakes on new inbound, enforces access', async () => {
    const db2 = createDb(cfg.DATABASE_URL);
    const app2 = await buildApp(cfg, db2, new ChannelManager(db2, cfg));
    const login = async (email: string) => {
      const r = await app2.inject({ method: 'POST', url: '/auth/login', remoteAddress: `10.98.0.${Math.floor(Math.random() * 250)}`, headers: { origin: ORIGIN }, payload: { email, password: PW } });
      return `botwa_sid=${r.cookies[0]!.value}`;
    };
    const ch = (await db2.query(`SELECT id FROM channels LIMIT 1`)).rows[0].id;
    const a1 = (await db2.query(`SELECT id FROM users WHERE email='a1@t.io'`)).rows[0].id;
    await db2.query(`DELETE FROM conversations`);
    const mk = async (ext: string, assigned: string | null) => {
      const c = (await db2.query(`INSERT INTO contacts (channel_id, external_id) VALUES ($1,$2) RETURNING id`, [ch, ext])).rows[0].id;
      return (await db2.query(`INSERT INTO conversations (channel_id, contact_id, unread_count, assigned_to) VALUES ($1,$2,2,$3) RETURNING id`, [ch, c, assigned])).rows[0].id as string;
    };
    const mine = await mk('s1', a1); const others = await mk('s2', (await db2.query(`SELECT id FROM users WHERE email='a2@t.io'`)).rows[0].id);
    const c1 = await login('a1@t.io'); const c2 = await login('a2@t.io');
    const post = (id: string, path: string, cookie: string, payload?: unknown) => app2.inject({ method: 'POST', url: `/conversations/${id}/${path}`, headers: { cookie, origin: ORIGIN }, payload: payload as never });
    const list = async (cookie: string, qs = '') => (await app2.inject({ url: `/conversations?${qs}`, headers: { cookie } })).json() as { id: string; starred: boolean; snoozedUntil: string | null }[];

    expect((await post(mine, 'snooze', c1, { minutes: 60 })).statusCode).toBe(200);
    expect((await list(c1)).map((c) => c.id)).not.toContain(mine);
    expect((await list(c1, 'snoozed=true')).map((c) => c.id)).toContain(mine);
    expect((await app2.inject({ url: '/conversations/unread', headers: { cookie: c1 } })).json()).toEqual({ count: 0 });
    expect((await post(mine, 'snooze', c1, { minutes: 999999 })).statusCode).toBe(400);
    expect((await post(mine, 'snooze', c2, { minutes: 5 })).statusCode).toBe(404); // not their conversation

    // a new customer message wakes it
    await db2.query(`UPDATE conversations SET snoozed_until = NULL WHERE id = $1`, [mine]);
    await post(mine, 'snooze', c1, { minutes: 60 });
    await db2.query(`UPDATE conversations SET snoozed_until = now() - interval '1 minute' WHERE id = $1`, [mine]);
    expect((await list(c1)).map((c) => c.id)).toContain(mine); // expired snooze shows again without any job

    // stars are per user
    expect((await post(mine, 'star', c1, { starred: true })).json()).toEqual({ starred: true });
    expect((await list(c1, 'starred=true')).map((c) => c.id)).toEqual([mine]);
    expect((await list(c1)).find((c) => c.id === mine)!.starred).toBe(true);
    expect((await post(others, 'star', c1, { starred: true })).statusCode).toBe(404);

    await post(mine, 'read', c1);
    await post(mine, 'unread', c1);
    expect((await db2.query(`SELECT unread_count FROM conversations WHERE id=$1`, [mine])).rows[0].unread_count).toBe(1);
    await app2.close(); await db2.end();
  });
});

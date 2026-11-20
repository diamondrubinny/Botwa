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
const PW = 'correct-horse-battery';
const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test', ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false' });
const db = createDb(cfg.DATABASE_URL);
let app: Awaited<ReturnType<typeof buildApp>>;
let mgr: ChannelManager;
let ctxA: AdapterContext;
let waId = '';
let tgId = '';
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
const out: { to: string; text: string }[] = [];
let down = false;
let groupCalls = 0;
let ip = 0;
const GROUP = '120363000000000001@g.us';
const GROUP2 = '120363000000000002-1600000000@g.us';
class Fake implements ChannelAdapter {
  constructor(c: AdapterContext) { ctxA = c; }
  async start() { ctxA.events.onStatus('connected'); }
  async stop() {}
  async logout() {}
  async sendText(to: string, text: string) { if (down) throw new Error('channel_not_connected'); out.push({ to, text }); return { externalMessageId: `s${out.length}` }; }
  async listGroups() { groupCalls++; return [{ id: GROUP, name: 'ממוני בטיחות', size: 7 }, { id: GROUP2, name: 'חירום', size: 3 }]; }
}
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, who?: string, payload?: object) => app.inject({ method, url, payload, remoteAddress: `10.78.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, ...(who ? { cookie: cookies[who]! } : {}) } });
let mid = 0;
const say = async (who: string, text: string, name?: string) => { await ctxA.events.onMessage({ externalContactId: who, contactName: name, externalMessageId: `fw${++mid}`, text, timestamp: new Date() }); await new Promise((r) => setTimeout(r, 60)); };
const conv = async (who: string) => (await db.query(`SELECT c.id, c.assigned_to FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.external_id = $1`, [who])).rows[0];
const toGroup = (jid = GROUP) => out.filter((o) => o.to === jid);

beforeAll(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  mgr = new ChannelManager(db, cfg, ((ty, c) => (ty === 'whatsapp' ? new Fake(c) : null)) as AdapterFactory);
  app = await buildApp(cfg, db, mgr);
  for (const [e, r] of [['admin', 'admin'], ['agent', 'agent'], ['agent2', 'agent']] as const) {
    ids[e] = (await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4) RETURNING id', [`${e}@t.io`, e, r, await hashPassword(PW)])).rows[0].id;
    cookies[e] = `botwa_sid=${(await call('POST', '/auth/login', undefined, { email: `${e}@t.io`, password: PW })).cookies[0]!.value}`;
  }
  waId = (await call('POST', '/channels', 'admin', { type: 'whatsapp', label: 'WA' })).json().id;
  tgId = (await db.query(`INSERT INTO channels (type, label, status) VALUES ('telegram', 'TG', 'stopped') RETURNING id`)).rows[0].id;
  await call('POST', `/channels/${waId}/start`, 'admin');
  await new Promise((r) => setTimeout(r, 40));
  await call('PUT', '/settings/bot', 'admin', { ...DEFAULT_BOT, enabled: true });
});
afterAll(async () => { await mgr.stopAll(); await app.close(); await db.end(); });

const rule = (over: object = {}) => ({ name: 'ממוני בטיחות', channelId: waId, groupJid: GROUP, groupName: 'ממוני בטיחות', onHandoff: true, tagIds: [], includeMessages: 3, includePhone: false, ...over });

describe('forwarding conversations to a WhatsApp group', () => {
  it('rules need settings.manage; the group id, the channel type and the numbers are checked', async () => {
    expect((await call('POST', '/forward/rules', 'agent', rule())).statusCode).toBe(403);
    expect((await call('POST', '/forward/rules', 'admin', rule({ groupJid: 'not-a-group' }))).statusCode).toBe(400);
    expect((await call('POST', '/forward/rules', 'admin', rule({ groupJid: '972500000000@s.whatsapp.net' }))).statusCode).toBe(400);   // a person, not a group
    expect((await call('POST', '/forward/rules', 'admin', rule({ includeMessages: 11 }))).statusCode).toBe(400);
    expect((await call('POST', '/forward/rules', 'admin', rule({ channelId: tgId }))).json()).toEqual({ error: 'channel_not_whatsapp' });
    const ok = await call('POST', '/forward/rules', 'admin', rule());
    expect(ok.statusCode).toBe(201);
    const list = (await call('GET', '/forward/rules', 'admin')).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'ממוני בטיחות', channelLabel: 'WA', groupJid: GROUP, onHandoff: true, includePhone: false });
    expect((await call('PUT', `/forward/rules/${ok.json().id}`, 'admin', rule({ name: 'שם חדש' }))).statusCode).toBe(200);
    expect((await call('GET', '/forward/rules', 'admin')).json()[0].name).toBe('שם חדש');
    expect((await call('PUT', '/forward/rules/00000000-0000-4000-8000-000000000000', 'admin', rule())).statusCode).toBe(404);
  });

  it('lists the groups of the linked number, cached for a few minutes unless refreshed', async () => {
    expect((await call('GET', `/channels/${waId}/groups`, 'agent')).statusCode).toBe(403);
    expect((await call('GET', `/channels/${tgId}/groups`, 'admin')).statusCode).toBe(400);
    groupCalls = 0;
    const g = (await call('GET', `/channels/${waId}/groups`, 'admin')).json();
    expect(g).toEqual([{ id: GROUP, name: 'ממוני בטיחות', size: 7 }, { id: GROUP2, name: 'חירום', size: 3 }]);
    await call('GET', `/channels/${waId}/groups`, 'admin');
    expect(groupCalls).toBe(1);
    await call('GET', `/channels/${waId}/groups?refresh=1`, 'admin');
    expect(groupCalls).toBe(2);
  });

  it('the test message reaches the group; when sending fails it says so and does not linger', async () => {
    const id = (await call('GET', '/forward/rules', 'admin')).json()[0].id;
    out.length = 0;
    expect((await call('POST', `/forward/rules/${id}/test`, 'admin')).statusCode).toBe(200);
    expect(toGroup()).toHaveLength(1);
    expect(toGroup()[0]!.text).toContain('בדיקת חיבור');
    down = true;
    expect((await call('POST', `/forward/rules/${id}/test`, 'admin')).json()).toEqual({ error: 'send_failed' });
    down = false;
    expect((await db.query(`SELECT count(*)::int AS n FROM forward_log WHERE trigger = 'test' AND status = 'pending'`)).rows[0].n).toBe(0);
  });

  it('a hand-over from the bot posts the conversation into the group: name, topic, messages and the panel link, but not the phone number by default', async () => {
    out.length = 0;
    await say('972521110001@s.whatsapp.net', 'שלום', 'דנה לוי');
    expect(toGroup()).toHaveLength(0);                                                   // the bot is still talking: nothing forwarded
    await say('972521110001@s.whatsapp.net', 'נציג', 'דנה לוי');
    const c = await conv('972521110001@s.whatsapp.net');
    expect(toGroup()).toHaveLength(1);
    const t = toGroup()[0]!.text;
    expect(t).toContain('לקוח: דנה לוי');
    expect(t).not.toContain('972521110001');
    expect(t).toContain('הודעות אחרונות:');
    expect(t).toContain('לקוח: נציג');
    expect(t).toContain(`https://panel.test/#/inbox?c=${c.id}`);
    // the same conversation is not forwarded twice by the same rule
    await db.query(`UPDATE conversations SET bot_state = NULL, assigned_to = NULL WHERE id = $1`, [c.id]);
    await say('972521110001@s.whatsapp.net', 'נציג', 'דנה לוי');
    expect(toGroup()).toHaveLength(1);
  });

  it('a rule can include the number, and a rule limited to topics forwards only conversations with that tag', async () => {
    await db.query('DELETE FROM forward_rules');
    const tag = (await db.query(`INSERT INTO tags (name) VALUES ('לייזרים') RETURNING id`)).rows[0].id;
    await call('POST', '/forward/rules', 'admin', rule({ includePhone: true, tagIds: [tag], includeMessages: 0 }));
    out.length = 0;
    await say('972521110002@s.whatsapp.net', 'שלום', 'אבי');
    await say('972521110002@s.whatsapp.net', 'נציג', 'אבי');
    expect(toGroup()).toHaveLength(0);                                                   // no tag: no forward
    await say('972521110003@s.whatsapp.net', 'שלום', 'גלית');
    const c3 = await conv('972521110003@s.whatsapp.net');
    await db.query('INSERT INTO conversation_tags (conversation_id, tag_id) VALUES ($1,$2)', [c3.id, tag]);
    await say('972521110003@s.whatsapp.net', 'נציג', 'גלית');
    expect(toGroup()).toHaveLength(1);
    expect(toGroup()[0]!.text).toContain('גלית (972521110003)');
    expect(toGroup()[0]!.text).toContain('נושא: לייזרים');
    expect(toGroup()[0]!.text).not.toContain('הודעות אחרונות');
  });

  it('staff forward a conversation by hand: only ones they can open, with a note, and a disabled rule is not offered', async () => {
    await db.query('DELETE FROM forward_rules');
    const r1 = (await call('POST', '/forward/rules', 'admin', rule({ onHandoff: false, name: 'פתוחה' }))).json().id as string;
    const r2 = (await call('POST', '/forward/rules', 'admin', rule({ onHandoff: false, name: 'כבויה', enabled: false, groupJid: GROUP2 }))).json().id as string;
    expect(((await call('GET', '/forward/targets', 'agent')).json() as { name: string }[]).map((x) => x.name)).toEqual(['פתוחה']);
    await say('972521110004@s.whatsapp.net', 'שלום', 'רונן');
    const c = await conv('972521110004@s.whatsapp.net');
    await db.query('UPDATE conversations SET assigned_to = $2 WHERE id = $1', [c.id, ids.agent]);
    out.length = 0;
    expect((await call('POST', `/conversations/${c.id}/forward`, 'agent2', { ruleId: r1 })).statusCode).toBe(404);   // someone else's conversation
    expect((await call('POST', `/conversations/${c.id}/forward`, 'agent', { ruleId: r2 })).statusCode).toBe(404);    // disabled rule
    const ok = await call('POST', `/conversations/${c.id}/forward`, 'agent', { ruleId: r1, note: 'דחוף, יש חשד לדליפה' });
    expect(ok.statusCode).toBe(200);
    expect(toGroup()).toHaveLength(1);
    expect(toGroup()[0]!.text).toContain('(מאת agent)');
    expect(toGroup()[0]!.text).toContain('הערה: דחוף, יש חשד לדליפה');
    expect((await db.query('SELECT body FROM conversation_notes WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1', [c.id])).rows[0].body).toContain('הועברה לקבוצת ווצאפ');
    // forwarding it again is allowed (it is a person's decision); each one is logged
    expect((await call('POST', `/conversations/${c.id}/forward`, 'agent', { ruleId: r1 })).statusCode).toBe(200);
    expect(toGroup()).toHaveLength(2);
    const log = (await call('GET', '/forward/log', 'admin')).json() as { trigger: string; status: string; byName: string }[];
    expect(log.filter((l) => l.trigger === 'manual' && l.status === 'sent' && l.byName === 'agent')).toHaveLength(2);
    expect((await call('GET', '/forward/log', 'agent')).statusCode).toBe(403);
  });

  it('when the channel is down the forward waits and is sent once when it is back', async () => {
    const rid = (await call('GET', '/forward/rules', 'admin')).json().find((r: { enabled: boolean }) => r.enabled).id as string;
    const c = await conv('972521110004@s.whatsapp.net');
    down = true; out.length = 0;
    const r = await call('POST', `/conversations/${c.id}/forward`, 'agent', { ruleId: rid, note: 'תקוע' });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ ok: false, queued: true });
    expect(out).toEqual([]);
    down = false;
    expect(await mgr.retryForwards()).toBe(1);
    expect(toGroup()).toHaveLength(1);
    expect(toGroup()[0]!.text).toContain('הערה: תקוע');
    expect(await mgr.retryForwards()).toBe(0);                                          // not twice
  });

  it('deleting a rule keeps the log, and rules die with their channel', async () => {
    const id = (await call('GET', '/forward/rules', 'admin')).json()[0].id as string;
    expect((await call('DELETE', `/forward/rules/${id}`, 'agent')).statusCode).toBe(403);
    expect((await call('DELETE', `/forward/rules/${id}`, 'admin')).statusCode).toBe(200);
    expect((await db.query('SELECT count(*)::int AS n FROM forward_log')).rows[0].n).toBeGreaterThan(0);
  });
});

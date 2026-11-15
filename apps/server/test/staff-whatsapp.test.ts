import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ChannelManager } from '../src/channels/manager.js';
import type { AdapterContext, AdapterFactory, ChannelAdapter } from '../src/channels/types.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';

describe('Betty for managers on WhatsApp', () => {
  const ORIGIN = 'https://panel.test';
  const PW = 'correct-horse-battery';
  const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test', ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false', MEDIA_ALLOW_UNSCANNED: 'true' });
  const db = createDb(cfg.DATABASE_URL);
  let app: Awaited<ReturnType<typeof buildApp>>;
  let mgr: ChannelManager;
  let ctxA: AdapterContext;
  const out: { to: string; text: string }[] = [];
  class Fake implements ChannelAdapter {
    constructor(c: AdapterContext) { ctxA = c; }
    async start() { ctxA.events.onStatus('connected'); }
    async stop() {} async logout() {}
    async sendText(to: string, text: string) { out.push({ to, text }); return { externalMessageId: `o${out.length}` }; }
  }
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let ip = 0, mid = 0;
  const call = (who: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url, payload: payload as never, remoteAddress: `10.85.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, cookie: cookies[who]! } });
  const say = async (from: string, text: string) => {
    out.length = 0;
    await ctxA.events.onMessage({ externalContactId: from, externalMessageId: `sw${++mid}`, text, timestamp: new Date() });
    return out.filter((o) => o.to === from).map((o) => o.text).join('\n');
  };

  beforeAll(async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    mgr = new ChannelManager(db, cfg, ((ty, c) => (ty === 'whatsapp' ? new Fake(c) : null)) as AdapterFactory);
    app = await buildApp(cfg, db, mgr);
    for (const [e, role, he] of [['boss@t.io', 'admin', 'מנהלת'], ['dana@t.io', 'agent', 'דנה'], ['yoni@t.io', 'agent', 'יוני']] as const) {
      ids[e] = (await db.query('INSERT INTO users (email, name, name_he, role, password_hash) VALUES ($1,$1,$2,$3,$4) RETURNING id', [e, he, role, await hashPassword(PW)])).rows[0].id;
      cookies[e] = `botwa_sid=${(await app.inject({ method: 'POST', url: '/auth/login', payload: { email: e, password: PW }, remoteAddress: `10.85.9.${++ip}`, headers: { origin: ORIGIN } })).cookies[0]!.value}`;
    }
    ids.ch = (await call('boss@t.io', 'POST', '/channels', { type: 'whatsapp', label: 'WA' })).json().id;
    await call('boss@t.io', 'POST', `/channels/${ids.ch}/start`);
    await new Promise((r) => setTimeout(r, 30));
    // open inquiries: two with Dana (one urgent, waiting for our answer), one with Yoni, one waiting to be assigned
    const tag = async (name: string) => (await db.query('INSERT INTO tags (name) VALUES ($1) RETURNING id', [name])).rows[0].id as string;
    const tLaser = await tag('לייזרים'), tHaz = await tag('מפגע'), tUrgent = await tag('דחוף');
    const open = async (who: string, assignee: string | null, hoursAgo: number, tags: string[], lastIn: boolean, bot: string | null = 'human') => {
      const ct = (await db.query(`INSERT INTO contacts (channel_id, external_id, display_name) VALUES ($1,$2,'דנה כהן הלקוחה') RETURNING id`, [ids.ch, `${who}@s.whatsapp.net`])).rows[0].id;
      const c = (await db.query(`INSERT INTO conversations (channel_id, contact_id, assigned_to, bot_state, created_at) VALUES ($1,$2,$3,$4, now() - make_interval(hours => $5)) RETURNING id`, [ids.ch, ct, assignee, bot, hoursAgo])).rows[0].id;
      // the database opens the inquiry with the conversation: only its time is set back
      const upd = await db.query(`UPDATE cases SET opened_at = now() - make_interval(hours => $2) WHERE conversation_id = $1 AND closed_at IS NULL`, [c, hoursAgo]);
      if (!upd.rowCount) await db.query(`INSERT INTO cases (conversation_id, opened_at) VALUES ($1, now() - make_interval(hours => $2))`, [c, hoursAgo]);
      for (const t of tags) await db.query('INSERT INTO conversation_tags (conversation_id, tag_id) VALUES ($1,$2)', [c, t]);
      await db.query(`INSERT INTO messages (conversation_id, direction, body) VALUES ($1, $2, 'טלפון 0501234567 של הלקוחה')`, [c, lastIn ? 'in' : 'out']);
    };
    await open('9725000001', ids['dana@t.io']!, 30, [tHaz, tUrgent], true);
    await open('9725000002', ids['dana@t.io']!, 3, [tLaser], false);
    await open('9725000003', ids['yoni@t.io']!, 5, [tLaser], true);
    await open('9725000004', null, 1, [], true);
  });
  afterAll(async () => { await mgr.stopAll(); await app.close(); await db.end(); });

  it('linking: a code from the panel (managers only) sent from WhatsApp; the message is not a customer conversation', async () => {
    expect((await call('dana@t.io', 'POST', '/me/whatsapp-links/code')).statusCode).toBe(403);
    expect((await call('dana@t.io', 'GET', '/me/whatsapp-links')).json()).toMatchObject({ allowed: false });
    const { code } = (await call('boss@t.io', 'POST', '/me/whatsapp-links/code')).json();
    expect(code).toMatch(/^BOTWA-\d{6}$/);
    expect(await say('9725999999@s.whatsapp.net', 'BOTWA-000000')).toContain('הקוד שגוי');
    const r = await say('9725888888@s.whatsapp.net', code.toLowerCase());
    expect(r).toContain('קושר לחשבון שלך');
    expect((await db.query(`SELECT count(*)::int AS n FROM contacts WHERE external_id = '9725888888@s.whatsapp.net'`)).rows[0].n).toBe(0);   // not in the inbox
    expect(await say('9725777777@s.whatsapp.net', code)).toContain('הקוד שגוי');                         // used once only
    const links = (await call('boss@t.io', 'GET', '/me/whatsapp-links')).json();
    expect(links).toMatchObject({ allowed: true, links: [{ account: '•••8888', channel: 'WA' }] });
  });

  it('answers about the inquiries: summary, by handler, topics, oldest, urgent, mine; never customers\' details', async () => {
    const me = '9725888888@s.whatsapp.net';
    const sum = await say(me, 'מה המצב?');
    expect(sum).toContain('4 קריאות פתוחות');
    expect(sum).toContain('אצל נציגים: 3');
    expect(sum).toContain('ממתינות לשיוך: 1');
    expect(sum).toContain('מחכות לתשובה מאיתנו: 3');
    expect(sum).toContain('🚨 דחופות: 1');
    expect(sum).toContain('הוותיקה ביותר פתוחה 30 שע׳');
    const agents = await say(me, 'אצל מי מה?');
    expect(agents).toContain('דנה: 2 פתוחות, 1 מחכות לתשובה');
    expect(agents).toContain('יוני: 1 פתוחות');
    const topics = await say(me, 'נושאים');
    expect(topics).toContain('לייזרים: 2');
    expect(topics).toContain('בלי נושא: 1');
    const oldest = await say(me, '4');
    expect(oldest.split('\n')[1]).toMatch(/^• #\d+ · דחוף, מפגע · דנה · 30 שע׳ · מחכה לתשובה$/);
    expect(oldest).toContain('ממתינה לשיוך');
    expect(await say(me, 'דחוף')).toContain('דחוף, מפגע · דנה');
    expect(await say(me, 'שלי')).toContain('אין קריאות פתוחות אצלך');
    for (const t of [sum, agents, topics, oldest]) { expect(t).not.toContain('דנה כהן הלקוחה'); expect(t).not.toContain('0501234567'); expect(t).not.toContain('9725000001'); }
    expect(await say(me, 'עזרה')).toContain('1. מצב');
    expect((await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'staff.whatsapp_query'`)).rows[0].n).toBeGreaterThanOrEqual(6);
  });

  it('loses access at once when the role changes; "ניתוק" removes the link', async () => {
    const me = '9725888888@s.whatsapp.net';
    await db.query(`UPDATE users SET role = 'agent' WHERE id = $1`, [ids['boss@t.io']]);
    expect(await say(me, 'מצב')).toContain('אין יותר הרשאה');
    expect((await db.query('SELECT count(*)::int AS n FROM staff_links')).rows[0].n).toBe(0);
    // the next message is an ordinary customer message again
    expect(await say(me, 'מצב')).not.toContain('קריאות פתוחות');
    await db.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [ids['boss@t.io']]);
    const { code } = (await call('boss@t.io', 'POST', '/me/whatsapp-links/code')).json();
    await say('9725666666@s.whatsapp.net', code);
    expect(await say('9725666666@s.whatsapp.net', 'ניתוק')).toContain('הקישור הוסר');
    expect((await db.query('SELECT count(*)::int AS n FROM staff_links')).rows[0].n).toBe(0);
  });
  it('a customer waiting for the team asks "מתי חוזרים אליי?": where the inquiry stands, at most every 30 minutes', async () => {
    const withDana = await say('9725000001@s.whatsapp.net', 'מתי חוזרים אליי?');                // with Dana, waiting for our answer
    expect(withDana).toMatch(/הפנייה שלך \(מספר \d+\) נמצאת בטיפול של דנה\./);
    expect(withDana).toContain('נחזור אליך בהקדם');
    expect(withDana).not.toContain('מחוץ לשעות');
    expect(await say('9725000001@s.whatsapp.net', 'יש עדכון?')).not.toContain('הפנייה שלך');   // not again within 30 minutes
    expect(await say('9725000004@s.whatsapp.net', 'מישהו שם?')).toContain('מחכה לנציג הפנוי הבא');
    // a person answered a moment ago: stay quiet, the person is on it
    const c3 = (await db.query(`SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.external_id = '9725000003@s.whatsapp.net'`)).rows[0].id;
    await db.query(`INSERT INTO messages (conversation_id, direction, body, auto) VALUES ($1, 'out', 'בודק עכשיו', false)`, [c3]);
    expect(await say('9725000003@s.whatsapp.net', 'מתי חוזרים אלי')).not.toContain('הפנייה שלך');
  });
});

import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ChannelManager } from '../src/channels/manager.js';
import type { AdapterContext, AdapterFactory, ChannelAdapter } from '../src/channels/types.js';
import { loadConfig } from '../src/config.js';
import { cleanName, findColumns, normalizePhone, parseCsv } from '../src/contacts-csv.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';
import { sendDueScheduled } from '../src/scheduled.js';

describe('contacts CSV helpers', () => {
  it('parses quotes, newlines, BOM and any of , ; tab', () => {
    expect(parseCsv('﻿phone,name\r\n"050-1234567","Dana ""D"" Levi"\n\n0521111111,"two\nlines"')).toEqual([['phone', 'name'], ['050-1234567', 'Dana "D" Levi'], ['0521111111', 'two\nlines']]);
    expect(parseCsv('טלפון;שם\n0501234567;דנה')).toEqual([['טלפון', 'שם'], ['0501234567', 'דנה']]);
    expect(parseCsv('phone\tname\n0501234567\tx')[1]).toEqual(['0501234567', 'x']);
  });
  it('finds columns by English or Hebrew header, or refuses', () => {
    expect(findColumns(['שם', 'טלפון'])).toEqual({ phone: 1, name: 0 });
    expect(findColumns(['Phone'])).toEqual({ phone: 0, name: -1 });
    expect(findColumns(['email', 'name'])).toBeNull();
  });
  it('normalises phone numbers strictly', () => {
    expect(normalizePhone('050-123 4567')).toBe('972501234567');
    expect(normalizePhone('+972 (50) 123-4567')).toBe('972501234567');
    expect(normalizePhone('00447911123456')).toBe('447911123456');
    for (const bad of ['', 'abc', '12345', '+0123456789', '9'.repeat(16), '=1+1']) expect(normalizePhone(bad)).toBeNull();
  });
  it('cleans names of control and bidi characters', () => {
    expect(cleanName('  Dana‮\n  Levi\u0000 ')).toBe('Dana Levi');
    expect(cleanName('x'.repeat(300))).toHaveLength(100);
  });
});

const ORIGIN = 'https://panel.test';
const PW = 'correct-horse-battery';
const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test', ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false' });
const db = createDb(cfg.DATABASE_URL);
let app: Awaited<ReturnType<typeof buildApp>>;
let mgr: ChannelManager;
let ctxA: AdapterContext;
let down = false;
const sent: string[] = [];
let sid = 0;
class Fake implements ChannelAdapter {
  constructor(c: AdapterContext) { ctxA = c; }
  async start() { ctxA.events.onStatus('connected'); }
  async stop() {}
  async logout() {}
  async sendText(_t: string, text: string) { if (down) throw new Error('channel_not_connected'); sent.push(text); return { externalMessageId: `s${++sid}` }; }
}
const cookies: Record<string, string> = {};
let ip = 0;
const call = (method: 'GET' | 'POST' | 'DELETE', url: string, who: string, payload?: object) =>
  app.inject({ method, url, payload, remoteAddress: `10.90.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, cookie: cookies[who]! } });
let ch = '';
let conv = '';
let mid = 0;
const hear = (who: string, text: string) => ctxA.events.onMessage({ externalContactId: who, externalMessageId: `m${++mid}`, text, timestamp: new Date() });
const soon = (sec: number) => new Date(Date.now() + sec * 1000).toISOString();

beforeAll(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  mgr = new ChannelManager(db, cfg, ((ty, c) => (ty === 'whatsapp' ? new Fake(c) : null)) as AdapterFactory);
  app = await buildApp(cfg, db, mgr);
  for (const [e, r] of [['adm', 'admin'], ['sup', 'supervisor'], ['a1', 'agent'], ['a2', 'agent']] as const) {
    await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4)', [`${e}@t.io`, e === 'a1' ? 'יוסי' : e, r, await hashPassword(PW)]);
    cookies[e] = `botwa_sid=${(await app.inject({ method: 'POST', url: '/auth/login', payload: { email: `${e}@t.io`, password: PW }, remoteAddress: `10.90.9.${++ip}`, headers: { origin: ORIGIN } })).cookies[0]!.value}`;
  }
  ch = (await call('POST', '/channels', 'adm', { type: 'whatsapp', label: 'WA' })).json().id;
  await call('POST', `/channels/${ch}/start`, 'adm');
  await new Promise((r) => setTimeout(r, 60));
  await hear('972500000001@s.whatsapp.net', 'שלום');
  conv = (await db.query(`SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.external_id = '972500000001@s.whatsapp.net'`)).rows[0].id;
  await db.query('UPDATE conversations SET assigned_to = (SELECT id FROM users WHERE email = $1) WHERE id = $2', ['a1@t.io', conv]);
});
afterAll(async () => { await mgr.stopAll(); await app.close(); await db.end(); });

describe('contacts import / export', () => {
  const csv = 'phone,name\n050-000-0001,Dana\n0500000002,"=HYPERLINK(""http://x"")"\n0500000002,dup\nnope,Bad\n0500000003,\n';
  it('is for people with contacts.manage only', async () => {
    for (const who of ['a1', 'sup']) {
      expect((await call('GET', '/contacts/export.csv', who)).statusCode).toBe(403);
      expect((await call('POST', '/contacts/import', who, { channelId: ch, csv })).statusCode).toBe(403);
    }
  });
  it('previews without writing, then imports idempotently and keeps existing names', async () => {
    const before = (await db.query('SELECT count(*)::int AS n FROM contacts')).rows[0].n;
    const dry = (await call('POST', '/contacts/import', 'adm', { channelId: ch, csv, dryRun: true })).json();
    expect(dry).toMatchObject({ dryRun: true, rows: 5, created: 2, duplicates: 1, invalidCount: 1, invalid: [{ row: 5, reason: 'bad_phone' }] });
    expect((await db.query('SELECT count(*)::int AS n FROM contacts')).rows[0].n).toBe(before);
    const real = (await call('POST', '/contacts/import', 'adm', { channelId: ch, csv })).json();
    expect(real).toMatchObject({ created: 2, named: 1 });
    // the pre-existing contact (972500000001) was untouched; a name-less import does not erase anything
    const names = (await db.query(`SELECT external_id, display_name FROM contacts ORDER BY external_id`)).rows;
    expect(names.find((r) => r.external_id === '972500000003@s.whatsapp.net')?.display_name).toBeNull();
    expect((await call('POST', '/contacts/import', 'adm', { channelId: ch, csv })).json()).toMatchObject({ created: 0, unchanged: 3 });
    // an import never opens a conversation
    expect((await db.query(`SELECT count(*)::int AS n FROM conversations`)).rows[0].n).toBe(1);
    expect((await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'contacts.import'`)).rows[0].n).toBe(2);
  });
  it('fills a missing name later but never overwrites one', async () => {
    const r = (await call('POST', '/contacts/import', 'adm', { channelId: ch, csv: 'phone,name\n0500000003,Noa\n0500000001,Overwrite?' })).json();
    expect(r).toMatchObject({ named: 1, created: 0 });
    const n = (await db.query(`SELECT external_id, display_name FROM contacts WHERE external_id IN ('972500000003@s.whatsapp.net','972500000001@s.whatsapp.net')`)).rows;
    expect(n.find((x) => x.external_id.startsWith('972500000003'))?.display_name).toBe('Noa');
    expect(n.find((x) => x.external_id.startsWith('972500000001'))?.display_name).not.toBe('Overwrite?');
  });
  it('rejects bad input', async () => {
    expect((await call('POST', '/contacts/import', 'adm', { channelId: ch, csv: 'email\nx@y.z' })).json()).toEqual({ error: 'missing_phone_column' });
    expect((await call('POST', '/contacts/import', 'adm', { channelId: '00000000-0000-4000-8000-000000000000', csv })).statusCode).toBe(404);
    const tg = (await db.query(`INSERT INTO channels (type,label) VALUES ('telegram','t') RETURNING id`)).rows[0].id;
    expect((await call('POST', '/contacts/import', 'adm', { channelId: tg, csv })).json()).toEqual({ error: 'unsupported_channel' });
    const big = 'phone\n' + Array.from({ length: 5001 }, (_, i) => `05${String(i).padStart(8, '0')}`).join('\n');
    expect((await call('POST', '/contacts/import', 'adm', { channelId: ch, csv: big })).statusCode).toBe(413);
  });
  it('exports a formula-safe CSV and audits it', async () => {
    const r = await call('GET', '/contacts/export.csv', 'adm');
    expect(r.headers['cache-control']).toContain('no-store');
    expect(r.body).toContain('channel,phone_or_id,name');
    expect(r.body).toContain("'=HYPERLINK");                       // never a live formula
    expect(r.body).not.toMatch(/(^|,)=HYPERLINK/m);
    expect((await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'contacts.export'`)).rows[0].n).toBe(1);
  });
});

describe('scheduled messages', () => {
  it('validates time, access and quantity', async () => {
    expect((await call('POST', `/conversations/${conv}/scheduled`, 'a1', { text: 'x', sendAt: soon(-60) })).json()).toEqual({ error: 'time_in_past' });
    expect((await call('POST', `/conversations/${conv}/scheduled`, 'a1', { text: 'x', sendAt: soon(40 * 86400) })).json()).toEqual({ error: 'too_far_ahead' });
    expect((await call('POST', `/conversations/${conv}/scheduled`, 'a1', { text: ' ', sendAt: soon(100) })).statusCode).toBe(400);
    expect((await call('POST', `/conversations/${conv}/scheduled`, 'a2', { text: 'x', sendAt: soon(100) })).statusCode).toBe(404);   // someone else's conversation
    const ok = await call('POST', `/conversations/${conv}/scheduled`, 'a1', { text: 'תזכורת {שם}', sendAt: soon(3600) });
    expect(ok.statusCode).toBe(201);
    expect((await call('GET', `/conversations/${conv}/scheduled`, 'a2')).statusCode).toBe(404);
    expect(((await call('GET', `/conversations/${conv}/scheduled`, 'a1')).json() as unknown[]).length).toBe(1);
    expect((await call('DELETE', `/scheduled/${ok.json().id}`, 'a2')).statusCode).toBe(404);
    expect((await call('DELETE', `/scheduled/${ok.json().id}`, 'a1')).statusCode).toBe(200);
    expect((await call('DELETE', `/scheduled/${ok.json().id}`, 'a1')).statusCode).toBe(409);
    for (let i = 0; i < 10; i++) expect((await call('POST', `/conversations/${conv}/scheduled`, 'a1', { text: `m${i}`, sendAt: soon(3600) })).statusCode).toBe(201);
    expect((await call('POST', `/conversations/${conv}/scheduled`, 'a1', { text: 'one more', sendAt: soon(3600) })).json()).toEqual({ error: 'too_many_scheduled' });
    await db.query(`UPDATE scheduled_messages SET status = 'cancelled'`);
  });

  const due = async (text: string) => {
    const id = (await call('POST', `/conversations/${conv}/scheduled`, 'a1', { text, sendAt: soon(60) })).json().id as string;
    await db.query(`UPDATE scheduled_messages SET send_at = now() - interval '1 minute' WHERE id = $1`, [id]);
    return id;
  };
  const status = async (id: string) => (await db.query('SELECT status, error FROM scheduled_messages WHERE id = $1', [id])).rows[0];

  it('sends when due, with variables filled, and records it as a normal outgoing message', async () => {
    sent.length = 0;
    const id = await due('היי {שם}, כאן {נציג}');
    expect(await sendDueScheduled(db, mgr)).toBe(1);
    expect(sent).toEqual(['היי 500000001, כאן יוסי'.replace('500000001', (await db.query(`SELECT coalesce(display_name,'') AS n FROM contacts WHERE external_id = '972500000001@s.whatsapp.net'`)).rows[0].n)]);
    expect((await status(id)).status).toBe('sent');
    expect((await db.query(`SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND direction = 'out' AND sender_user_id IS NOT NULL`, [conv])).rows[0].n).toBe(1);
    expect(await sendDueScheduled(db, mgr)).toBe(0);                          // not twice
  });
  it('retries while the channel is down and gives up after six hours', async () => {
    down = true; sent.length = 0;
    const id = await due('later');
    expect(await sendDueScheduled(db, mgr)).toBe(0);
    expect((await status(id)).status).toBe('pending');
    down = false;
    expect(await sendDueScheduled(db, mgr)).toBe(1);
    down = true;
    const id2 = await due('too late');
    await db.query(`UPDATE scheduled_messages SET send_at = now() - interval '7 hours' WHERE id = $1`, [id2]);
    await sendDueScheduled(db, mgr);
    expect(await status(id2)).toEqual({ status: 'failed', error: 'expired_channel_not_connected' });
    down = false;
  });
  it('re-checks opt-out, block and the reply window at send time', async () => {
    sent.length = 0;
    const a = await due('opted-out soon');
    await db.query(`UPDATE contacts SET opted_out = true WHERE external_id = '972500000001@s.whatsapp.net'`);
    await sendDueScheduled(db, mgr);
    expect(await status(a)).toEqual({ status: 'failed', error: 'contact_opted_out' });
    expect((await call('POST', `/conversations/${conv}/scheduled`, 'a1', { text: 'x', sendAt: soon(100) })).json()).toEqual({ error: 'contact_opted_out' });
    await db.query(`UPDATE contacts SET opted_out = false, blocked = true WHERE external_id = '972500000001@s.whatsapp.net'`);
    expect((await call('POST', `/conversations/${conv}/scheduled`, 'adm', { text: 'x', sendAt: soon(100) })).json()).toEqual({ error: 'contact_blocked' });
    await db.query(`UPDATE contacts SET blocked = false WHERE external_id = '972500000001@s.whatsapp.net'`);
    const w = await due('outside window');
    await db.query(`UPDATE messages SET created_at = now() - interval '30 days' WHERE conversation_id = $1 AND direction = 'in'`, [conv]);
    await sendDueScheduled(db, mgr);
    expect(await status(w)).toEqual({ status: 'failed', error: 'outside_reply_window' });
    expect(sent).toEqual([]);
  });
});

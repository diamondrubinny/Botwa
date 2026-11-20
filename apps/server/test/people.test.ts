import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ChannelManager } from '../src/channels/manager.js';
import { loadConfig } from '../src/config.js';
import { normalizeEmail, normalizePhone } from '../src/contacts/identity.js';
import { createDb } from '../src/db.js';
import { ingestInbound } from '../src/inbox.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';

const ORIGIN = 'https://panel.test';
const PW = 'correct-horse-battery';
const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test';
const db = createDb(DB_URL);
const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: DB_URL, ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false' });

describe('identifiers typed by customers', () => {
  it('normalises phones to international digits and e-mails to lower case', () => {
    expect(normalizePhone('050-123 4567')).toBe('972501234567');
    expect(normalizePhone('+972 50 123 4567')).toBe('972501234567');
    expect(normalizePhone('00972501234567')).toBe('972501234567');
    expect(normalizePhone('12')).toBeNull();
    expect(normalizePhone('')).toBeNull();
    expect(normalizeEmail(' Dana@Example.CO.IL ')).toBe('dana@example.co.il');
    expect(normalizeEmail('not an email')).toBeNull();
  });
});

describe('one person across channels', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const cookies: Record<string, string> = {};
  const uid: Record<string, string> = {};
  let ip = 0;
  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, who: string, payload?: object) =>
    app.inject({ method, url, payload, remoteAddress: `10.92.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, cookie: cookies[who]! } });
  const ch: Record<string, string> = {};
  const conv: Record<string, string> = {};
  const contact: Record<string, string> = {};
  const inbound = async (key: string, channel: string, externalId: string, name: string) => {
    await ingestInbound(db, ch[channel]!, { externalContactId: externalId, contactName: name, externalMessageId: `m-${key}`, text: `שלום מ-${key}`, timestamp: new Date() });
    const r = (await db.query('SELECT c.id, c.contact_id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.channel_id = $1 AND ct.external_id = $2', [ch[channel], externalId])).rows[0];
    conv[key] = r.id; contact[key] = r.contact_id;
  };

  beforeAll(async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    app = await buildApp(cfg, db, new ChannelManager(db, cfg, () => null));
    for (const [e, role] of [['adm@t.io', 'admin'], ['a1@t.io', 'agent'], ['a2@t.io', 'agent']] as const) {
      uid[e] = (await db.query(`INSERT INTO users (email,name,role,password_hash) VALUES ($1,$1,$2,$3) RETURNING id`, [e, role, await hashPassword(PW)])).rows[0].id;
      const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: e, password: PW }, remoteAddress: `10.93.0.${++ip}`, headers: { origin: ORIGIN } });
      cookies[e] = `botwa_sid=${r.cookies[0]!.value}`;
    }
    for (const t of ['whatsapp', 'whatsapp_cloud', 'webchat', 'messenger']) ch[t] = (await db.query(`INSERT INTO channels (type, label) VALUES ($1, $1) RETURNING id`, [t])).rows[0].id;
    await inbound('wa', 'whatsapp', '972501234567@s.whatsapp.net', 'דנה');
    await inbound('cloud', 'whatsapp_cloud', '972501234567@s.whatsapp.net', 'Dana');
    await inbound('web', 'webchat', 'v1@web', 'דנה מהאתר');
    await inbound('fb', 'messenger', '5550001@messenger', 'Dana Levi');
    await inbound('other', 'webchat', 'v2@web', 'מישהו אחר');
    // the website visitor typed the same phone number (unverified), the other visitor typed an e-mail only
    await db.query(`UPDATE contacts SET claimed_phone = '972501234567', claimed_email = 'dana@example.com' WHERE id = $1`, [contact.web]);
    await db.query(`UPDATE contacts SET claimed_email = 'someone@example.com' WHERE id = $1`, [contact.other]);
  });
  afterAll(async () => { await app.close(); await db.end(); });

  it('the same WhatsApp number on two channels is related at once; a typed-in number is only suggested', async () => {
    const rel = (await call('GET', `/conversations/${conv.wa}/related`, 'adm@t.io')).json();
    expect(rel.map((r: { id: string; reason: string }) => [r.id, r.reason])).toEqual([[conv.cloud, 'same_phone']]);
    const sug = (await call('GET', `/conversations/${conv.wa}/link-suggestions`, 'adm@t.io')).json();
    expect(sug.map((r: { id: string; reason: string }) => [r.id, r.reason])).toEqual([[conv.web, 'phone']]);
    expect((await call('GET', `/conversations/${conv.web}/link-suggestions`, 'adm@t.io')).json().map((r: { id: string }) => r.id).sort()).toEqual([conv.wa, conv.cloud].sort());
    expect((await call('GET', `/conversations/${conv.fb}/link-suggestions`, 'adm@t.io')).json()).toEqual([]);
  });

  it('staff link by hand (search, then link); groups merge; unlink undoes; all audited', async () => {
    const found = (await call('GET', `/contacts/search?q=${encodeURIComponent('Dana Levi')}&not=${conv.wa}`, 'adm@t.io')).json();
    expect(found.map((r: { id: string }) => r.id)).toEqual([conv.fb]);
    expect((await call('GET', '/contacts/search?q=9999', 'adm@t.io')).json()).toEqual([]);
    expect((await call('GET', '/contacts/search?q=1234567', 'adm@t.io')).json().map((r: { id: string }) => r.id).sort()).toEqual([conv.wa, conv.cloud, conv.web].sort());

    expect((await call('POST', `/contacts/${contact.wa}/link`, 'adm@t.io', { with: contact.wa })).statusCode).toBe(400);
    expect((await call('POST', `/contacts/${contact.wa}/link`, 'adm@t.io', { with: contact.fb })).json()).toMatchObject({ ok: true, size: 2 });
    expect((await call('POST', `/contacts/${contact.web}/link`, 'adm@t.io', { with: contact.fb })).json()).toMatchObject({ ok: true, size: 3 });
    const rel = (await call('GET', `/conversations/${conv.fb}/related`, 'adm@t.io')).json();
    expect(rel.map((r: { id: string }) => r.id).sort()).toEqual([conv.wa, conv.web].sort());
    expect(rel.every((r: { reason: string }) => r.reason === 'linked')).toBe(true);
    expect((await call('GET', `/conversations/${conv.wa}/link-suggestions`, 'adm@t.io')).json()).toEqual([]);   // linked now: no longer a suggestion

    expect((await call('POST', `/contacts/${contact.web}/unlink`, 'adm@t.io')).json()).toEqual({ ok: true });
    expect((await call('GET', `/conversations/${conv.fb}/related`, 'adm@t.io')).json().map((r: { id: string }) => r.id)).toEqual([conv.wa]);
    expect((await db.query(`SELECT action FROM audit_log WHERE action LIKE 'contact.%link' ORDER BY created_at`)).rows.map((r) => r.action)).toEqual(['contact.link', 'contact.link', 'contact.unlink']);
  });

  it('agents see and link only conversations they may open', async () => {
    await db.query('UPDATE conversations SET assigned_to = $1 WHERE id = $2', [uid['a2@t.io'], conv.other]);
    await db.query('UPDATE conversations SET assigned_to = $1 WHERE id = $2', [uid['a1@t.io'], conv.web]);
    expect((await call('POST', `/contacts/${contact.web}/link`, 'a1@t.io', { with: contact.other })).statusCode).toBe(404);   // other agent's customer
    expect((await call('GET', `/contacts/search?q=${encodeURIComponent('מישהו')}`, 'a1@t.io')).json()).toEqual([]);
    expect((await call('GET', `/conversations/${conv.other}/related`, 'a1@t.io')).statusCode).toBe(404);
    // linked to someone the agent cannot open: the link exists, but that conversation stays hidden from them
    expect((await call('POST', `/contacts/${contact.web}/link`, 'adm@t.io', { with: contact.other })).statusCode).toBe(200);
    expect((await call('GET', `/conversations/${conv.web}/related`, 'a1@t.io')).json()).toEqual([]);
    await call('POST', `/contacts/${contact.other}/unlink`, 'adm@t.io');
    expect((await db.query('SELECT person_id FROM contacts WHERE id = $1', [contact.web])).rows[0].person_id).toBeNull();   // a group of one is cleared
  });

  it('privacy: export includes the linked contacts; erasure can cover the whole person', async () => {
    const ex = (await call('GET', `/contacts/${contact.fb}/export`, 'adm@t.io')).json();
    expect(ex.contact.id).toBe(contact.fb);
    expect(ex.linkedContacts.map((l: { contact: { id: string } }) => l.contact.id)).toEqual([contact.wa]);
    expect(ex.linkedContacts[0].messages[0].body).toBe('שלום מ-wa');
    const del = await call('DELETE', `/contacts/${contact.fb}?linked=true`, 'adm@t.io');
    expect(del.json()).toEqual({ ok: true, erased: 2 });
    expect((await db.query('SELECT count(*)::int AS n FROM contacts WHERE id = ANY($1::uuid[])', [[contact.fb, contact.wa]])).rows[0].n).toBe(0);
    expect((await db.query('SELECT count(*)::int AS n FROM contacts WHERE id = $1', [contact.cloud])).rows[0].n).toBe(1);   // not linked: untouched
  });
});

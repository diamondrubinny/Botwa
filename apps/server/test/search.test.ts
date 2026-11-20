import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ChannelManager } from '../src/channels/manager.js';
import type { AdapterFactory } from '../src/channels/types.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';

describe('global search', () => {
  const ORIGIN = 'https://panel.test';
  const PW = 'correct-horse-battery';
  const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test', ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false', MEDIA_ALLOW_UNSCANNED: 'true' });
  const db = createDb(cfg.DATABASE_URL);
  let app: Awaited<ReturnType<typeof buildApp>>;
  let mgr: ChannelManager;
  const cookies: Record<string, string> = {};
  let ip = 0;
  const get = (who: string, url: string) => app.inject({ method: 'GET', url, remoteAddress: `10.86.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, cookie: cookies[who]! } });

  beforeAll(async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    mgr = new ChannelManager(db, cfg, (() => null) as AdapterFactory);
    app = await buildApp(cfg, db, mgr);
    for (const [e, role, he, job] of [['boss@t.io', 'admin', 'מנהלת הבטיחות', 'מנהלת'], ['dana@t.io', 'agent', 'דנה לוי', 'נציגה']] as const) {
      await db.query('INSERT INTO users (email, name, name_he, job_title, role, password_hash) VALUES ($1,$1,$2,$3,$4,$5)', [e, he, job, role, await hashPassword(PW)]);
      cookies[e] = `botwa_sid=${(await app.inject({ method: 'POST', url: '/auth/login', payload: { email: e, password: PW }, remoteAddress: `10.86.9.${++ip}`, headers: { origin: ORIGIN } })).cookies[0]!.value}`;
    }
    const o = (await db.query(`INSERT INTO officers (name, office_phone) VALUES ('יוסי כהן', '04-829-1111') RETURNING id`)).rows[0].id;
    await db.query(`INSERT INTO officer_topics (officer_id, topic) VALUES ($1, 'בטיחות אש')`, [o]);
    await db.query(`INSERT INTO kb_sources (kind, title, body, variants, status) VALUES ('faq', 'מה עושים בשריפה?', 'מפעילים אזעקה ומתקשרים ל-102', ARRAY['שריפה במעבדה'], 'ready')`);
    await db.query(`INSERT INTO canned_replies (title, body) VALUES ('הפניה לממונה אש', 'הממונה על בטיחות אש יחזור אליך')`);
    await db.query(`INSERT INTO tags (name) VALUES ('אש ועשן')`);
    await db.query(`INSERT INTO form_templates (title, source_pdf, sha256, pages) VALUES ('הצהרת בטיחות אש', '\\x25504446', 'x', '[]')`);
  });
  afterAll(async () => { await mgr.stopAll(); await app.close(); await db.end(); });

  it('needs a login and a query of 2 to 80 characters', async () => {
    expect((await app.inject({ method: 'GET', url: '/search?q=אש', headers: { origin: ORIGIN } })).statusCode).toBe(401);
    expect((await get('boss@t.io', '/search?q=א')).statusCode).toBe(400);
    expect((await get('boss@t.io', `/search?q=${'א'.repeat(81)}`)).statusCode).toBe(400);
  });

  it('a manager finds every kind; titles and short labels only', async () => {
    const r = (await get('boss@t.io', `/search?q=${encodeURIComponent('אש')}`)).json();
    expect(r.officers).toEqual([expect.objectContaining({ title: 'יוסי כהן', sub: 'בטיחות אש' })]);
    expect(r.canned.map((x: { title: string }) => x.title)).toEqual(['הפניה לממונה אש']);
    expect(r.tags.map((x: { title: string }) => x.title)).toEqual(['אש ועשן']);
    expect(r.forms.map((x: { title: string }) => x.title)).toEqual(['הצהרת בטיחות אש']);
    expect(JSON.stringify(r)).not.toContain('04-829-1111');
    expect((await get('boss@t.io', `/search?q=${encodeURIComponent('במעבדה')}`)).json().kb).toEqual([expect.objectContaining({ title: 'מה עושים בשריפה?', sub: 'faq' })]);
    expect((await get('boss@t.io', `/search?q=${encodeURIComponent('נציגה')}`)).json().users).toEqual([expect.objectContaining({ title: 'דנה לוי' })]);
  });

  it('an agent sees only what the role allows: no knowledge base, officers, users or tags', async () => {
    const r = (await get('dana@t.io', `/search?q=${encodeURIComponent('אש')}`)).json();
    expect(r).toMatchObject({ kb: [], officers: [], users: [], tags: [] });
    expect(r.canned.length).toBe(1);                       // ready replies are used by everyone in the inbox
  });

  it('% and _ are literal, not wildcards', async () => {
    const r = (await get('boss@t.io', '/search?q=%25%25')).json();
    expect(Object.values(r).flat()).toEqual([]);
  });
});

import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ChannelManager } from '../src/channels/manager.js';
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
let app: Awaited<ReturnType<typeof buildApp>>;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
let ip = 0;
const get = (url: string, who?: string) =>
  app.inject({ url, remoteAddress: `10.7.0.${++ip % 250}`, headers: who ? { cookie: cookies[who]! } : {} });

beforeAll(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  app = await buildApp(cfg, db, new ChannelManager(db, cfg));
  for (const [e, r] of [['sup', 'supervisor'], ['a1', 'agent'], ['a2', 'agent']] as const) {
    const u = await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$1,$2,$3) RETURNING id', [`${e}@t.io`, r, await hashPassword(PW)]);
    ids[e] = u.rows[0].id;
    const res = await app.inject({ method: 'POST', url: '/auth/login', remoteAddress: `10.8.0.${++ip}`, headers: { origin: ORIGIN }, payload: { email: `${e}@t.io`, password: PW } });
    cookies[`${e}@t.io`] = `botwa_sid=${res.cookies[0]!.value}`;
  }
  const ch = (await db.query(`INSERT INTO channels (type,label) VALUES ('whatsapp','x') RETURNING id`)).rows[0].id;
  const mkConv = async (ext: string) => {
    const c = (await db.query(`INSERT INTO contacts (channel_id, external_id) VALUES ($1,$2) RETURNING id`, [ch, ext])).rows[0].id;
    return (await db.query(`INSERT INTO conversations (channel_id, contact_id) VALUES ($1,$2) RETURNING id`, [ch, c])).rows[0].id as string;
  };
  const msg = (conv: string, dir: 'in' | 'out', secondsAgo: number, user?: string) =>
    db.query(`INSERT INTO messages (conversation_id, direction, body, sender_user_id, created_at) VALUES ($1,$2,'x',$3, now() - make_interval(secs => $4))`, [conv, dir, user ?? null, secondsAgo]);

  const c1 = await mkConv('1'); // a1 answers after 60s
  await msg(c1, 'in', 1000); await msg(c1, 'out', 940, ids.a1);
  const c2 = await mkConv('2'); // a2 answers after 300s; customer follows up (second wait) and a1 answers after 100s
  await msg(c2, 'in', 900); await msg(c2, 'out', 600, ids.a2); await msg(c2, 'in', 500); await msg(c2, 'in', 450); await msg(c2, 'out', 400, ids.a1);
  const c3 = await mkConv('3'); // never answered
  await msg(c3, 'in', 100);
});
afterAll(async () => { await app.close(); await db.end(); });

describe('reports', () => {
  it('is restricted to supervisors/admins', async () => {
    expect((await get('/reports/summary')).statusCode).toBe(401);
    expect((await get('/reports/summary', 'a1@t.io')).statusCode).toBe(403);
    expect((await get('/reports/summary?days=0', 'sup@t.io')).statusCode).toBe(400);
  });

  it('computes volumes, response times per agent and overall', async () => {
    const r = (await get('/reports/summary?days=7', 'sup@t.io')).json();
    expect(r.totals).toMatchObject({ newConversations: 3, inbound: 5, outbound: 3, openNow: 3, unassignedNow: 3 });
    // waits: c1 (60s, a1), c2 first (300s, a2), c2 second (100s from 500s ago -> a1 at 400s ago), c3 unanswered
    expect(r.byHour).toHaveLength(24);
    expect(r.byHour.reduce((n: number, h: { inbound: number }) => n + h.inbound, 0)).toBe(5); // every inbound message lands in exactly one hour
    expect(Array.isArray(r.topTags)).toBe(true);
    expect(r.responseTime).toMatchObject({ answered: 3, unanswered: 1 });
    expect(r.responseTime.avgSeconds).toBe(Math.round((60 + 300 + 100) / 3));
    expect(r.responseTime.medianSeconds).toBe(100);
    const a1 = r.agents.find((a: { name: string }) => a.name === 'a1@t.io');
    expect(a1).toMatchObject({ messagesSent: 2, conversations: 2, avgFirstResponseSeconds: 80 });
    const a2 = r.agents.find((a: { name: string }) => a.name === 'a2@t.io');
    expect(a2).toMatchObject({ messagesSent: 1, avgFirstResponseSeconds: 300 });
    expect(r.daily.reduce((s: number, d: { inbound: number; outbound: number }) => s + d.inbound + d.outbound, 0)).toBe(8);
    expect(JSON.stringify(r)).not.toContain('"body"');
  });
});

import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createAuthStore } from '../src/channels/auth-store.js';
import { ChannelManager } from '../src/channels/manager.js';
import type { AdapterContext, AdapterFactory, ChannelAdapter } from '../src/channels/types.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { purgeOldMessages } from '../src/inbox.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';

const ORIGIN = 'https://panel.test';
const PW = 'correct-horse-battery';
const cfg = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test',
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  APP_ORIGIN: ORIGIN,
  COOKIE_SECURE: 'false',
});
const db = createDb(cfg.DATABASE_URL);

class FakeAdapter implements ChannelAdapter {
  static last: FakeAdapter;
  sent: { to: string; text: string }[] = [];
  constructor(readonly ctx: AdapterContext) {
    FakeAdapter.last = this;
  }
  async start() {
    await this.ctx.store.set('creds', 'secret-session-material');
    this.ctx.events.onStatus('qr');
    this.ctx.events.onQr('fake-qr-payload');
  }
  async stop() { this.ctx.events.onStatus('stopped'); }
  async logout() { await this.ctx.store.clear(); this.ctx.events.onStatus('logged_out'); }
  async sendText(to: string, text: string) { this.sent.push({ to, text }); return { externalMessageId: `out-${this.sent.length}` }; }
}
const factory: AdapterFactory = (type, ctx) => (type === 'whatsapp' ? new FakeAdapter(ctx) : null);

let app: Awaited<ReturnType<typeof buildApp>>;
let mgr: ChannelManager;
let ip = 0;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};

const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, who?: string, payload?: object) =>
  app.inject({ method, url, payload, remoteAddress: `10.1.0.${++ip % 250}`, headers: { origin: ORIGIN, ...(who ? { cookie: cookies[who]! } : {}) } });

async function mk(email: string, role: string) {
  const r = await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$1,$2,$3) RETURNING id', [email, role, await hashPassword(PW)]);
  ids[email] = r.rows[0].id;
  const res = await call('POST', '/auth/login', undefined, { email, password: PW });
  cookies[email] = `botwa_sid=${res.cookies.find((c) => c.name === 'botwa_sid')!.value}`;
}
const tick = () => new Promise((r) => setTimeout(r, 50));

beforeAll(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  mgr = new ChannelManager(db, cfg, factory);
  app = await buildApp(cfg, db, mgr);
  for (const [e, r] of [['admin', 'admin'], ['sup', 'supervisor'], ['a1', 'agent'], ['a2', 'agent']] as const) await mk(`${e}@t.io`, r);
});
afterAll(async () => {
  await mgr.stopAll();
  await app.close();
  await db.end();
});

let channelId = '';
let convId = '';

describe('channels', () => {
  it('only admin manages; telegram unsupported for now', async () => {
    expect((await call('POST', '/channels', 'sup@t.io', { type: 'whatsapp', label: 'x' })).statusCode).toBe(403);
    expect((await call('GET', '/channels', 'a1@t.io')).statusCode).toBe(403);
    expect((await call('POST', '/channels', 'admin@t.io', { type: 'telegram', label: 'x' })).statusCode).toBe(501);
    const r = await call('POST', '/channels', 'admin@t.io', { type: 'whatsapp', label: 'Support' });
    expect(r.statusCode).toBe(201);
    channelId = r.json().id;
  });

  it('start emits QR and stores session encrypted at rest', async () => {
    expect((await call('POST', `/channels/${channelId}/start`, 'admin@t.io')).statusCode).toBe(200);
    await tick();
    expect(mgr.snapshot(channelId)).toMatchObject({ status: 'qr' });
    expect(mgr.snapshot(channelId).qr).toMatch(/^data:image\/png;base64,/);
    const raw = await db.query('SELECT value_enc FROM channel_auth WHERE channel_id=$1', [channelId]);
    expect(raw.rows[0].value_enc).not.toContain('secret-session-material');
    expect(await createAuthStore(db, channelId, cfg.ENCRYPTION_KEY).get('creds')).toBe('secret-session-material');
  });

  it('SSE stream delivers snapshot, requires admin', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const open = (cookie?: string) =>
      new Promise<{ status: number; chunk: string }>((resolve) => {
        const req = http.get({ port, path: `/channels/${channelId}/events`, headers: cookie ? { cookie } : {} }, (res) => {
          res.setEncoding('utf8');
          res.once('data', (chunk) => { req.destroy(); resolve({ status: res.statusCode!, chunk }); });
          if (res.statusCode !== 200) res.once('end', () => resolve({ status: res.statusCode!, chunk: '' }));
        });
      });
    expect((await open()).status).toBe(401);
    expect((await open(cookies['sup@t.io'])).status).toBe(403);
    const ok = await open(cookies['admin@t.io']);
    expect(ok.status).toBe(200);
    expect(ok.chunk).toContain('"status":"qr"');
  });
});

describe('inbox & authorization', () => {
  it('ingests inbound, dedupes, reopens', async () => {
    const msg = { externalContactId: '972500000001@s.whatsapp.net', contactName: 'Dana', externalMessageId: 'm1', text: 'שלום', timestamp: new Date() };
    await FakeAdapter.last.ctx.events.onMessage(msg);
    await FakeAdapter.last.ctx.events.onMessage(msg); // duplicate delivery
    const list = (await call('GET', '/conversations', 'sup@t.io')).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ contactName: 'Dana', unreadCount: 1, lastMessage: 'שלום' });
    convId = list[0].id;
  });

  it('unassigned visible to agents; claim works; other agent loses access', async () => {
    expect((await call('GET', '/conversations', 'a1@t.io')).json()).toHaveLength(1);
    expect((await call('POST', `/conversations/${convId}/assign`, 'a1@t.io', { userId: ids['a2@t.io'] })).statusCode).toBe(403);
    expect((await call('POST', `/conversations/${convId}/assign`, 'a1@t.io', { userId: ids['a1@t.io'] })).statusCode).toBe(200);
    // IDOR: a2 cannot read, write, or see it
    expect((await call('GET', `/conversations/${convId}/messages`, 'a2@t.io')).statusCode).toBe(404);
    expect((await call('POST', `/conversations/${convId}/messages`, 'a2@t.io', { text: 'hi' })).statusCode).toBe(404);
    expect((await call('GET', '/conversations', 'a2@t.io')).json()).toHaveLength(0);
    expect((await call('GET', `/conversations/${convId}/messages`, 'sup@t.io')).json()).toHaveLength(1);
    expect((await call('GET', `/conversations/${convId}/messages`)).statusCode).toBe(401);
  });

  it('agent replies through adapter and message is stored', async () => {
    FakeAdapter.last.ctx.events.onStatus('connected');
    await tick();
    const r = await call('POST', `/conversations/${convId}/messages`, 'a1@t.io', { text: 'מה שלומך?' });
    expect(r.statusCode).toBe(201);
    expect(FakeAdapter.last.sent[0]).toEqual({ to: '972500000001@s.whatsapp.net', text: 'מה שלומך?' });
    expect((await call('POST', `/conversations/${convId}/messages`, 'a1@t.io', { text: '   ' })).statusCode).toBe(400);
  });

  it('send refused once channel is no longer connected', async () => {
    expect(mgr.snapshot(channelId).status).toBe('connected');
    FakeAdapter.last.ctx.events.onStatus('stopped');
    await tick();
    expect((await call('POST', `/conversations/${convId}/messages`, 'a1@t.io', { text: 'x' })).statusCode).toBe(409);
  });
});

describe('privacy & lifecycle', () => {
  it('retention purge removes old messages and empty closed conversations', async () => {
    await call('POST', `/conversations/${convId}/status`, 'a1@t.io', { status: 'closed' });
    await db.query(`UPDATE messages SET created_at = now() - interval '400 days'`);
    expect(await purgeOldMessages(db, 365)).toBeGreaterThan(0);
    expect((await db.query('SELECT 1 FROM conversations')).rowCount).toBe(0);
    expect(await purgeOldMessages(db, 0)).toBe(0);
  });

  it('contact export/erase are admin-only and audited', async () => {
    await FakeAdapter.last.ctx.events.onMessage({ externalContactId: 'u2', externalMessageId: 'z1', text: 'data', timestamp: new Date() });
    const contactId = (await db.query('SELECT id FROM contacts WHERE external_id=$1', ['u2'])).rows[0].id;
    expect((await call('GET', `/contacts/${contactId}/export`, 'sup@t.io')).statusCode).toBe(403);
    const exp = await call('GET', `/contacts/${contactId}/export`, 'admin@t.io');
    expect(exp.json().messages).toHaveLength(1);
    expect((await call('DELETE', `/contacts/${contactId}`, 'admin@t.io')).statusCode).toBe(200);
    expect((await db.query('SELECT 1 FROM messages')).rowCount).toBe(0);
  });

  it('logout wipes session; delete channel cascades', async () => {
    await call('POST', `/channels/${channelId}/start`, 'admin@t.io');
    await call('POST', `/channels/${channelId}/logout`, 'admin@t.io');
    expect((await db.query('SELECT 1 FROM channel_auth WHERE channel_id=$1', [channelId])).rowCount).toBe(0);
    expect((await call('DELETE', `/channels/${channelId}`, 'admin@t.io')).statusCode).toBe(200);
    expect((await call('POST', `/channels/${channelId}/start`, 'admin@t.io')).statusCode).toBe(404);
  });
});

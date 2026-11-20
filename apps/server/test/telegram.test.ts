import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ChannelManager, createDefaultFactory } from '../src/channels/manager.js';
import { formatTgContactId, parseTgContactId, tgQrPayload } from '../src/channels/telegram.js';
import type { AdapterContext, AdapterFactory, ChannelAdapter } from '../src/channels/types.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';

const ORIGIN = 'https://panel.test';
const base = {
  NODE_ENV: 'test',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test',
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  APP_ORIGIN: ORIGIN,
  COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false',
};
const cfg = loadConfig(base);
const db = createDb(cfg.DATABASE_URL);

describe('config', () => {
  it('treats blank optional variables as unset (as in .env.example / compose)', () => {
    const c = loadConfig({ ...base, TELEGRAM_API_ID: '', TELEGRAM_API_HASH: '', CLAMAV_HOST: '', WEB_DIST: '' });
    expect(c.TELEGRAM_API_ID).toBeUndefined();
    expect(c.CLAMAV_HOST).toBeUndefined();
  });
  it('the shipped .env.example (with required values filled, NO comment stripping) parses', async () => {
    const { readFileSync } = await import('node:fs');
    const lines = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8').split('\n');
    const env: Record<string, string> = {};
    // deliberately NO inline-comment stripping: `docker run --env-file` does not strip them either
    for (const l of lines) { const m = /^([A-Z_]+)=(.*)$/.exec(l); if (m) env[m[1]!] = m[2]!; }
    env.ENCRYPTION_KEY = base.ENCRYPTION_KEY;
    env.DATABASE_URL = base.DATABASE_URL;
    expect(() => loadConfig(env as NodeJS.ProcessEnv)).not.toThrow();
  });
});

describe('telegram helpers', () => {
  it('round-trips contact ids and rejects junk', () => {
    const id = formatTgContactId('12345', '-987654321');
    expect(parseTgContactId(id)).toEqual({ userId: '12345', accessHash: '-987654321' });
    expect(() => parseTgContactId('12345')).toThrow();
    expect(() => parseTgContactId('1:2; DROP')).toThrow();
  });
  it('builds a tg://login QR payload (base64url, no padding)', () => {
    expect(tgQrPayload(Buffer.from([251, 255, 254]))).toBe('tg://login?token=-__-');
  });
  it('telegram is only offered when api credentials are configured', () => {
    const ctx = { channelId: 'x', store: {} as never, events: { onQr() {}, onStatus() {}, onMessage() {} } };
    expect(createDefaultFactory(cfg)('telegram', ctx)).toBeNull();
    const withCreds = loadConfig({ ...base, TELEGRAM_API_ID: '12345', TELEGRAM_API_HASH: 'abcdefabcdef' });
    expect(createDefaultFactory(withCreds)('telegram', ctx)).not.toBeNull();
    expect(createDefaultFactory(cfg)('whatsapp', ctx)).not.toBeNull();
  });
});

describe('telegram 2FA password flow (fake adapter)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let mgr: ChannelManager;
  let cookie = '';
  let channelId = '';
  let received: string[] = [];
  let ctxRef: AdapterContext;

  class Fake implements ChannelAdapter {
    constructor(ctx: AdapterContext) { ctxRef = ctx; }
    async start() { ctxRef.events.onStatus('password'); }
    async stop() {}
    async logout() {}
    submitPassword(pw: string) { received.push(pw); ctxRef.events.onStatus('connected'); }
    async sendText() { return {}; }
  }
  const factory: AdapterFactory = (_t, ctx) => new Fake(ctx);
  const call = (method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method, url, payload, remoteAddress: '10.9.0.1', headers: { origin: ORIGIN, cookie } });
  const tick = () => new Promise((r) => setTimeout(r, 30));

  beforeAll(async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    await db.query(`INSERT INTO users (email,name,role,password_hash) VALUES ('a@t.io','a','admin',$1)`, [await hashPassword('correct-horse-battery')]);
    mgr = new ChannelManager(db, cfg, factory);
    app = await buildApp(cfg, db, mgr);
    const r = await app.inject({ method: 'POST', url: '/auth/login', remoteAddress: '10.9.0.2', headers: { origin: ORIGIN }, payload: { email: 'a@t.io', password: 'correct-horse-battery' } });
    cookie = `botwa_sid=${r.cookies[0]!.value}`;
    channelId = (await call('POST', '/channels', { type: 'telegram', label: 'TG' })).json().id;
  });
  afterAll(async () => { await app.close(); await db.end(); });

  it('rejects a password when none was requested', async () => {
    expect((await call('POST', `/channels/${channelId}/password`, { password: 'x' })).statusCode).toBe(409);
  });
  it('accepts it only in "password" state, never persists it, audits without the value', async () => {
    await call('POST', `/channels/${channelId}/start`);
    await tick();
    expect(mgr.snapshot(channelId).status).toBe('password');
    expect((await call('POST', `/channels/${channelId}/password`, { password: 'hunter2-secret' })).statusCode).toBe(200);
    expect(received).toEqual(['hunter2-secret']);
    await tick();
    expect(mgr.snapshot(channelId).status).toBe('connected');
    const dump = JSON.stringify((await db.query('SELECT * FROM audit_log')).rows) + JSON.stringify((await db.query('SELECT * FROM channel_auth')).rows);
    expect(dump).not.toContain('hunter2-secret');
  });
});

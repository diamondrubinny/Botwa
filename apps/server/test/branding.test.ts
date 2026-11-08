import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ChannelManager } from '../src/channels/manager.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { extractBrandColors, extractLogoCandidates, sniffImage, stylesheetUrls } from '../src/branding.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';

const ORIGIN = 'https://panel.test';
const PW = 'correct-horse-battery';
const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test', ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false', MEDIA_ALLOW_UNSCANNED: 'true' });
const db = createDb(cfg.DATABASE_URL);
let app: Awaited<ReturnType<typeof buildApp>>;
let mgr: ChannelManager;
const cookies: Record<string, string> = {};
let ip = 0;
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, who?: string, payload?: object | Buffer, headers: Record<string, string> = {}) =>
  app.inject({ method, url, payload: payload as never, remoteAddress: `10.70.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, ...(who ? { cookie: cookies[who]! } : {}), ...headers } });
const upload = (who: string, name: string, bytes: Buffer) => {
  const b = '----b';
  const body = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: image/png\r\n\r\n`), bytes, Buffer.from(`\r\n--${b}--\r\n`)]);
  return call('POST', '/branding/logo', who, body, { 'content-type': `multipart/form-data; boundary=${b}` });
};
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(64)]);

beforeAll(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  mgr = new ChannelManager(db, cfg, () => null);
  app = await buildApp(cfg, db, mgr);
  for (const [e, r] of [['admin', 'admin'], ['agent', 'agent']] as const) {
    await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4)', [`${e}@t.io`, e, r, await hashPassword(PW)]);
    cookies[e] = `botwa_sid=${(await call('POST', '/auth/login', undefined, { email: `${e}@t.io`, password: PW })).cookies[0]!.value}`;
  }
});
afterAll(async () => { await mgr.stopAll(); await app.close(); await db.end(); });

describe('branding API', () => {
  it('is readable without signing in, and only settings managers can change it', async () => {
    expect((await call('GET', '/branding')).json()).toEqual({ appName: 'Botwa', color: null, hasLogo: false, v: 0 });
    expect((await call('PUT', '/branding', 'agent', { appName: 'x', color: null })).statusCode).toBe(403);
    expect((await call('PUT', '/branding', undefined, { appName: 'x', color: null })).statusCode).toBe(401);
    expect((await call('PUT', '/branding', 'admin', { appName: 'x', color: 'red' })).statusCode).toBe(400);
    expect((await call('PUT', '/branding', 'admin', { appName: 'x'.repeat(41), color: null })).statusCode).toBe(400);
    const ok = await call('PUT', '/branding', 'admin', { appName: 'בטיחון', color: '#0F766E' });
    expect(ok.json()).toMatchObject({ appName: 'בטיחון', color: '#0f766e' });
    expect((await call('GET', '/branding')).json()).toMatchObject({ appName: 'בטיחון', color: '#0f766e' });
  });

  it('accepts a PNG logo by its bytes, refuses SVG and disguised files, and serves it locked down', async () => {
    expect((await call('GET', '/branding/logo')).statusCode).toBe(404);
    expect((await upload('agent', 'a.png', PNG)).statusCode).toBe(403);
    expect((await upload('admin', 'a.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).statusCode).toBe(415);
    expect((await upload('admin', 'a.png', Buffer.from('<html><script>alert(1)</script></html>'))).statusCode).toBe(415);
    expect((await upload('admin', 'big.png', Buffer.concat([PNG, Buffer.alloc(600 * 1024)]))).statusCode).toBe(413);
    const ok = await upload('admin', 'logo.png', PNG);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().hasLogo).toBe(true);
    const got = await call('GET', '/branding/logo');
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    expect(String(got.headers['content-security-policy'])).toContain("default-src 'none'");
    expect(got.rawPayload.equals(PNG)).toBe(true);
    expect((await call('DELETE', '/branding/logo', 'admin')).json().hasLogo).toBe(false);
  });

  it('never fetches internal addresses for colours or a logo (SSRF)', async () => {
    for (const url of ['http://127.0.0.1/', 'http://localhost:8080/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/']) {
      const r = await call('POST', '/branding/extract', 'admin', { url });
      expect(r.statusCode).toBe(422);
      expect(r.json().error).toBe('blocked_address');
    }
    expect((await call('POST', '/branding/logo-from-url', 'admin', { url: 'http://127.0.0.1/logo.png' })).json().error).toBe('blocked_address');
    expect((await call('POST', '/branding/extract', 'agent', { url: 'https://example.com' })).statusCode).toBe(403);
  });
});

describe('colour extraction (pure)', () => {
  const html = `<html><head><meta name="theme-color" content="#0f766e"><link rel="stylesheet" href="/a.css"><link rel="manifest" href="/m.json">
    <link rel="icon" href="/favicon.png"><link rel="apple-touch-icon" href="https://cdn.example.com/touch.png"><meta property="og:image" content="/og.jpg">
    <style>:root { --brand-primary: #c2410c; --gray: #888888; } .x { color: #1d4ed8 } .y { background: #1d4ed8 } .z { color: #ffffff; background: #000 }</style></head></html>`;
  it('ranks the declared colours first, skips greys, black and white, and merges near-duplicates', () => {
    const c = extractBrandColors(html, ['.a { color: #1d4ed9; } .b { border-color: rgb(30, 78, 216); } .c { color: #fafafa }'], '#7c3aed');
    expect(c[0]).toEqual({ hex: '#0f766e', source: 'theme-color' });
    expect(c[1]).toEqual({ hex: '#7c3aed', source: 'manifest' });
    expect(c.map((x) => x.hex)).toContain('#c2410c');
    expect(c.find((x) => x.hex === '#c2410c')!.source).toBe('css-var');
    expect(c.map((x) => x.hex)).not.toContain('#888888');
    expect(c.map((x) => x.hex)).not.toContain('#ffffff');
    expect(c.filter((x) => x.hex.startsWith('#1d4ed') || x.hex === '#1e4ed8').length).toBe(1);
  });
  it('finds logo candidates as absolute https URLs and the stylesheets to read', () => {
    expect(extractLogoCandidates(html, 'https://site.example/page')).toEqual(['https://site.example/favicon.png', 'https://cdn.example.com/touch.png', 'https://site.example/og.jpg']);
    expect(stylesheetUrls(html, 'https://site.example/page')).toEqual(['https://site.example/a.css']);
    expect(extractLogoCandidates('<link rel="icon" href="javascript:alert(1)"><link rel="icon" href="http://insecure.example/i.png">', 'https://s.example/')).toEqual([]);
  });
  it('recognises images by their first bytes', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('image/jpeg');
    expect(sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]))).toBe('image/webp');
    expect(sniffImage(Buffer.from('GIF89a......'))).toBeNull();
  });
});

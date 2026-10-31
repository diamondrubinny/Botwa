import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ChannelManager } from '../src/channels/manager.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test';
const db = createDb(DB_URL);
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'botwa-web-'));
  mkdirSync(path.join(root, 'assets'));
  writeFileSync(path.join(root, 'index.html'), '<!doctype html><html lang="he"><title>x</title>');
  writeFileSync(path.join(root, 'assets', 'app-abc123.js'), 'console.log(1)');
  writeFileSync(path.join(root, 'assets', 'app-abc123.css'), 'body{}');
  writeFileSync(path.join(os.tmpdir(), 'secret-outside-root.txt'), 'TOP SECRET');
  const cfg = loadConfig({
    NODE_ENV: 'test', DATABASE_URL: DB_URL, ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: 'https://panel.test',
    COOKIE_SECURE: 'false', WEB_DIST: root,
  });
  app = await buildApp(cfg, db, new ChannelManager(db, cfg));
});
afterAll(async () => { await app.close(); await db.end(); });

describe('static panel serving', () => {
  it('serves index with no-cache and hashed assets as immutable, with correct types and nosniff', async () => {
    const idx = await app.inject({ url: '/' });
    expect(idx.statusCode).toBe(200);
    expect(idx.headers['content-type']).toContain('text/html');
    expect(idx.headers['cache-control']).toBe('no-cache');
    expect(idx.headers['content-security-policy']).toContain("default-src 'self'"); // helmet still applies
    const js = await app.inject({ url: '/assets/app-abc123.js' });
    expect(js.headers['content-type']).toContain('text/javascript');
    expect(js.headers['cache-control']).toContain('immutable');
    expect(js.headers['x-content-type-options']).toBe('nosniff');
    expect((await app.inject({ url: '/assets/app-abc123.css' })).headers['content-type']).toContain('text/css');
  });
  it('supports conditional requests', async () => {
    const first = await app.inject({ url: '/assets/app-abc123.js' });
    const again = await app.inject({ url: '/assets/app-abc123.js', headers: { 'if-none-match': String(first.headers.etag) } });
    expect(again.statusCode).toBe(304);
  });
  it('does not expose anything outside the web root (traversal, encoded, unknown, directories)', async () => {
    for (const url of ['/../secret-outside-root.txt', '/%2e%2e/secret-outside-root.txt', '/assets/../../secret-outside-root.txt', '/assets/', '/assets', '/nope.js', '/.env', '/package.json']) {
      const r = await app.inject({ url });
      expect(r.statusCode, url).toBe(404);
      expect(r.body).not.toContain('TOP SECRET');
    }
  });
});

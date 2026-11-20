import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ChannelManager } from '../src/channels/manager.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';

const base = { NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test', ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: 'https://panel.test', COOKIE_SECURE: 'false' };
const FP = '65:8D:BC:F6:0D:91:BA:BC:28:FE:C3:30:A3:80:0C:FB:02:4A:16:9F:36:80:FB:B5:A2:54:46:54:D9:2A:42:7E';
const db = createDb(base.DATABASE_URL);
afterAll(async () => { await db.end(); });

describe('Android app link (assetlinks.json)', () => {
  it('is served only when a fingerprint is configured, with the package and fingerprints', async () => {
    await migrate(db);
    const off = await buildApp(loadConfig(base), db, new ChannelManager(db, loadConfig(base)));
    expect((await off.inject({ url: '/.well-known/assetlinks.json' })).statusCode).toBe(404);
    await off.close();
    const cfg = loadConfig({ ...base, ANDROID_APP_SHA256: FP.toLowerCase() });
    const on = await buildApp(cfg, db, new ChannelManager(db, cfg));
    const r = await on.inject({ url: '/.well-known/assetlinks.json' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: 'net.rubinny.botwa', sha256_cert_fingerprints: [FP] } }]);
    await on.close();
  });
  it('refuses a malformed fingerprint or package at start-up', () => {
    expect(() => loadConfig({ ...base, ANDROID_APP_SHA256: 'abc' })).toThrow();
    expect(() => loadConfig({ ...base, ANDROID_APP_PACKAGE: 'not a package' })).toThrow();
  });
});

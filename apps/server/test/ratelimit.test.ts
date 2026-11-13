import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ChannelManager } from '../src/channels/manager.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';

const ORIGIN = 'https://panel.test';
const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test';
const db = createDb(DB_URL);
const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: DB_URL, ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', RATE_LIMIT_PER_MIN: '60' });
const fakeSid = () => `botwa_sid=${randomBytes(32).toString('base64url')}`;

describe('general request allowance', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => { await migrate(db); app = await buildApp(cfg, db, new ChannelManager(db, cfg, () => null)); });
  afterAll(async () => { await app.close(); await db.end(); });
  const hit = (ip: string, cookie?: string) => app.inject({ url: '/auth/me', remoteAddress: ip, headers: cookie ? { cookie } : {} }).then((r) => r.statusCode);

  it('counts per signed-in browser, so people behind one office address do not share one allowance', async () => {
    const a = fakeSid(), b = fakeSid();
    for (let i = 0; i < 60; i++) expect(await hit('10.70.0.1', a)).not.toBe(429);
    expect(await hit('10.70.0.1', a)).toBe(429);
    expect(await hit('10.70.0.1', b)).not.toBe(429);   // a colleague on the same address still has theirs
  });

  it('without a session it is per address', async () => {
    for (let i = 0; i < 60; i++) await hit('10.70.0.2');
    expect(await hit('10.70.0.2')).toBe(429);
    expect(await hit('10.70.0.2', 'botwa_sid=not-a-real-token')).toBe(429);   // a cookie of the wrong shape changes nothing
  });

  it('made-up cookies cannot multiply the allowance of one address beyond 10x', async () => {
    let refused = false;
    for (let i = 0; i < 620 && !refused; i++) refused = (await hit('10.70.0.3', fakeSid())) === 429;
    expect(refused).toBe(true);
  });

  it('sign-in keeps its own per-address limit whatever cookie is sent', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await app.inject({ method: 'POST', url: '/auth/login', remoteAddress: '10.70.0.4', payload: { email: 'x@y.io', password: 'nope-nope-nope' }, headers: { origin: ORIGIN, cookie: fakeSid() } })).statusCode);
    expect(codes.slice(-2)).toEqual([429, 429]);
  });
});

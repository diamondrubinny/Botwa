import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { stripImageMetadata } from '../src/avatars.js';
import { ChannelManager } from '../src/channels/manager.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const chunk = (type: string, data: Buffer) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); data.copy(b, 8); return b; };
// the same PNG with a text chunk (e.g. author / location) inserted after IHDR
const PNG_TEXT = Buffer.concat([PNG.subarray(0, 33), chunk('tEXt', Buffer.from('Comment\0GPS 32.08,34.78')), PNG.subarray(33)]);
const seg = (marker: number, data: Buffer) => { const b = Buffer.alloc(4 + data.length); b[0] = 0xff; b[1] = marker; b.writeUInt16BE(data.length + 2, 2); data.copy(b, 4); return b; };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')), seg(0xe1, Buffer.from('Exif\0\0GPS 32.08,34.78 iPhone', 'latin1')), seg(0xfe, Buffer.from('comment')), seg(0xdb, Buffer.alloc(65, 1)), seg(0xda, Buffer.alloc(10, 2)), Buffer.from([0x12, 0x34, 0xff, 0xd9])]);

describe('image metadata removal', () => {
  it('drops EXIF/XMP/comments from JPEG and text chunks from PNG, keeps the picture', () => {
    const j = stripImageMetadata(JPEG)!;
    expect(j.mime).toBe('image/jpeg');
    expect(j.data.toString('latin1')).not.toContain('GPS');
    expect(j.data.toString('latin1')).not.toContain('comment');
    expect(j.data.toString('latin1')).toContain('JFIF');
    expect(j.data.subarray(-4)).toEqual(Buffer.from([0x12, 0x34, 0xff, 0xd9]));
    const p = stripImageMetadata(PNG_TEXT)!;
    expect(p.data.toString('latin1')).not.toContain('GPS');
    expect(p.data.equals(PNG)).toBe(true);
  });
  it('refuses anything else', () => {
    expect(stripImageMetadata(Buffer.from('<svg onload=alert(1)>'))).toBeNull();
    expect(stripImageMetadata(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(20)]))).toBeNull();
    expect(stripImageMetadata(PNG.subarray(0, 20))).toBeNull();        // cut short
    expect(stripImageMetadata(JPEG.subarray(0, 30))).toBeNull();
  });
});

const ORIGIN = 'https://panel.test';
const PW = 'correct-horse-battery';
const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test', ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false', MEDIA_ALLOW_UNSCANNED: 'true' });
const db = createDb(cfg.DATABASE_URL);
let app: Awaited<ReturnType<typeof buildApp>>;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
let ip = 0;
const call = (method: 'GET' | 'POST' | 'DELETE', url: string, who?: string) =>
  app.inject({ method, url, remoteAddress: `10.99.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, ...(who ? { cookie: cookies[who]! } : {}) } });
const upload = (url: string, who: string, buf: Buffer, name = 'me.jpg') => {
  const b = '----av';
  const body = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), buf, Buffer.from(`\r\n--${b}--\r\n`)]);
  return app.inject({ method: 'POST', url, payload: body, remoteAddress: `10.99.8.${++ip % 250}`, headers: { origin: ORIGIN, cookie: cookies[who]!, 'content-type': `multipart/form-data; boundary=${b}` } });
};

beforeAll(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  app = await buildApp(cfg, db, new ChannelManager(db, cfg));
  for (const [e, r] of [['adm', 'admin'], ['a1', 'agent'], ['a2', 'agent']] as const) {
    ids[e] = (await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4) RETURNING id', [`${e}@t.io`, e, r, await hashPassword(PW)])).rows[0].id;
    cookies[e] = `botwa_sid=${(await app.inject({ method: 'POST', url: '/auth/login', payload: { email: `${e}@t.io`, password: PW }, remoteAddress: `10.99.9.${++ip}`, headers: { origin: ORIGIN } })).cookies[0]!.value}`;
  }
});
afterAll(async () => { await app.close(); await db.end(); });

describe('profile pictures', () => {
  it('anyone sets their own; it is stored without metadata and served to signed-in staff only', async () => {
    expect((await upload('/me/avatar', 'a1', JPEG)).json()).toMatchObject({ ok: true });
    const me = (await app.inject({ url: '/auth/me', headers: { cookie: cookies.a1! } })).json();
    expect(me.avatarV).toBeGreaterThan(0);
    const got = await call('GET', `/users/${ids.a1}/avatar`, 'a2');
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/jpeg');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    expect(got.rawPayload.toString('latin1')).not.toContain('GPS');
    expect((await call('GET', `/users/${ids.a1}/avatar`)).statusCode).toBe(401);
    expect((await call('GET', `/users/${ids.a2}/avatar`, 'a1')).statusCode).toBe(404);
    expect((await call('DELETE', '/me/avatar', 'a1')).statusCode).toBe(200);
    expect((await call('GET', `/users/${ids.a1}/avatar`, 'a2')).statusCode).toBe(404);
  });
  it('refuses other formats and large files', async () => {
    expect((await upload('/me/avatar', 'a1', Buffer.from('<svg/>'), 'x.svg')).json()).toEqual({ error: 'unsupported_image' });
    expect((await upload('/me/avatar', 'a1', Buffer.concat([JPEG, Buffer.alloc(600 * 1024)]))).statusCode).toBe(413);
  });
  it('managers set others\' pictures; agents cannot', async () => {
    expect((await upload(`/users/${ids.a2}/avatar`, 'a1', PNG, 'p.png')).statusCode).toBe(403);
    expect((await upload(`/users/${ids.a2}/avatar`, 'adm', PNG_TEXT, 'p.png')).statusCode).toBe(200);
    const list = (await app.inject({ url: '/users', headers: { cookie: cookies.adm! } })).json() as { id: string; avatarV: number | null }[];
    expect(list.find((u) => u.id === ids.a2)!.avatarV).toBeGreaterThan(0);
    expect(list.find((u) => u.id === ids.a1)!.avatarV).toBeNull();
    expect((await call('DELETE', `/users/${ids.a2}/avatar`, 'adm')).statusCode).toBe(200);
  });

  it('a gallery of built-in pictures plus ones managers add; anyone picks one', async () => {
    const list = (await call('GET', '/avatars/gallery', 'a1')).json().items as { id: string; builtin: boolean }[];
    expect(list.filter((x) => x.builtin)).toHaveLength(24);
    expect((await call('GET', '/avatars/gallery')).statusCode).toBe(401);
    const img = await call('GET', '/avatars/gallery/p01', 'a1');
    expect(img.headers['content-type']).toBe('image/png');
    expect((await call('GET', '/avatars/gallery/p99', 'a1')).statusCode).toBe(404);
    expect((await call('GET', '/avatars/gallery/..%2F..%2Fetc%2Fpasswd', 'a1')).statusCode).toBe(404);
    const pickMine = (id: string, who = 'a1') => app.inject({ method: 'POST', url: '/me/avatar/gallery', payload: { id }, remoteAddress: `10.99.7.${++ip % 250}`, headers: { origin: ORIGIN, cookie: cookies[who]! } });
    expect((await pickMine('p05')).json()).toEqual({ ok: true });
    expect((await call('GET', `/users/${ids.a1}/avatar`, 'a2')).statusCode).toBe(200);
    expect((await pickMine('../x')).statusCode).toBe(400);
    // managers add pictures (checked like uploads); agents cannot
    expect((await upload('/avatars/gallery', 'a1', PNG, 'team.png')).statusCode).toBe(403);
    const added = await upload('/avatars/gallery', 'adm', PNG_TEXT, 'team.png');
    expect(added.statusCode).toBe(201);
    const gid = added.json().id as string;
    expect((await call('GET', '/avatars/gallery', 'a2')).json().items.some((x: { id: string; builtin: boolean }) => x.id === gid && !x.builtin)).toBe(true);
    expect((await call('GET', `/avatars/gallery/${gid}`, 'a2')).rawPayload.toString('latin1')).not.toContain('GPS');
    expect((await pickMine(gid, 'a2')).json()).toEqual({ ok: true });
    expect((await call('DELETE', '/avatars/gallery/p01', 'adm')).statusCode).toBe(400);      // built-in ones stay
    expect((await call('DELETE', `/avatars/gallery/${gid}`, 'a1')).statusCode).toBe(403);
    expect((await call('DELETE', `/avatars/gallery/${gid}`, 'adm')).statusCode).toBe(200);
    expect((await call('GET', `/users/${ids.a2}/avatar`, 'a1')).statusCode).toBe(200);        // a picture already chosen is kept
  });
});

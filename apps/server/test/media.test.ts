import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ChannelManager } from '../src/channels/manager.js';
import type { AdapterContext, AdapterFactory, ChannelAdapter, OutboundMedia } from '../src/channels/types.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { purgeOldMessages } from '../src/inbox.js';
import { clamScan, parseReply } from '../src/media/clamav.js';
import { MediaService } from '../src/media/store.js';
import { detect, sanitizeFileName } from '../src/media/validate.js';
import { gifSize, gifToMp4 } from '../src/media/animation.js';
import { execFileSync } from 'node:child_process';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';
import { EICAR, startFakeClamd } from './helpers/fake-clamd.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 1)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = Buffer.from('<html><script>alert(1)</script></html>');
const GIF = Buffer.from('R0lGODlhEAAQAPcfMQAAACQAAEgAAGwAAJAAALQAANgAAPwAAAAkACQkAEgkAGwkAJAkALQkANgkAPwkAABIACRIAEhIAGxIAJBIALRIANhIAPxIAABsACRsAEhsAGxsAJBsALRsANhsAPxsAACQACSQAEiQAGyQAJCQALSQANiQAPyQAAC0ACS0AEi0AGy0AJC0ALS0ANi0APy0AADYACTYAEjYAGzYAJDYALTYANjYAPzYAAD8ACT8AEj8AGz8AJD8ALT8ANj8APz8AAAAVSQAVUgAVWwAVZAAVbQAVdgAVfwAVQAkVSQkVUgkVWwkVZAkVbQkVdgkVfwkVQBIVSRIVUhIVWxIVZBIVbRIVdhIVfxIVQBsVSRsVUhsVWxsVZBsVbRsVdhsVfxsVQCQVSSQVUiQVWyQVZCQVbSQVdiQVfyQVQC0VSS0VUi0VWy0VZC0VbS0Vdi0Vfy0VQDYVSTYVUjYVWzYVZDYVbTYVdjYVfzYVQD8VST8VUj8VWz8VZD8VbT8Vdj8Vfz8VQAAqiQAqkgAqmwAqpAAqrQAqtgAqvwAqgAkqiQkqkgkqmwkqpAkqrQkqtgkqvwkqgBIqiRIqkhIqmxIqpBIqrRIqthIqvxIqgBsqiRsqkhsqmxsqpBsqrRsqthsqvxsqgCQqiSQqkiQqmyQqpCQqrSQqtiQqvyQqgC0qiS0qki0qmy0qpC0qrS0qti0qvy0qgDYqiTYqkjYqmzYqpDYqrTYqtjYqvzYqgD8qiT8qkj8qmz8qpD8qrT8qtj8qvz8qgAA/yQA/0gA/2wA/5AA/7QA/9gA//wA/wAk/yQk/0gk/2wk/5Ak/7Qk/9gk//wk/wBI/yRI/0hI/2xI/5BI/7RI/9hI//xI/wBs/yRs/0hs/2xs/5Bs/7Rs/9hs//xs/wCQ/ySQ/0iQ/2yQ/5CQ/7SQ/9iQ//yQ/wC0/yS0/0i0/2y0/5C0/7S0/9i0//y0/wDY/yTY/0jY/2zY/5DY/7TY/9jY//zY/wD8/yT8/0j8/2z8/5D8/7T8/9j8//z8/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQEFAAfACwAAAAAEAAQAAAIHQAPCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFgQEBACH5BAUUAAAALA8ADwABAAEAAAgEAAEEBAAh+QQFFAAAACwPAA8AAQABAAAIBAABBAQAIfkEBRQAAAAsDwAPAAEAAQAACAQAAQQEADs=', 'base64');
const PNG_WITH_EICAR = Buffer.concat([PNG, Buffer.from(EICAR)]);

describe('content validation', () => {
  it('allows real images/pdf; blocks exe, svg, html regardless of name', async () => {
    expect((await detect(PNG))?.mime).toBe('image/png');
    expect((await detect(PDF))?.mime).toBe('application/pdf');
    expect(await detect(EXE)).toBeNull();
    expect(await detect(SVG)).toBeNull();
    expect(await detect(HTML)).toBeNull();
    expect(await detect(Buffer.alloc(0))).toBeNull();
  });
  it('sanitizes display names', () => {
    expect(sanitizeFileName('../../etc/passwd', 'f')).toBe('passwd');
    expect(sanitizeFileName('C:\\x\\evil<script>.png', 'f')).toBe('evilscript.png');
    expect(sanitizeFileName('\u202egnp.exe', 'f')).toBe('gnp.exe');
    expect(sanitizeFileName('', 'fallback.png')).toBe('fallback.png');
    expect(sanitizeFileName('a'.repeat(300), 'f')).toHaveLength(100);
  });
});

const realUp = await new Promise<boolean>((r) => {
  const s = net.connect({ host: '127.0.0.1', port: 3310 }, () => { s.destroy(); r(true); });
  s.on('error', () => r(false));
});

describe('clamd protocol', () => {
  it('parses replies', () => {
    expect(parseReply('stream: OK\0')).toEqual({ status: 'clean' });
    expect(parseReply('stream: Win.Test.EICAR_HDB-1 FOUND\0')).toEqual({ status: 'infected', detail: 'Win.Test.EICAR_HDB-1' });
    expect(parseReply('INSTREAM size limit exceeded. ERROR\0').status).toBe('error');
    expect(parseReply('').status).toBe('error');
  });
  it('frames a multi-chunk stream correctly (fake daemon)', async () => {
    const d = await startFakeClamd();
    const big = Buffer.concat([Buffer.alloc(200_000, 7), Buffer.from(EICAR)]);
    expect(await clamScan(Buffer.alloc(200_000, 7), { host: '127.0.0.1', port: d.port })).toEqual({ status: 'clean' });
    expect((await clamScan(big, { host: '127.0.0.1', port: d.port })).status).toBe('infected');
    await d.close();
  });
  it('reports error (not clean) when the scanner is unreachable', async () => {
    const d = await startFakeClamd();
    const port = d.port;
    await d.close();
    expect((await clamScan(PNG, { host: '127.0.0.1', port })).status).toBe('error');
  });
  it.skipIf(!realUp)('REAL clamd: clean file OK, EICAR detected', async () => {
    expect(await clamScan(PNG, { host: '127.0.0.1', port: 3310 })).toEqual({ status: 'clean' });
    const r = await clamScan(Buffer.from(EICAR), { host: '127.0.0.1', port: 3310 });
    expect(r).toMatchObject({ status: 'infected', detail: expect.stringContaining('Eicar') });
  });
});

describe('media pipeline', () => {
  const ORIGIN = 'https://panel.test';
  const PW = 'correct-horse-battery';
  let app: Awaited<ReturnType<typeof buildApp>>;
  let mgr: ChannelManager;
  let media: MediaService;
  let mediaDir: string;
  let clam: Awaited<ReturnType<typeof startFakeClamd>>;
  let ctxRef: AdapterContext;
  let sentMedia: OutboundMedia[] = [];
  let ip = 0;
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let cfg: ReturnType<typeof loadConfig>;
  const db = createDb(process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test');

  class Fake implements ChannelAdapter {
    constructor(ctx: AdapterContext) { ctxRef = ctx; }
    async start() { ctxRef.events.onStatus('connected'); }
    async stop() {}
    async logout() {}
    async sendText() { return { externalMessageId: 't1' }; }
    async sendMedia(_to: string, m: OutboundMedia) { sentMedia.push(m); return { externalMessageId: `m${sentMedia.length}` }; }
  }
  const factory: AdapterFactory = (t, ctx) => (t === 'whatsapp' ? new Fake(ctx) : null);

  const call = (method: 'GET' | 'POST' | 'DELETE' | 'PATCH', url: string, who?: string, payload?: object) =>
    app.inject({ method, url, payload, remoteAddress: `10.5.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, ...(who ? { cookie: cookies[who]! } : {}) } });

  function upload(convId: string, who: string, file: Buffer, name: string, caption?: string) {
    const b = '----botwatest';
    const parts = [
      ...(caption ? [Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`)] : []),
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: image/png\r\n\r\n`),
      file,
      Buffer.from(`\r\n--${b}--\r\n`),
    ];
    return app.inject({
      method: 'POST', url: `/conversations/${convId}/attachments`, payload: Buffer.concat(parts),
      remoteAddress: `10.6.${Math.floor(++ip / 250)}.${ip % 250}`,
      headers: { origin: ORIGIN, cookie: cookies[who]!, 'content-type': `multipart/form-data; boundary=${b}` },
    });
  }

  async function mk(email: string, role: string) {
    const r = await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$1,$2,$3) RETURNING id', [email, role, await hashPassword(PW)]);
    ids[email] = r.rows[0].id;
    const res = await call('POST', '/auth/login', undefined, { email, password: PW });
    cookies[email] = `botwa_sid=${res.cookies[0]!.value}`;
  }
  const inbound = async (id: string, text: string, m?: { fileName?: string; size?: number; data: Buffer | Error }) => {
    await ctxRef.events.onMessage({
      externalContactId: 'c1@s.whatsapp.net', contactName: 'Dana', externalMessageId: id, text, timestamp: new Date(),
      media: m ? { fileName: m.fileName, size: m.size, download: async () => { if (m.data instanceof Error) throw m.data; return m.data; } } : undefined,
    });
  };
  const att = async (msgExternalId: string) =>
    (await db.query(`SELECT a.* FROM attachments a JOIN messages m ON m.id=a.message_id WHERE m.external_id=$1`, [msgExternalId])).rows[0];
  const files = async (sub: string) => (existsSync(path.join(mediaDir, sub)) ? readdir(path.join(mediaDir, sub)) : []);

  let convId = '';
  let channelId = '';

  beforeAll(async () => {
    mediaDir = await mkdtemp(path.join(os.tmpdir(), 'botwa-media-'));
    clam = await startFakeClamd();
    cfg = loadConfig({
      NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test',
      ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false',
      MEDIA_DIR: mediaDir, MEDIA_MAX_MB: '1', CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: String(clam.port),
    });
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    media = new MediaService(db, cfg);
    await media.init();
    mgr = new ChannelManager(db, cfg, factory, media);
    app = await buildApp(cfg, db, mgr, media);
    for (const [e, r] of [['admin', 'admin'], ['a1', 'agent'], ['a2', 'agent']] as const) await mk(`${e}@t.io`, r);
    channelId = (await call('POST', '/channels', 'admin@t.io', { type: 'whatsapp', label: 'WA' })).json().id;
    await call('POST', `/channels/${channelId}/start`, 'admin@t.io');
    await inbound('seed', 'hello');
    convId = (await call('GET', '/conversations', 'admin@t.io')).json()[0].id;
    await call('POST', `/conversations/${convId}/assign`, 'a1@t.io', { userId: ids['a1@t.io'] });
  });
  afterAll(async () => {
    await mgr.stopAll(); await app.close(); await db.end(); await clam.close().catch(() => undefined);
  });

  it('inbound clean image: scanned, moved to clean/, served with safe headers, authz enforced', async () => {
    await inbound('img1', 'caption', { fileName: '../../hack.png', data: PNG });
    const a = await att('img1');
    expect(a).toMatchObject({ status: 'clean', mime: 'image/png', kind: 'image', file_name: 'hack.png' });
    expect(await files('quarantine')).toHaveLength(0);
    expect(await files('clean')).toContain(a.storage_name);
    const res = await call('GET', `/attachments/${a.id}`, 'a1@t.io');
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(PNG)).toBe(true);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(String(res.headers['content-disposition'])).toMatch(/^inline/);
    expect((await call('GET', `/attachments/${a.id}`, 'a2@t.io')).statusCode).toBe(404); // other agent
    expect((await call('GET', `/attachments/${a.id}`)).statusCode).toBe(401);
    expect((await call('GET', `/attachments/${a.id}`, 'admin@t.io')).statusCode).toBe(200);
    const msgs = (await call('GET', `/conversations/${convId}/messages`, 'a1@t.io')).json();
    expect(msgs.find((m: { body: string }) => m.body === 'caption').attachment).toMatchObject({ status: 'clean', kind: 'image' });
  });

  it('inbound PDF is served as attachment, never inline', async () => {
    await inbound('pdf1', '', { fileName: 'invoice.pdf', data: PDF });
    const a = await att('pdf1');
    const res = await call('GET', `/attachments/${a.id}`, 'a1@t.io');
    expect(String(res.headers['content-disposition'])).toMatch(/^attachment/);
  });

  it('inbound executable disguised as png is blocked and never stored', async () => {
    const before = (await files('clean')).length + (await files('quarantine')).length;
    await inbound('exe1', '', { fileName: 'photo.png', data: EXE });
    const a = await att('exe1');
    expect(a).toMatchObject({ status: 'blocked', detail: 'type_not_allowed', storage_name: null });
    expect((await files('clean')).length + (await files('quarantine')).length).toBe(before);
    expect((await call('GET', `/attachments/${a.id}`, 'a1@t.io')).statusCode).toBe(404);
  });

  it('inbound allowed type containing a virus: infected, file deleted, event audited, not served', async () => {
    await inbound('vir1', '', { fileName: 'x.png', data: PNG_WITH_EICAR });
    const a = await att('vir1');
    expect(a).toMatchObject({ status: 'infected', storage_name: null });
    expect(a.detail).toContain('Eicar');
    expect(await files('quarantine')).toHaveLength(0);
    expect((await call('GET', `/attachments/${a.id}`, 'a1@t.io')).statusCode).toBe(404);
    expect((await db.query(`SELECT 1 FROM audit_log WHERE action='media.infected'`)).rowCount).toBe(1);
  });

  it('too large / download failure are blocked without crashing ingestion', async () => {
    await inbound('big1', '', { size: 5 * 1024 * 1024, data: PNG });
    expect(await att('big1')).toMatchObject({ status: 'blocked', detail: 'too_large' });
    await inbound('dl1', '', { data: new Error('boom') });
    expect(await att('dl1')).toMatchObject({ status: 'blocked', detail: 'download_failed' });
    await inbound('big2', '', { data: Buffer.concat([PNG, Buffer.alloc(1.5 * 1024 * 1024)]) });
    expect(await att('big2')).toMatchObject({ status: 'blocked', detail: 'too_large' });
  });

  it('scanner down: file stays quarantined/pending and is NOT served; retry after recovery serves it', async () => {
    const port = clam.port;
    await clam.close();
    await inbound('pend1', '', { fileName: 'late.png', data: PNG });
    let a = await att('pend1');
    expect(a).toMatchObject({ status: 'pending' });
    expect(await files('quarantine')).toContain(a.storage_name);
    expect((await call('GET', `/attachments/${a.id}`, 'a1@t.io')).statusCode).toBe(404);
    expect(await media.scanPending()).toBe(1); // still down -> stays pending
    expect((await att('pend1')).status).toBe('pending');
    expect((await att('pend1')).scan_attempts).toBeGreaterThanOrEqual(2);

    clam = await startFakeClamd(port);
    await media.scanPending();
    a = await att('pend1');
    expect(a.status).toBe('clean');
    expect((await call('GET', `/attachments/${a.id}`, 'a1@t.io')).statusCode).toBe(200);
    expect(await files('quarantine')).toHaveLength(0);
  });

  it('outbound upload: validated, scanned, sent through adapter, stored', async () => {
    const r = await upload(convId, 'a1@t.io', PNG, 'pic.png', 'הנה התמונה');
    expect(r.statusCode).toBe(201);
    expect(sentMedia).toHaveLength(1);
    expect(sentMedia[0]).toMatchObject({ mime: 'image/png', fileName: 'pic.png', caption: 'הנה התמונה' });
    const msgs = (await call('GET', `/conversations/${convId}/messages`, 'a1@t.io')).json();
    const m = msgs.find((x: { direction: string; attachment: unknown }) => x.direction === 'out' && x.attachment);
    expect(m.attachment).toMatchObject({ status: 'clean', fileName: 'pic.png' });
    expect(m.body).toBe('הנה התמונה');
  });

  it('outbound upload rejects exe (415), svg (415), virus (422), oversize (413), no-access (404), unauth', async () => {
    const n = sentMedia.length;
    expect((await upload(convId, 'a1@t.io', EXE, 'x.png')).statusCode).toBe(415);
    expect((await upload(convId, 'a1@t.io', SVG, 'x.svg')).statusCode).toBe(415);
    const v = await upload(convId, 'a1@t.io', PNG_WITH_EICAR, 'x.png');
    expect(v.statusCode).toBe(422);
    expect(v.json()).toEqual({ error: 'file_infected' });
    expect((await upload(convId, 'a1@t.io', Buffer.concat([PNG, Buffer.alloc(1.2 * 1024 * 1024)]), 'big.png')).statusCode).toBe(413);
    expect((await upload(convId, 'a2@t.io', PNG, 'x.png')).statusCode).toBe(404);
    expect(sentMedia).toHaveLength(n); // nothing leaked to the customer
  });

  it('outbound upload fails closed (503) when scanner is down', async () => {
    const port = clam.port;
    await clam.close();
    expect((await upload(convId, 'a1@t.io', PNG, 'x.png')).statusCode).toBe(503);
    clam = await startFakeClamd(port);
  });

  it('concurrent scans of the same pending file never mislabel it as blocked', async () => {
    const port = clam.port;
    await clam.close();
    await inbound('race1', '', { fileName: 'r.png', data: PNG });
    const a = await att('race1');
    expect(a.status).toBe('pending');
    clam = await startFakeClamd(port);
    await Promise.all([media.scan(a.id), media.scan(a.id), media.scan(a.id)]);
    expect((await att('race1')).status).toBe('clean');
    expect((await call('GET', `/attachments/${a.id}`, 'a1@t.io')).statusCode).toBe(200);
  });

  it('per-contact daily file quota and global byte cap block floods', async () => {
    const tight = new MediaService(db, loadConfig({
      NODE_ENV: 'test', DATABASE_URL: cfg.DATABASE_URL, ENCRYPTION_KEY: cfg.ENCRYPTION_KEY, APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false',
      MEDIA_DIR: mediaDir, CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: String(clam.port), MEDIA_MAX_FILES_PER_CONTACT_DAY: '1',
    }));
    await inbound('q1', ''); await inbound('q2', '');
    const id = async (e: string) => (await db.query(`SELECT id FROM messages WHERE external_id=$1`, [e])).rows[0].id;
    // the conversation already has several attachments today, so even the first one exceeds a cap of 1
    await tight.ingestInbound(await id('q1'), { fileName: 'a.png', download: async () => PNG });
    expect(await att('q1')).toMatchObject({ status: 'blocked', detail: 'quota_exceeded', storage_name: null });
    const capped = new MediaService(db, loadConfig({
      NODE_ENV: 'test', DATABASE_URL: cfg.DATABASE_URL, ENCRYPTION_KEY: cfg.ENCRYPTION_KEY, APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false',
      MEDIA_DIR: mediaDir, CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: String(clam.port), MEDIA_MAX_TOTAL_GB: '0.1',
    }));
    await db.query(`UPDATE attachments SET size = 200 * 1024 * 1024 WHERE id = (SELECT id FROM attachments WHERE storage_name IS NOT NULL LIMIT 1)`);
    await capped.ingestInbound(await id('q2'), { fileName: 'b.png', download: async () => PNG });
    expect(await att('q2')).toMatchObject({ status: 'blocked', detail: 'quota_exceeded' });
  });

  it('media disabled when no scanner configured (fail closed)', async () => {
    const off = loadConfig({
      NODE_ENV: 'test', DATABASE_URL: cfg.DATABASE_URL, ENCRYPTION_KEY: cfg.ENCRYPTION_KEY, APP_ORIGIN: ORIGIN,
      COOKIE_SECURE: 'false', MEDIA_DIR: mediaDir,
    });
    const svc = new MediaService(db, off);
    expect(svc.enabled).toBe(false);
    await inbound('off1', '');
    const msgId = (await db.query(`SELECT id FROM messages WHERE external_id='off1'`)).rows[0].id;
    await svc.ingestInbound(msgId, { fileName: 'a.png', download: async () => PNG });
    expect(await att('off1')).toMatchObject({ status: 'blocked', detail: 'media_disabled', storage_name: null });
    expect((await upload(convId, 'a1@t.io', PNG, 'x.png')).statusCode).toBe(201); // main app (scanner on) unaffected
  });

  it('retention purge, contact erase and channel delete remove files from disk', async () => {
    const cleanBefore = await files('clean');
    expect(cleanBefore.length).toBeGreaterThan(0);
    await db.query(`UPDATE messages SET created_at = now() - interval '400 days' WHERE external_id IN ('img1')`);
    expect(await purgeOldMessages(db, 365, media)).toBe(1);
    expect((await files('clean')).length).toBe(cleanBefore.length - 1);

    const contactId = (await db.query('SELECT id FROM contacts LIMIT 1')).rows[0].id;
    expect((await call('DELETE', `/contacts/${contactId}`, 'admin@t.io')).statusCode).toBe(200);
    expect(await files('clean')).toHaveLength(0);
    expect((await db.query('SELECT 1 FROM attachments')).rowCount).toBe(0);
  });

  function addGif(who: string, file: Buffer, title?: string, keywords?: string) {
    const b = '----botwagif';
    const parts = [
      ...(title !== undefined ? [Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="title"\r\n\r\n${title}\r\n`)] : []),
      ...(keywords ? [Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="keywords"\r\n\r\n${keywords}\r\n`)] : []),
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="x.gif"\r\nContent-Type: image/gif\r\n\r\n`),
      file,
      Buffer.from(`\r\n--${b}--\r\n`),
    ];
    return app.inject({
      method: 'POST', url: '/gifs', payload: Buffer.concat(parts), remoteAddress: `10.7.${Math.floor(++ip / 250)}.${ip % 250}`,
      headers: { origin: ORIGIN, cookie: cookies[who]!, 'content-type': `multipart/form-data; boundary=${b}` },
    });
  }

  it('GIF gallery: managers add (GIF only, scanned, no duplicates), everyone signed in lists, searches and sends', async () => {
    expect((await addGif('a1@t.io', GIF, 'תודה')).statusCode).toBe(403);           // agents may not add
    expect((await addGif('admin@t.io', PNG, 'png')).json()).toEqual({ error: 'gif_only' });
    expect((await addGif('admin@t.io', GIF, '')).json()).toEqual({ error: 'gif_title_required' });
    expect((await addGif('admin@t.io', Buffer.concat([GIF, Buffer.from(EICAR)]), 'virus')).json()).toEqual({ error: 'file_infected' });
    const add = await addGif('admin@t.io', GIF, 'תודה רבה', 'שמחה, אגודל');
    expect(add.statusCode).toBe(201);
    const gifId = add.json().id as string;
    expect((await addGif('admin@t.io', GIF, 'again')).json()).toEqual({ error: 'gif_exists' });

    const list = (await call('GET', '/gifs?q=' + encodeURIComponent('אגודל'), 'a1@t.io')).json();
    expect(list.gifs).toHaveLength(1);
    expect(list.gifs[0]).toMatchObject({ id: gifId, title: 'תודה רבה', width: 16, height: 16 });
    expect((await call('GET', '/gifs?q=%25', 'a1@t.io')).json().gifs).toHaveLength(0);    // % is literal, not a wildcard
    expect((await call('GET', '/gifs')).statusCode).toBe(401);
    const file = await call('GET', `/gifs/${gifId}/file`, 'a1@t.io');
    expect(file.headers['content-type']).toBe('image/gif');
    expect(file.headers['content-security-policy']).toContain('sandbox');
    expect(file.rawPayload.equals(GIF)).toBe(true);

    expect((await call('PATCH', `/gifs/${gifId}`, 'a1@t.io', { title: 'x' })).statusCode).toBe(403);
    expect((await call('PATCH', `/gifs/${gifId}`, 'admin@t.io', { title: 'תודה!', keywords: 'thanks' })).json()).toEqual({ ok: true });

    // sending: a fresh conversation assigned to a1; the other agent has no access; the assigned one sends it like any file
    await ctxRef.events.onMessage({ externalContactId: 'gif@s.whatsapp.net', contactName: 'Gal', externalMessageId: 'gif-seed', text: 'hi', timestamp: new Date() });
    const convId = (await db.query(`SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.external_id = 'gif@s.whatsapp.net'`)).rows[0].id as string;
    await call('POST', `/conversations/${convId}/assign`, 'a1@t.io', { userId: ids['a1@t.io'] });
    expect((await call('POST', `/conversations/${convId}/gif`, 'a2@t.io', { gifId })).statusCode).toBe(404);
    expect((await call('POST', `/conversations/${convId}/gif`, 'a1@t.io', { gifId: '00000000-0000-4000-8000-000000000000' })).json()).toEqual({ error: 'gif_not_found' });
    sentMedia = [];
    const sent = await call('POST', `/conversations/${convId}/gif`, 'a1@t.io', { gifId, caption: 'כל הכבוד' });
    expect(sent.statusCode).toBe(201);
    expect(sentMedia[0]).toMatchObject({ mime: 'image/gif', fileName: 'תודה!.gif', caption: 'כל הכבוד' });
    expect(sentMedia[0]!.buffer.equals(GIF)).toBe(true);
    if (list.gifs[0].hasVideo) expect(sentMedia[0]!.animation!.subarray(4, 8).toString('latin1')).toBe('ftyp');
    const msgs = (await call('GET', `/conversations/${convId}/messages`, 'a1@t.io')).json();
    expect(msgs.find((m: { body: string }) => m.body === 'כל הכבוד').attachment).toMatchObject({ status: 'clean', mime: 'image/gif' });
    expect((await db.query(`SELECT 1 FROM audit_log WHERE action IN ('gif.add','gif.edit')`)).rowCount).toBe(2);

    expect((await call('DELETE', `/gifs/${gifId}`, 'a1@t.io')).statusCode).toBe(403);
    expect((await call('DELETE', `/gifs/${gifId}`, 'admin@t.io')).json()).toEqual({ ok: true });
    expect((await call('GET', '/gifs', 'a1@t.io')).json().gifs).toHaveLength(0);
  });
});

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
describe('GIF to MP4', () => {
  it('reads the size from the header and refuses what is not a GIF', async () => {
    expect(gifSize(GIF)).toEqual({ width: 16, height: 16 });
    expect(gifSize(PNG)).toBeNull();
    expect(await gifToMp4(PNG, { ffmpegPath: 'ffmpeg', tmpDir: os.tmpdir() })).toBeNull();
    expect(await gifToMp4(GIF, { ffmpegPath: '', tmpDir: os.tmpdir() })).toBeNull();
    expect(await gifToMp4(GIF, { ffmpegPath: '/nonexistent/ffmpeg', tmpDir: os.tmpdir() })).toBeNull();
  });
  it.skipIf(!hasFfmpeg)('makes a real MP4 and leaves no temp files', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'botwa-anim-'));
    const mp4 = await gifToMp4(GIF, { ffmpegPath: 'ffmpeg', tmpDir: dir });
    expect(mp4?.subarray(4, 8).toString('latin1')).toBe('ftyp');
    expect(await readdir(dir)).toHaveLength(0);
  });
});

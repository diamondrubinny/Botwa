import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ChannelManager } from '../src/channels/manager.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { ipMatches, normalizeIp, parseCidr } from '../src/firewall.js';
import { clamVersion } from '../src/media/clamav.js';
import { MediaService } from '../src/media/store.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';

describe('firewall rules', () => {
  it('reads addresses and ranges, refuses nonsense and "everything" ranges', () => {
    expect(parseCidr('203.0.113.7')).toMatchObject({ prefix: 32, family: 'ipv4' });
    expect(parseCidr('203.0.113.0/24')).toMatchObject({ prefix: 24 });
    expect(parseCidr('2001:db8::/32')).toMatchObject({ family: 'ipv6' });
    for (const bad of ['', 'x', '1.2.3.4/0', '1.2.3.4/7', '1.2.3.999', '::/0', '1.2.3.4/33']) expect(parseCidr(bad), bad).toBeNull();
    expect(ipMatches('203.0.113.9', ['203.0.113.0/24'])).toBe(true);
    expect(ipMatches('::ffff:203.0.113.9', ['203.0.113.0/24'])).toBe(true);
    expect(ipMatches('198.51.100.1', ['203.0.113.0/24'])).toBe(false);
    expect(normalizeIp('::ffff:10.0.0.1')).toBe('10.0.0.1');
  });
});

/** a tiny stand-in for clamd: answers VERSION and INSTREAM (anything containing "EICAR" is infected) */
function fakeClamd(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const srv = net.createServer((s) => {
      let buf = Buffer.alloc(0);
      s.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        const t = buf.toString('latin1');
        if (t.startsWith('zVERSION\0')) { s.end('ClamAV 1.4.1/27454/Mon Nov  9 08:30:02 2026\0'); return; }
        if (t.startsWith('zINSTREAM\0') && buf.length >= 14 && buf.subarray(-4).equals(Buffer.alloc(4))) s.end(t.includes('EICAR') ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ port: (srv.address() as net.AddressInfo).port, close: () => srv.close() }));
  });
}

describe('panel firewall and antivirus', () => {
  const ORIGIN = 'https://panel.test';
  const PW = 'correct-horse-battery';
  let clam: { port: number; close: () => void };
  let app: Awaited<ReturnType<typeof buildApp>>;
  let media: MediaService;
  let cookie = '';
  let dir = '';
  const db = createDb(process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test');
  const req = (method: 'GET' | 'PUT' | 'POST', url: string, ip: string, payload?: object, html = false) =>
    app.inject({ method, url, payload, remoteAddress: ip, headers: { origin: ORIGIN, cookie, ...(html ? { accept: 'text/html' } : {}) } });

  beforeAll(async () => {
    clam = await fakeClamd();
    dir = await mkdtemp(path.join(os.tmpdir(), 'botwa-sec-'));
    const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test', ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN, COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false', CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: String(clam.port), MEDIA_DIR: dir });
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    media = new MediaService(db, cfg);
    app = await buildApp(cfg, db, new ChannelManager(db, cfg), media);
    await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4)', ['adm@t.io', 'adm', 'admin', await hashPassword(PW)]);
    cookie = `botwa_sid=${(await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'adm@t.io', password: PW }, remoteAddress: '203.0.113.5', headers: { origin: ORIGIN } })).cookies[0]!.value}`;
  });
  afterAll(async () => { clam.close(); await app.close(); await db.end(); });

  it('the security page shows the scanner, the signatures and your address', async () => {
    expect(await clamVersion({ host: '127.0.0.1', port: clam.port })).toMatchObject({ ok: true, engine: 'ClamAV 1.4.1', signatures: '27454' });
    const s = (await req('GET', '/settings/security', '203.0.113.5')).json();
    expect(s.yourIp).toBe('203.0.113.5');
    expect(s.antivirus.scanner).toMatchObject({ online: true, signatures: '27454' });
    expect(s.firewall.enabled).toBe(false);
  });

  it('only listed networks open the panel once switched on; the widget, webhooks and health check stay reachable; nobody locks themselves out', async () => {
    expect((await req('PUT', '/settings/firewall', '203.0.113.5', { enabled: true, allow: [], deny: [] })).json()).toEqual({ error: 'allow_list_empty' });
    expect((await req('PUT', '/settings/firewall', '203.0.113.5', { enabled: true, allow: ['198.51.100.0/24'], deny: [] })).json()).toMatchObject({ error: 'would_lock_you_out', yourIp: '203.0.113.5' });
    expect((await req('PUT', '/settings/firewall', '203.0.113.5', { enabled: true, allow: ['203.0.113.0/24'], deny: ['203.0.113.5'] })).json()).toMatchObject({ error: 'would_lock_you_out' });
    expect((await req('PUT', '/settings/firewall', '203.0.113.5', { enabled: true, allow: ['nonsense'], deny: [] })).statusCode).toBe(400);
    expect((await req('PUT', '/settings/firewall', '203.0.113.5', { enabled: true, allow: ['203.0.113.0/24'], deny: ['192.0.2.66'] })).statusCode).toBe(200);
    expect((await req('GET', '/auth/me', '203.0.113.9')).statusCode).toBe(200);                       // inside the range
    const out = await req('GET', '/auth/me', '198.51.100.7');
    expect(out.statusCode).toBe(403);
    expect(out.json()).toEqual({ error: 'blocked_by_firewall' });
    expect((await req('GET', '/', '198.51.100.7', undefined, true)).body).toContain('הגישה מהרשת הזו אינה מורשית');
    expect((await req('GET', '/healthz', '198.51.100.7')).statusCode).toBe(200);
    expect((await req('GET', '/widget.js', '198.51.100.7')).statusCode).toBe(200);
    expect((await req('POST', '/auth/login', '198.51.100.7', { email: 'adm@t.io', password: PW })).statusCode).toBe(403);   // not even sign-in
    expect((await req('GET', '/api/v1/me', '198.51.100.7')).statusCode).toBe(401);                    // the API is outside unless asked
    expect((await req('GET', '/widget.js', '192.0.2.66')).statusCode).toBe(403);                      // a denied address gets nothing
    expect((await req('GET', '/settings/security', '203.0.113.5')).json().blockedLastHour).toBeGreaterThanOrEqual(3);
    await req('PUT', '/settings/firewall', '203.0.113.5', { enabled: false, allow: ['203.0.113.0/24'], deny: [] });
    expect((await req('GET', '/auth/me', '198.51.100.7')).statusCode).toBe(200);
  });

  it('stored files are scanned again with fresh signatures; a newly detected one is removed and marked', async () => {
    const ch = (await db.query(`INSERT INTO channels (type,label) VALUES ('whatsapp','x') RETURNING id`)).rows[0].id;
    const ct = (await db.query(`INSERT INTO contacts (channel_id, external_id) VALUES ($1,'1') RETURNING id`, [ch])).rows[0].id;
    const cv = (await db.query(`INSERT INTO conversations (channel_id, contact_id) VALUES ($1,$2) RETURNING id`, [ch, ct])).rows[0].id;
    await mkdir(path.join(dir, 'clean'), { recursive: true });
    const mk = async (name: string, content: string) => {
      const msg = (await db.query(`INSERT INTO messages (conversation_id, direction, body) VALUES ($1,'in','') RETURNING id`, [cv])).rows[0].id;
      await writeFile(media.cleanPath(name), content);
      return (await db.query(`INSERT INTO attachments (message_id, kind, mime, size, sha256, storage_name, status, last_scanned_at) VALUES ($1,'document','application/pdf',10,'x',$2,'clean', now() - interval '30 days') RETURNING id`, [msg, name])).rows[0].id as string;
    };
    const good = await mk('00000000-0000-4000-8000-000000000001', 'harmless');
    const bad = await mk('00000000-0000-4000-8000-000000000002', 'X5O!P%@AP EICAR test');
    const r = (await req('POST', '/settings/security/rescan', '203.0.113.5', {})).json();
    expect(r).toEqual({ scanned: 2, infected: 1, errors: 0 });
    const rows = (await db.query('SELECT id, status, storage_name FROM attachments ORDER BY id')).rows;
    expect(rows.find((x) => x.id === bad)).toMatchObject({ status: 'infected', storage_name: null });
    expect(rows.find((x) => x.id === good)).toMatchObject({ status: 'clean' });
    expect((await media.rescanClean(10)).scanned).toBe(0);                                      // just checked: not again for a week
    expect((await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'media.infected_rescan'`)).rows[0].n).toBe(1);
  });
});

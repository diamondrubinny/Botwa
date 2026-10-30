import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { decryptBackup } from '../src/backup.js';
import { ChannelManager } from '../src/channels/manager.js';
import type { AdapterContext, AdapterFactory, ChannelAdapter } from '../src/channels/types.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/password.js';
import { csvCell } from '../src/routes/reports.js';

const ORIGIN = 'https://panel.test';
const PW = 'correct-horse-battery';
const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test';
const hasPgDump = spawnSync('pg_dump', ['--version']).status === 0;

describe('csv helpers', () => {
  it('neutralises spreadsheet formulas and quotes properly', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(42)).toBe('42');
    expect(csvCell('שלום')).toBe('שלום');
  });
});

describe('routing, csv, search, related, backups', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let mgr: ChannelManager;
  let cfg: ReturnType<typeof loadConfig>;
  const ctxs: Record<string, AdapterContext> = {};
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let ip = 0;
  const chIds: string[] = [];
  let lastStartOpts: { pairingPhone?: string } | undefined;
  let backupDir = '';
  const db = createDb(DB_URL);

  class Fake implements ChannelAdapter {
    constructor(private ctx: AdapterContext) { ctxs[ctx.channelId] = ctx; }
    async start(opts?: { pairingPhone?: string }) {
      lastStartOpts = opts;
      if (opts?.pairingPhone) { this.ctx.events.onStatus('qr'); this.ctx.events.onPairingCode?.('ABCD-1234'); }
      else this.ctx.events.onStatus('connected');
    }
    async stop() { this.ctx.events.onStatus('stopped'); }
    async logout() {}
    async sendText() { return {}; }
  }
  const factory: AdapterFactory = (t, ctx) => (t === 'whatsapp' || t === 'telegram' ? new Fake(ctx) : null);
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, who?: string, payload?: object) =>
    app.inject({ method, url, payload, remoteAddress: `10.30.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { origin: ORIGIN, ...(who ? { cookie: cookies[who]! } : {}) } });
  const inbound = (ch: number, ext: string, id: string, text = 'hello-secret-body') =>
    ctxs[chIds[ch]!]!.events.onMessage({ externalContactId: ext, contactName: ext, externalMessageId: id, text, timestamp: new Date() });
  const owner = async (ext: string) => (await db.query(`SELECT u.email FROM conversations c JOIN contacts ct ON ct.id=c.contact_id LEFT JOIN users u ON u.id=c.assigned_to WHERE ct.external_id=$1`, [ext])).rows[0]?.email as string | null;
  const convOf = async (ext: string) => (await db.query(`SELECT c.id FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE ct.external_id=$1 LIMIT 1`, [ext])).rows[0].id as string;

  beforeAll(async () => {
    backupDir = await mkdtemp(path.join(os.tmpdir(), 'botwa-bk-'));
    cfg = loadConfig({
      NODE_ENV: 'test', DATABASE_URL: DB_URL, ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN,
      COOKIE_SECURE: 'false', REQUIRE_MFA_FOR_PRIVILEGED: 'false', BACKUP_DIR: backupDir, BACKUP_KEEP: '2',
    });
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    mgr = new ChannelManager(db, cfg, factory);
    app = await buildApp(cfg, db, mgr);
    for (const [e, r] of [['admin', 'admin'], ['sup', 'supervisor'], ['a1', 'agent'], ['a2', 'agent'], ['a3', 'agent'], ['=cmd', 'agent']] as const) {
      const u = await db.query('INSERT INTO users (email,name,role,password_hash) VALUES ($1,$2,$3,$4) RETURNING id', [`${e.replace('=', 'x')}@t.io`, e, r, await hashPassword(PW)]);
      ids[e] = u.rows[0].id;
      const res = await call('POST', '/auth/login', undefined, { email: `${e.replace('=', 'x')}@t.io`, password: PW });
      cookies[e.replace('=', 'x') + '@t.io'] = `botwa_sid=${res.cookies[0]!.value}`;
    }
    for (const [type, label] of [['whatsapp', 'WA1'], ['whatsapp', 'WA2'], ['telegram', 'TG']] as const) {
      const id = (await call('POST', '/channels', 'admin@t.io', { type, label })).json().id;
      chIds.push(id);
      await call('POST', `/channels/${id}/start`, 'admin@t.io');
    }
    await new Promise((r) => setTimeout(r, 50));
    // only a1, a2 are routable for the first tests
    await db.query(`UPDATE users SET available = false WHERE email IN ('a3@t.io', 'xcmd@t.io')`);
  });
  afterAll(async () => { await mgr.stopAll(); await app.close(); await db.end(); });

  it('WhatsApp phone-number pairing: validated, passed to the adapter, code exposed to admin only, cleared when connected', async () => {
    const ch = (await call('POST', '/channels', 'admin@t.io', { type: 'whatsapp', label: 'Pair' })).json().id;
    expect((await call('POST', `/channels/${ch}/start`, 'admin@t.io', { phone: '+972 50-123' })).statusCode).toBe(400); // digits only
    expect((await call('POST', `/channels/${ch}/start`, 'admin@t.io', { phone: '12' })).statusCode).toBe(400);
    expect((await call('POST', `/channels/${ch}/start`, 'sup@t.io', { phone: '972501234567' })).statusCode).toBe(403);
    expect((await call('POST', `/channels/${ch}/start`, 'admin@t.io', { phone: '972501234567' })).statusCode).toBe(200);
    expect(lastStartOpts).toEqual({ pairingPhone: '972501234567' });
    expect(mgr.snapshot(ch)).toMatchObject({ status: 'qr', code: 'ABCD-1234' });
    ctxs[ch]!.events.onStatus('connected');
    await new Promise((r) => setTimeout(r, 30));
    expect(mgr.snapshot(ch).code).toBeUndefined();
    // plain start (QR flow) carries no phone
    await call('POST', `/channels/${ch}/stop`, 'admin@t.io');
    await call('POST', `/channels/${ch}/start`, 'admin@t.io');
    expect(lastStartOpts).toEqual({ pairingPhone: undefined });
    await call('DELETE', `/channels/${ch}`, 'admin@t.io');
  });

  it('routing settings: admin writes, supervisor reads, validated', async () => {
    expect((await call('PUT', '/settings/routing', 'sup@t.io', { mode: 'round_robin' })).statusCode).toBe(403);
    expect((await call('PUT', '/settings/routing', 'admin@t.io', { mode: 'chaos' })).statusCode).toBe(400);
    expect((await call('GET', '/settings/routing', 'sup@t.io')).json()).toEqual({ mode: 'off' });
    await inbound(0, 'off1@s.whatsapp.net', 'off1');
    expect(await owner('off1@s.whatsapp.net')).toBeNull(); // routing off: stays unassigned
  });

  it('round robin alternates between on-duty agents and never picks supervisors or off-duty agents', async () => {
    await call('PUT', '/settings/routing', 'admin@t.io', { mode: 'round_robin' });
    for (let i = 0; i < 6; i++) await inbound(0, `rr${i}@s.whatsapp.net`, `rr${i}`);
    const owners = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => owner(`rr${i}@s.whatsapp.net`)));
    expect(owners.every((o) => o === 'a1@t.io' || o === 'a2@t.io')).toBe(true);
    expect(owners.filter((o) => o === 'a1@t.io')).toHaveLength(3);
    expect((await db.query(`SELECT 1 FROM audit_log WHERE action='conversation.auto_assign'`)).rowCount).toBe(6);
  });

  it('availability toggle removes an agent from routing; nobody available leaves it unassigned', async () => {
    expect((await call('POST', '/auth/availability', 'a1@t.io', { available: false })).json()).toEqual({ available: false });
    expect((await call('GET', '/auth/me', 'a1@t.io')).json().available).toBe(false);
    await inbound(0, 'av1@s.whatsapp.net', 'av1');
    expect(await owner('av1@s.whatsapp.net')).toBe('a2@t.io');
    await call('POST', '/auth/availability', 'a2@t.io', { available: false });
    await inbound(0, 'av2@s.whatsapp.net', 'av2');
    expect(await owner('av2@s.whatsapp.net')).toBeNull();
    await call('POST', '/auth/availability', 'a1@t.io', { available: true });
    await call('POST', '/auth/availability', 'a2@t.io', { available: true });
    expect((await call('GET', '/users', 'admin@t.io')).json().find((u: { email: string }) => u.email === 'a1@t.io').available).toBe(true);
  });

  it('least busy balances a burst of concurrent new conversations', async () => {
    await db.query(`UPDATE users SET available = true WHERE email = 'a3@t.io'`);
    await call('PUT', '/settings/routing', 'admin@t.io', { mode: 'least_busy' });
    await db.query(`DELETE FROM contacts WHERE external_id LIKE 'lb%'`);
    await Promise.all(Array.from({ length: 9 }, (_, i) => inbound(1, `lb${i}@s.whatsapp.net`, `lb${i}`)));
    // balance is judged on TOTAL open load per agent (least_busy fills the emptiest agent first)
    const load = (await db.query(`SELECT u.email, count(*)::int AS n FROM conversations c JOIN users u ON u.id=c.assigned_to
                                   WHERE c.status='open' AND u.email IN ('a1@t.io','a2@t.io','a3@t.io') GROUP BY u.email`)).rows;
    const counts = load.map((r: { n: number }) => r.n);
    expect(load).toHaveLength(3);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    const assignedBurst = (await db.query(`SELECT count(*)::int AS n FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE ct.external_id LIKE 'lb%' AND c.assigned_to IS NOT NULL`)).rows[0].n;
    expect(assignedBurst).toBe(9);
    expect((await db.query(`SELECT 1 FROM conversations c JOIN contacts ct ON ct.id=c.contact_id JOIN users u ON u.id=c.assigned_to WHERE ct.external_id LIKE 'lb%' AND u.email='xcmd@t.io'`)).rowCount).toBe(0); // off-duty never picked
  });

  it('reopened conversation keeps its assignee; routing only fills unassigned ones', async () => {
    const before = await owner('rr0@s.whatsapp.net');
    await inbound(0, 'rr0@s.whatsapp.net', 'rr0-again');
    expect(await owner('rr0@s.whatsapp.net')).toBe(before);
  });

  it('CSV export: managers only, escaped, BOM, audited', async () => {
    await call('POST', `/conversations/${await convOf('rr0@s.whatsapp.net')}/assign`, 'admin@t.io', { userId: ids['=cmd'] });
    await db.query(`INSERT INTO messages (conversation_id, direction, body, sender_user_id) VALUES ($1,'out','x',$2)`, [await convOf('rr0@s.whatsapp.net'), ids['=cmd']]);
    expect((await call('GET', '/reports/export.csv', 'a1@t.io')).statusCode).toBe(403);
    expect((await call('GET', '/reports/export.csv?kind=bogus', 'sup@t.io')).statusCode).toBe(400);
    const r = await call('GET', '/reports/export.csv?kind=agents&days=7', 'sup@t.io');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(String(r.headers['content-disposition'])).toContain('attachment');
    expect(r.body.startsWith('﻿agent,messages_sent')).toBe(true);
    expect(r.body).toContain("'=cmd"); // agent literally named "=cmd" is neutralised
    expect(r.body).not.toMatch(/(^|\n)=cmd/);
    const d = await call('GET', '/reports/export.csv?kind=daily', 'sup@t.io');
    expect(d.body).toContain('day,inbound,outbound');
    expect((await db.query(`SELECT 1 FROM audit_log WHERE action='report.export'`)).rowCount).toBe(2);
  });

  it('message search within a conversation (escaped, access-checked)', async () => {
    const conv = await convOf('rr1@s.whatsapp.net');
    const who = (await owner('rr1@s.whatsapp.net'))!;
    await db.query(`INSERT INTO messages (conversation_id, direction, body) VALUES ($1,'in','אני צריך החזר כספי'), ($1,'in','100% בטוח')`, [conv]);
    const find = async (term: string, as = who) => (await call('GET', `/conversations/${conv}/messages?q=${encodeURIComponent(term)}`, as)).json();
    expect(await find('החזר')).toHaveLength(1);
    expect(await find('%')).toHaveLength(1); // literal percent, not a wildcard
    expect(await find('zzz')).toHaveLength(0);
    const other = who === 'a1@t.io' ? 'a2@t.io' : 'a1@t.io';
    expect((await call('GET', `/conversations/${conv}/messages?q=x`, other)).statusCode).toBe(404);
  });

  it('related conversations: same phone on another WhatsApp channel, filtered by access; none for telegram', async () => {
    await inbound(0, '972501110000@s.whatsapp.net', 'p1');
    await inbound(1, '972501110000@s.whatsapp.net', 'p2');
    await inbound(2, '555:777', 't1');
    const c1 = (await db.query(`SELECT c.id FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE ct.external_id='972501110000@s.whatsapp.net' AND c.channel_id=$1`, [chIds[0]])).rows[0].id;
    const rel = (await call('GET', `/conversations/${c1}/related`, 'sup@t.io')).json();
    expect(rel).toHaveLength(1);
    expect(rel[0].channelLabel).toBe('WA2');
    expect((await call('GET', `/conversations/${await convOf('555:777')}/related`, 'sup@t.io')).json()).toEqual([]);
    // an agent who cannot see the sibling conversation gets nothing from it
    await db.query(`UPDATE conversations SET assigned_to = $1 WHERE id = (SELECT c.id FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE ct.external_id='972501110000@s.whatsapp.net' AND c.channel_id=$2)`, [ids.a3, chIds[1]]);
    await db.query('UPDATE conversations SET assigned_to = $1 WHERE id = $2', [ids.a1, c1]);
    expect((await call('GET', `/conversations/${c1}/related`, 'a1@t.io')).json()).toEqual([]);
    expect((await call('GET', `/conversations/${c1}/related`, 'a2@t.io')).statusCode).toBe(404);
  });

  describe.skipIf(!hasPgDump)('encrypted backups', () => {
    it('admin only; creates an encrypted 0600 file without plaintext; download audited', async () => {
      expect((await call('POST', '/backups', 'sup@t.io')).statusCode).toBe(403);
      expect((await call('GET', '/backups', 'a1@t.io')).statusCode).toBe(403);
      const r = await call('POST', '/backups', 'admin@t.io');
      expect(r.statusCode).toBe(201);
      const { name, size } = r.json();
      expect(name).toMatch(/^botwa-\d{8}-\d{6}\.sql\.gz\.enc$/);
      const file = path.join(backupDir, name);
      expect(((await stat(file)).mode & 0o777).toString(8)).toBe('600');
      const raw = await readFile(file);
      expect(raw.subarray(0, 8).toString()).toBe('BOTWABK1');
      expect(raw.length).toBe(size);
      expect(raw.includes(Buffer.from('hello-secret-body'))).toBe(false);
      expect(raw.includes(Buffer.from('CREATE TABLE'))).toBe(false);
      const dl = await call('GET', `/backups/${name}`, 'admin@t.io');
      expect(dl.statusCode).toBe(200);
      expect(dl.rawPayload.equals(raw)).toBe(true);
      expect((await db.query(`SELECT 1 FROM audit_log WHERE action='backup.download'`)).rowCount).toBe(1);
      expect((await call('GET', '/backups', 'admin@t.io')).json()[0].name).toBe(name);
    });

    it('decrypts back to a real SQL dump; tampering and wrong key are detected', async () => {
      const [{ name }] = (await call('GET', '/backups', 'admin@t.io')).json();
      const out = path.join(backupDir, 'out.sql.gz');
      await decryptBackup(cfg, path.join(backupDir, name), out);
      const sql = gunzipSync(await readFile(out)).toString();
      expect(sql).toContain('CREATE TABLE public.messages');
      expect(sql).toContain('hello-secret-body');

      const raw = await readFile(path.join(backupDir, name));
      const bad = Buffer.from(raw); bad[40] = bad[40]! ^ 0xff;
      await writeFile(path.join(backupDir, 'tampered.bin'), bad);
      await expect(decryptBackup(cfg, path.join(backupDir, 'tampered.bin'), path.join(backupDir, 'x1'))).rejects.toThrow();
      const otherKey = loadConfig({ NODE_ENV: 'test', DATABASE_URL: DB_URL, ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: ORIGIN });
      await expect(decryptBackup(otherKey, path.join(backupDir, name), path.join(backupDir, 'x2'))).rejects.toThrow();
    });

    it('rejects path traversal / odd names; prunes to BACKUP_KEEP; delete works', async () => {
      for (const n of ['..%2F..%2Fetc%2Fpasswd', 'out.sql.gz', 'tampered.bin']) expect((await call('GET', `/backups/${n}`, 'admin@t.io')).statusCode).toBe(404);
      await new Promise((r) => setTimeout(r, 1100)); // names have 1s resolution
      await call('POST', '/backups', 'admin@t.io');
      await new Promise((r) => setTimeout(r, 1100));
      await call('POST', '/backups', 'admin@t.io');
      const list = (await call('GET', '/backups', 'admin@t.io')).json();
      expect(list).toHaveLength(2); // BACKUP_KEEP=2
      expect((await call('DELETE', `/backups/${list[1].name}`, 'admin@t.io')).statusCode).toBe(200);
      expect((await call('GET', '/backups', 'admin@t.io')).json()).toHaveLength(1);
    });
  });
});

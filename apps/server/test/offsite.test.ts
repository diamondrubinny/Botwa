import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackup } from '../src/backup.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { checkOffsite, offsiteStatus, uploadBackup } from '../src/system/offsite.js';
import { EMPTY_SHA256, signV4 } from '../src/system/s3.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test';
const db = createDb(DB_URL);

/** A fake S3 bucket: checks every request is signed and that a PUT body matches the SHA-256 it was signed with. */
function fakeS3() {
  const objects = new Map<string, Buffer>();
  const seen: string[] = [];
  const read = async (body: unknown): Promise<Buffer> => {
    if (!body) return Buffer.alloc(0);
    if (body instanceof Uint8Array) return Buffer.from(body);
    const chunks: Buffer[] = [];
    for await (const c of body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks);
  };
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const h = init!.headers as Record<string, string>;
    seen.push(`${init!.method} ${u.pathname}${u.search}`);
    if (!/^AWS4-HMAC-SHA256 Credential=AK-test\/\d{8}\/eu-central-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/.test(h.authorization ?? '')) return new Response('', { status: 403 });
    const key = decodeURIComponent(u.pathname.replace(/^\/bkp\/?/, ''));
    if (init!.method === 'PUT') {
      const body = await read(init!.body);
      if (createHash('sha256').update(body).digest('hex') !== h['x-amz-content-sha256']) return new Response('XAmzContentSHA256Mismatch', { status: 400 });
      objects.set(key, body); return new Response('', { status: 200 });
    }
    if (init!.method === 'HEAD') { const o = objects.get(key); return o ? new Response(null, { status: 200, headers: { 'content-length': String(o.length) } }) : new Response(null, { status: 404 }); }
    if (init!.method === 'DELETE') { objects.delete(key); return new Response(null, { status: 204 }); }
    if (init!.method === 'GET' && u.searchParams.get('list-type') === '2') {
      const p = u.searchParams.get('prefix') ?? '';
      const xml = `<ListBucketResult>${[...objects].filter(([k]) => k.startsWith(p)).map(([k, v]) => `<Contents><Key>${k}</Key><Size>${v.length}</Size></Contents>`).join('')}</ListBucketResult>`;
      return new Response(xml, { status: 200 });
    }
    if (init!.method === 'GET') { const o = objects.get(key); return o ? new Response(new Uint8Array(o), { status: 200 }) : new Response('', { status: 404 }); }
    return new Response('', { status: 400 });
  };
  return { objects, seen, fetchImpl };
}

describe('backups outside the server (S3-compatible)', () => {
  let dir = '';
  let cfg: ReturnType<typeof loadConfig>;
  beforeAll(async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    dir = await mkdtemp(path.join(tmpdir(), 'botwa-offsite-test-'));
    cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: DB_URL, ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: 'https://p.test', BACKUP_DIR: path.join(dir, 'b'), MEDIA_DIR: path.join(dir, 'm'),
      OFFSITE_S3_ENDPOINT: 'https://s3.example.test', OFFSITE_S3_BUCKET: 'bkp', OFFSITE_S3_REGION: 'eu-central-1', OFFSITE_S3_ACCESS_KEY: 'AK-test', OFFSITE_S3_SECRET_KEY: 'secret-test-123', OFFSITE_KEEP: '2' });
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); await db.end(); });

  it('signs requests like AWS (the published Signature V4 example)', () => {
    expect(signV4({ method: 'GET', path: '/test.txt', headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9', 'x-amz-content-sha256': EMPTY_SHA256, 'x-amz-date': '20130524T000000Z' }, payloadHash: EMPTY_SHA256, region: 'us-east-1', accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', amzDate: '20130524T000000Z' }))
      .toBe('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });

  it('uploads a backup (encrypted as on the server), checks it arrived whole, keeps the newest copies, and the restore check reads it back', async () => {
    const s3 = fakeS3();
    const b = await createBackup(cfg, 'db');
    expect(await uploadBackup(db, cfg, b.name, s3.fetchImpl)).toEqual({ ok: true });
    expect([...s3.objects.keys()]).toEqual([`botwa/${b.name}`]);
    expect(s3.objects.get(`botwa/${b.name}`)!.subarray(0, 8).toString()).toBe('BOTWABK1');       // ciphertext only, the key stays here
    expect(await offsiteStatus(db, cfg)).toMatchObject({ configured: true, target: 's3.example.test/bkp/botwa/', lastOk: true, lastName: b.name });
    // older copies beyond OFFSITE_KEEP (2) are deleted there; files that are not ours are left alone
    s3.objects.set('botwa/botwa-20200101-000000.sql.gz.enc', Buffer.from('old'));
    s3.objects.set('botwa/botwa-20200102-000000.sql.gz.enc', Buffer.from('old2'));
    s3.objects.set('botwa/notes.txt', Buffer.from('x'));
    expect((await uploadBackup(db, cfg, b.name, s3.fetchImpl)).ok).toBe(true);
    expect([...s3.objects.keys()].sort()).toEqual(['botwa/botwa-20200102-000000.sql.gz.enc', `botwa/${b.name}`, 'botwa/notes.txt'].sort());
    // the restore check: the newest copy there is downloaded, decrypted and read like a restore
    const c = await checkOffsite(db, cfg, s3.fetchImpl);
    expect(c).toEqual({ ok: true, name: b.name });
    expect(await offsiteStatus(db, cfg)).toMatchObject({ lastCheckOk: true, lastCheckName: b.name });
    // a damaged copy there fails the check (and says so)
    const buf = s3.objects.get(`botwa/${b.name}`)!; buf[buf.length - 5] = buf[buf.length - 5]! ^ 0xff;
    expect((await checkOffsite(db, cfg, s3.fetchImpl)).ok).toBe(false);
    expect((await offsiteStatus(db, cfg)).lastCheckOk).toBe(false);
  });

  it('a refused upload (wrong keys) is recorded as failed, never silently; bad names are refused', async () => {
    const deny = async () => new Response('AccessDenied', { status: 403 });
    const b = await createBackup(cfg, 'db');
    const r = await uploadBackup(db, cfg, b.name, deny);
    expect(r).toEqual({ ok: false, error: 's3_put_403' });
    expect(await offsiteStatus(db, cfg)).toMatchObject({ lastOk: false, lastError: 's3_put_403' });
    expect(await uploadBackup(db, cfg, '../etc/passwd', deny)).toEqual({ ok: false, error: 'bad_name' });
    expect(() => loadConfig({ NODE_ENV: 'test', DATABASE_URL: DB_URL, ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: 'https://p.test', OFFSITE_S3_ENDPOINT: 'http://s3.example.test' })).toThrow();   // https only
  });
});

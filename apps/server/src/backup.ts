import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Config } from './config.js';

// File layout: "BOTWABK1" | iv(12) | AES-256-GCM(gzip(pg_dump plain SQL)) | tag(16). The key is derived (HKDF) from
// ENCRYPTION_KEY, so a stolen backup file is useless without it. Restore is deliberately CLI-only (see docs/DEPLOY.md).
const MAGIC = Buffer.from('BOTWABK1');
export const BACKUP_NAME = /^botwa-\d{8}-\d{6}\.sql\.gz\.enc$/;

const backupKey = (cfg: Config) => Buffer.from(hkdfSync('sha256', Buffer.from(cfg.ENCRYPTION_KEY, 'base64'), Buffer.alloc(0), 'botwa-backup-v1', 32));

function pgEnv(databaseUrl: string): NodeJS.ProcessEnv {
  const u = new URL(databaseUrl);
  return {
    ...process.env, // PATH etc.
    PGHOST: u.hostname, PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: u.pathname.slice(1),
  };
}

let running = false;

export async function createBackup(cfg: Config): Promise<{ name: string; size: number }> {
  if (running) throw new Error('backup_in_progress');
  running = true;
  const dir = cfg.BACKUP_DIR;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const name = `botwa-${stamp}.sql.gz.enc`;
  const tmp = path.join(dir, `.${name}.partial`);
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', backupKey(cfg), iv);
    const dump = spawn('pg_dump', ['--no-owner', '--no-privileges'], { env: pgEnv(cfg.DATABASE_URL), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    dump.stderr.on('data', (d) => { stderr = (stderr + d).slice(-500); });
    const exit = new Promise<void>((resolve, reject) => {
      dump.on('error', reject);
      dump.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pg_dump failed (${code}): ${stderr.trim()}`))));
    });
    const out = createWriteStream(tmp, { mode: 0o600 });
    out.write(MAGIC);
    out.write(iv);
    await Promise.all([pipeline(dump.stdout, createGzip(), cipher, out, { end: false }), exit]);
    out.write(cipher.getAuthTag());
    await new Promise<void>((resolve, reject) => { out.end(() => resolve()); out.on('error', reject); });
    await chmod(tmp, 0o600);
    await rename(tmp, path.join(dir, name));
    await pruneBackups(cfg);
    return { name, size: (await stat(path.join(dir, name))).size };
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  } finally {
    running = false;
  }
}

export async function listBackups(cfg: Config): Promise<{ name: string; size: number; createdAt: string }[]> {
  const names = await readdir(cfg.BACKUP_DIR).catch(() => [] as string[]);
  const out = [];
  for (const n of names.filter((x) => BACKUP_NAME.test(x))) {
    const st = await stat(path.join(cfg.BACKUP_DIR, n));
    out.push({ name: n, size: st.size, createdAt: st.mtime.toISOString() });
  }
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

export async function pruneBackups(cfg: Config): Promise<void> {
  const all = await listBackups(cfg);
  for (const b of all.slice(cfg.BACKUP_KEEP)) await unlink(path.join(cfg.BACKUP_DIR, b.name)).catch(() => undefined);
}

export const backupPath = (cfg: Config, name: string) => path.join(cfg.BACKUP_DIR, name); // caller validates name with BACKUP_NAME

/** Decrypt a backup file to a gzip stream file (used by the restore CLI and tests). Verifies the GCM tag. */
export async function decryptBackup(cfg: Config, file: string, outFile: string): Promise<void> {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    if (size < MAGIC.length + 12 + 16) throw new Error('not a botwa backup');
    const head = Buffer.alloc(MAGIC.length + 12);
    await fh.read(head, 0, head.length, 0);
    if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a botwa backup');
    const tag = Buffer.alloc(16);
    await fh.read(tag, 0, 16, size - 16);
    const decipher = createDecipheriv('aes-256-gcm', backupKey(cfg), head.subarray(MAGIC.length));
    decipher.setAuthTag(tag);
    await pipeline(createReadStream(file, { start: head.length, end: size - 17 }), decipher, createWriteStream(outFile, { mode: 0o600 }));
  } finally {
    await fh.close();
  }
}

export interface BackupCheck { ok: boolean; tables: number; bytes: number; reason?: string }

/**
 * Restore rehearsal without touching any database: authenticates and decrypts the file (GCM tag), gunzips it and checks that it is a
 * complete pg_dump (has CREATE TABLE statements for the core tables and the "dump complete" trailer).
 */
export async function verifyBackup(cfg: Config, file: string): Promise<BackupCheck> {
  const dir = await mkdtemp(path.join(tmpdir(), 'botwa-verify-'));
  const gz = path.join(dir, 'x.sql.gz');
  try {
    await decryptBackup(cfg, file, gz);
    let tail = '', carry = '', bytes = 0;
    const tables = new Set<string>();
    const sink = createGunzip();
    sink.on('data', (c: Buffer) => {
      bytes += c.length;
      const text = carry + c.toString('utf8');
      for (const m of text.matchAll(/CREATE TABLE (?:public\.)?(\w+)/g)) tables.add(m[1]!);
      carry = text.slice(-200);
      tail = (tail + c.toString('utf8')).slice(-400);
    });
    await pipeline(createReadStream(gz), sink);
    const core = ['users', 'conversations', 'messages', 'contacts', 'channels'];
    const missing = core.filter((t) => !tables.has(t));
    if (missing.length) return { ok: false, tables: tables.size, bytes, reason: `missing tables: ${missing.join(', ')}` };
    if (!/PostgreSQL database dump complete/.test(tail)) return { ok: false, tables: tables.size, bytes, reason: 'dump is truncated' };
    return { ok: true, tables: tables.size, bytes };
  } catch (e) {
    return { ok: false, tables: 0, bytes: 0, reason: e instanceof Error ? e.message : 'unreadable' };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

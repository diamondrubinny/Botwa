import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scryptSync } from 'node:crypto';
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
/** full backups: the same envelope around tar.gz { db.sql, manifest.json, media/ } */
const MAGIC_FULL = Buffer.from('BOTWAFU1');
export const BACKUP_NAME = /^botwa-(?:\d{8}-\d{6}\.sql\.gz|full-\d{8}-\d{6}\.tar\.gz)\.enc$/;
export type BackupKind = 'full' | 'db';

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

export async function createBackup(cfg: Config, kind: BackupKind = 'full'): Promise<{ name: string; size: number; kind: BackupKind }> {
  if (kind === 'full') return createFullBackup(cfg);
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
    return { name, size: (await stat(path.join(dir, name))).size, kind: 'db' };
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
    if (!head.subarray(0, MAGIC.length).equals(MAGIC) && !head.subarray(0, MAGIC.length).equals(MAGIC_FULL)) throw new Error('not a botwa backup');
    const tag = Buffer.alloc(16);
    await fh.read(tag, 0, 16, size - 16);
    const decipher = createDecipheriv('aes-256-gcm', backupKey(cfg), head.subarray(MAGIC.length));
    decipher.setAuthTag(tag);
    await pipeline(createReadStream(file, { start: head.length, end: size - 17 }), decipher, createWriteStream(outFile, { mode: 0o600 }));
  } finally {
    await fh.close();
  }
}

export interface BackupCheck { ok: boolean; tables: number; bytes: number; files?: number; reason?: string }

/**
 * Restore rehearsal without touching any database: authenticates and decrypts the file (GCM tag), gunzips it and checks that it is a
 * complete pg_dump (has CREATE TABLE statements for the core tables and the "dump complete" trailer).
 */
export async function verifyBackup(cfg: Config, file: string): Promise<BackupCheck> {
  const dir = await mkdtemp(path.join(tmpdir(), 'botwa-verify-'));
  const gz = path.join(dir, 'x.sql.gz');
  try {
    await decryptBackup(cfg, file, gz);
    if (await isFullFile(file)) {
      // a full backup: take the database dump out of the archive (the files are only listed and counted)
      const inner = path.join(dir, 'x');
      await mkdir(inner);
      await run('tar', ['-xzf', gz, '-C', inner, 'db.sql', 'manifest.json']);
      const files = (await run('tar', ['-tzf', gz])).split('\n').filter((l) => l.startsWith('media/') && !l.endsWith('/')).length;
      const r = await checkDump(createReadStream(path.join(inner, 'db.sql')));
      return { ...r, files };
    }
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

// ---------------------------------------------------------------------------------------------------------------------
// Full backups (database + attachment files) and the passphrase-protected migration bundle (adds the server's .env).

async function isFullFile(file: string): Promise<boolean> {
  const fh = await open(file, 'r');
  try { const b = Buffer.alloc(8); await fh.read(b, 0, 8, 0); return b.equals(MAGIC_FULL) || b.equals(MAGIC_MIGRATION); } finally { await fh.close(); }
}

/** Run a command, resolve its stdout; reject with the end of stderr. */
function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: env ?? process.env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout!.on('data', (d) => { out += d; });
    p.stderr!.on('data', (d) => { err = (err + d).slice(-800); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} failed (${code}): ${err.trim()}`))));
    if (input !== undefined) { p.stdin!.end(input); }
  });
}

/** A complete pg_dump? (core tables present, "dump complete" trailer). */
async function checkDump(src: NodeJS.ReadableStream): Promise<BackupCheck> {
  let tail = '', carry = '', bytes = 0;
  const tables = new Set<string>();
  for await (const c of src as AsyncIterable<Buffer>) {
    bytes += c.length;
    const text = carry + c.toString('utf8');
    for (const m of text.matchAll(/CREATE TABLE (?:public\.)?(\w+)/g)) tables.add(m[1]!);
    carry = text.slice(-200);
    tail = (tail + c.toString('utf8')).slice(-400);
  }
  const core = ['users', 'conversations', 'messages', 'contacts', 'channels'];
  const missing = core.filter((t) => !tables.has(t));
  if (missing.length) return { ok: false, tables: tables.size, bytes, reason: `missing tables: ${missing.join(', ')}` };
  if (!/PostgreSQL database dump complete/.test(tail)) return { ok: false, tables: tables.size, bytes, reason: 'dump is truncated' };
  return { ok: true, tables: tables.size, bytes };
}

/** db.sql + manifest.json (+ env) in a staging folder, archived together with the media folder as tar.gz on stdout. */
async function stageArchive(cfg: Config, extra: Record<string, string> = {}): Promise<{ dir: string; tar: ReturnType<typeof spawn> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'botwa-full-'));
  await chmod(dir, 0o700);
  await run('pg_dump', ['--no-owner', '--no-privileges', '-f', path.join(dir, 'db.sql')], pgEnv(cfg.DATABASE_URL));
  const media = path.resolve(cfg.MEDIA_DIR);
  await mkdir(media, { recursive: true });
  const manifest = { format: 'botwa-full-1', createdAt: new Date().toISOString(), media: true, ...Object.fromEntries(Object.keys(extra).map((k) => [k, true])) };
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  for (const [name, text] of Object.entries(extra)) await writeFile(path.join(dir, name), text, { mode: 0o600 });
  const tar = spawn('tar', ['-czf', '-', '-C', dir, 'db.sql', 'manifest.json', ...Object.keys(extra), '-C', path.dirname(media), '--transform', `s,^${path.basename(media)},media,`, path.basename(media)], { stdio: ['ignore', 'pipe', 'pipe'] });
  return { dir, tar };
}

async function sealTo(tar: ReturnType<typeof spawn>, out: string, magic: Buffer, key: Buffer, header: Buffer = Buffer.alloc(0)): Promise<void> {
  let stderr = '';
  tar.stderr!.on('data', (d) => { stderr = (stderr + d).slice(-500); });
  const exit = new Promise<void>((resolve, reject) => { tar.on('error', reject); tar.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar failed (${code}): ${stderr.trim()}`)))); });
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ws = createWriteStream(out, { mode: 0o600 });
  ws.write(magic); ws.write(header); ws.write(iv);
  await Promise.all([pipeline(tar.stdout!, cipher, ws, { end: false }), exit]);
  ws.write(cipher.getAuthTag());
  await new Promise<void>((resolve, reject) => { ws.end(() => resolve()); ws.on('error', reject); });
  await chmod(out, 0o600);
}

async function createFullBackup(cfg: Config): Promise<{ name: string; size: number; kind: BackupKind }> {
  if (running) throw new Error('backup_in_progress');
  running = true;
  await mkdir(cfg.BACKUP_DIR, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const name = `botwa-full-${stamp}.tar.gz.enc`;
  const tmp = path.join(cfg.BACKUP_DIR, `.${name}.partial`);
  let staged: string | undefined;
  try {
    const { dir, tar } = await stageArchive(cfg);
    staged = dir;
    await sealTo(tar, tmp, MAGIC_FULL, backupKey(cfg));
    await rename(tmp, path.join(cfg.BACKUP_DIR, name));
    await pruneBackups(cfg);
    return { name, size: (await stat(path.join(cfg.BACKUP_DIR, name))).size, kind: 'full' };
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  } finally {
    if (staged) await rm(staged, { recursive: true, force: true }).catch(() => undefined);
    running = false;
  }
}

// Migration bundle: "BOTWAMG1" | salt(16) | iv(12) | AES-256-GCM(tar.gz { db.sql, manifest.json, env, media/ }) | tag(16).
// The key comes from a passphrase (scrypt), not from ENCRYPTION_KEY: the new server does not have that key yet - it is inside.
const MAGIC_MIGRATION = Buffer.from('BOTWAMG1');
export const MIN_PASSPHRASE = 12;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function passKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase.normalize('NFKC'), salt, 32, SCRYPT);
}

/** Everything a new server needs: the database, the attachment files and the settings file (.env). */
export async function createMigrationBundle(cfg: Config, passphrase: string, envText: string, out: string): Promise<{ size: number }> {
  if (passphrase.length < MIN_PASSPHRASE) throw new Error('passphrase_too_short');
  if (!/ENCRYPTION_KEY=/.test(envText)) throw new Error('env_missing_encryption_key');
  const { dir, tar } = await stageArchive(cfg, { env: envText });
  try {
    const salt = randomBytes(16);
    await sealTo(tar, out, MAGIC_MIGRATION, passKey(passphrase, salt), salt);
    return { size: (await stat(out)).size };
  } catch (e) {
    await unlink(out).catch(() => undefined);
    throw e;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Decrypt and unpack a migration bundle into an empty folder (db.sql, manifest.json, env, media/). Wrong passphrase or any change = error. */
export async function openMigrationBundle(file: string, passphrase: string, outDir: string): Promise<{ manifest: { format: string; createdAt: string }; files: number }> {
  const fh = await open(file, 'r');
  let size: number, head: Buffer, tag: Buffer;
  try {
    size = (await fh.stat()).size;
    head = Buffer.alloc(8 + 16 + 12);
    if (size < head.length + 16) throw new Error('not_a_migration_bundle');
    await fh.read(head, 0, head.length, 0);
    tag = Buffer.alloc(16);
    await fh.read(tag, 0, 16, size - 16);
  } finally { await fh.close(); }
  if (!head.subarray(0, 8).equals(MAGIC_MIGRATION)) throw new Error('not_a_migration_bundle');
  const decipher = createDecipheriv('aes-256-gcm', passKey(passphrase, head.subarray(8, 24)), head.subarray(24, 36));
  decipher.setAuthTag(tag);
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const gz = path.join(outDir, '.bundle.tar.gz');
  try {
    await pipeline(createReadStream(file, { start: head.length, end: size - 17 }), decipher, createWriteStream(gz, { mode: 0o600 }));
  } catch {
    await unlink(gz).catch(() => undefined);
    throw new Error('wrong_passphrase_or_damaged');
  }
  // only plain files and folders under the expected names (no absolute paths, no "..", no links)
  const list = (await run('tar', ['-tvzf', gz])).split('\n').filter(Boolean);
  for (const line of list) {
    const type = line[0];
    const name = line.split(/\s+/).slice(5).join(' ');
    if (!['-', 'd'].includes(type!) || name.startsWith('/') || name.split('/').includes('..') || !/^(db\.sql|manifest\.json|env|media(\/.*)?)$/.test(name)) throw new Error('unexpected_bundle_content');
  }
  await run('tar', ['-xzf', gz, '-C', outDir, '--no-same-owner', '--no-same-permissions']);
  await unlink(gz);
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(path.join(outDir, 'manifest.json'), 'utf8')) as { format: string; createdAt: string };
  if (manifest.format !== 'botwa-full-1') throw new Error('unknown_bundle_format');
  const check = await checkDump(createReadStream(path.join(outDir, 'db.sql')));
  if (!check.ok) throw new Error(`bundle_database_incomplete: ${check.reason}`);
  return { manifest, files: list.filter((l) => l[0] === '-' && / media\//.test(l)).length };
}

/** Settings for the new server: everything from the old one (above all ENCRYPTION_KEY), except what belongs to the new machine. */
export const KEEP_LOCAL_ENV = ['DOMAIN', 'APP_ORIGIN', 'BIND_IP', 'COMPOSE_PROFILES', 'POSTGRES_PASSWORD', 'DATABASE_URL', 'HOST', 'PORT'];
export function mergeEnv(oldText: string, newText: string): string {
  const parse = (t: string) => new Map(t.split(/\r?\n/).map((l) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m).map((m) => [m[1]!, m[2]!]));
  const old = parse(oldText), cur = parse(newText);
  const lines = ['# Settings moved from the previous server by Botwa migration (' + new Date().toISOString() + ').', '# Kept from this server: ' + KEEP_LOCAL_ENV.join(', ')];
  const keys = [...new Set([...old.keys(), ...KEEP_LOCAL_ENV.filter((k) => cur.has(k))])];
  for (const k of keys) {
    const v = KEEP_LOCAL_ENV.includes(k) && cur.has(k) ? cur.get(k)! : old.get(k);
    if (v !== undefined) lines.push(`${k}=${v}`);
  }
  return lines.join('\n') + '\n';
}

/** Replace this server's database and attachment files with the bundle's (run with the server stopped). */
export async function restoreFromFolder(cfg: Config, dir: string): Promise<void> {
  const env = pgEnv(cfg.DATABASE_URL);
  await run('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-c', 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'], env);
  await run('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '--single-transaction', '-f', path.join(dir, 'db.sql')], env);
  const media = path.resolve(cfg.MEDIA_DIR);
  await mkdir(media, { recursive: true });
  for (const n of await readdir(media)) await rm(path.join(media, n), { recursive: true, force: true });
  const src = path.join(dir, 'media');
  const { cp } = await import('node:fs/promises');
  for (const n of await readdir(src).catch(() => [] as string[])) await cp(path.join(src, n), path.join(media, n), { recursive: true });
}

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BACKUP_NAME, backupPath, verifyBackup } from '../backup.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { S3Client } from './s3.js';

/**
 * Encrypted backups copied outside the server. The files are already encrypted on the server (AES-256-GCM with a key derived from
 * ENCRYPTION_KEY), so the storage provider holds only ciphertext; the key never leaves the server. Status kept in settings.
 */
export interface OffsiteStatus { configured: boolean; target: string | null; lastAt: string | null; lastName: string | null; lastOk: boolean | null; lastError: string | null; lastCheckAt: string | null; lastCheckOk: boolean | null; lastCheckName: string | null; lastCheckError: string | null }
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const offsiteConfigured = (cfg: Config) => !!(cfg.OFFSITE_S3_ENDPOINT && cfg.OFFSITE_S3_BUCKET && cfg.OFFSITE_S3_ACCESS_KEY && cfg.OFFSITE_S3_SECRET_KEY);
const client = (cfg: Config, f?: FetchLike) => new S3Client({ endpoint: cfg.OFFSITE_S3_ENDPOINT!, bucket: cfg.OFFSITE_S3_BUCKET!, region: cfg.OFFSITE_S3_REGION, accessKey: cfg.OFFSITE_S3_ACCESS_KEY!, secretKey: cfg.OFFSITE_S3_SECRET_KEY! }, f);
const prefix = (cfg: Config) => cfg.OFFSITE_S3_PREFIX.replace(/^\/+/, '');
/** where it goes, without any key (for the panel) */
const target = (cfg: Config) => offsiteConfigured(cfg) ? `${new URL(cfg.OFFSITE_S3_ENDPOINT!).host}/${cfg.OFFSITE_S3_BUCKET}/${prefix(cfg)}` : null;
const short = (e: unknown) => String((e as Error)?.message ?? e).replace(/[\r\n]+/g, ' ').slice(0, 160);

async function save(db: Db, patch: Partial<OffsiteStatus>): Promise<void> {
  await db.query(`INSERT INTO settings (key, value) VALUES ('offsite_status', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = settings.value || EXCLUDED.value, updated_at = now()`, [JSON.stringify(patch)]);
}

export async function offsiteStatus(db: Db, cfg: Config): Promise<OffsiteStatus> {
  const v = ((await db.query(`SELECT value FROM settings WHERE key = 'offsite_status'`)).rows[0]?.value ?? {}) as Partial<OffsiteStatus>;
  return { lastAt: null, lastName: null, lastOk: null, lastError: null, lastCheckAt: null, lastCheckOk: null, lastCheckName: null, lastCheckError: null, ...v, configured: offsiteConfigured(cfg), target: target(cfg) };
}

let busy = false;
/** Copy one local backup out, check it arrived whole (same size), then keep only the newest OFFSITE_KEEP copies there. */
export async function uploadBackup(db: Db, cfg: Config, name: string, f?: FetchLike): Promise<{ ok: boolean; error?: string }> {
  if (!offsiteConfigured(cfg)) return { ok: false, error: 'not_configured' };
  if (!BACKUP_NAME.test(name)) return { ok: false, error: 'bad_name' };
  if (busy) return { ok: false, error: 'busy' };
  busy = true;
  const s3 = client(cfg, f);
  try {
    const key = `${prefix(cfg)}${name}`;
    const up = await s3.putFile(key, backupPath(cfg, name));
    const there = await s3.head(key);
    if (!there || there.size !== up.size) throw new Error(`size_mismatch (${there?.size ?? 'missing'} vs ${up.size})`);
    await save(db, { lastAt: new Date().toISOString(), lastName: name, lastOk: true, lastError: null });
    // older copies outside the server: only our own files under the prefix, newest first by the timestamp in the name
    const ours = (await s3.list(prefix(cfg))).filter((o) => BACKUP_NAME.test(o.key.slice(prefix(cfg).length))).sort((a, b) => stamp(b.key).localeCompare(stamp(a.key)));
    for (const old of ours.slice(cfg.OFFSITE_KEEP)) await s3.delete(old.key).catch(() => undefined);
    return { ok: true };
  } catch (e) {
    await save(db, { lastAt: new Date().toISOString(), lastName: name, lastOk: false, lastError: short(e) });
    return { ok: false, error: short(e) };
  } finally { busy = false; }
}
const stamp = (key: string) => /(\d{8}-\d{6})/.exec(key)?.[1] ?? '';

/**
 * The restore check: the newest copy outside the server is downloaded to a temporary folder, decrypted and checked like a restore
 * would read it (verifyBackup), then deleted. Proves the outside copy is usable, not just present.
 */
export async function checkOffsite(db: Db, cfg: Config, f?: FetchLike): Promise<{ ok: boolean; name?: string; error?: string }> {
  if (!offsiteConfigured(cfg)) return { ok: false, error: 'not_configured' };
  const s3 = client(cfg, f);
  let dir: string | null = null;
  try {
    const newest = (await s3.list(prefix(cfg))).filter((o) => BACKUP_NAME.test(o.key.slice(prefix(cfg).length))).sort((a, b) => stamp(b.key).localeCompare(stamp(a.key)))[0];
    if (!newest) throw new Error('no_backup_outside');
    dir = await mkdtemp(path.join(tmpdir(), 'botwa-offsite-'));
    const file = path.join(dir, newest.key.slice(prefix(cfg).length));
    await s3.getFile(newest.key, file);
    const v = await verifyBackup(cfg, file);
    const name = newest.key.slice(prefix(cfg).length);
    await save(db, { lastCheckAt: new Date().toISOString(), lastCheckOk: v.ok, lastCheckName: name, lastCheckError: v.ok ? null : (v.reason ?? 'verify_failed') });
    return v.ok ? { ok: true, name } : { ok: false, name, error: v.reason ?? 'verify_failed' };
  } catch (e) {
    await save(db, { lastCheckAt: new Date().toISOString(), lastCheckOk: false, lastCheckError: short(e) });
    return { ok: false, error: short(e) };
  } finally { if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
}

/** Once a week (or when never done): the restore check of the outside copy. */
export async function weeklyOffsiteCheck(db: Db, cfg: Config): Promise<boolean> {
  if (!offsiteConfigured(cfg)) return false;
  const s = await offsiteStatus(db, cfg);
  if (!s.lastOk || (s.lastCheckAt && Date.now() - new Date(s.lastCheckAt).getTime() < 7 * 86_400_000)) return false;
  await checkOffsite(db, cfg);
  return true;
}

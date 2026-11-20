import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackup, createMigrationBundle, mergeEnv, openMigrationBundle, restoreFromFolder, verifyBackup, backupPath } from '../src/backup.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';

const hasTools = spawnSync('pg_dump', ['--version']).status === 0 && spawnSync('psql', ['--version']).status === 0;
const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test';
const PASS = 'correct horse battery staple';

describe('settings for the new server', () => {
  it('keeps the old secrets and this machine\'s address and database password', () => {
    const merged = mergeEnv('ENCRYPTION_KEY=old-key\nDOMAIN=old.example\nPOSTGRES_PASSWORD=oldpw\nSMTP_HOST=mail\n# comment\n', 'ENCRYPTION_KEY=new-key\nDOMAIN=new.example\nPOSTGRES_PASSWORD=newpw\nBIND_IP=1.2.3.4\n');
    expect(merged).toContain('ENCRYPTION_KEY=old-key');
    expect(merged).toContain('SMTP_HOST=mail');
    expect(merged).toContain('DOMAIN=new.example');
    expect(merged).toContain('POSTGRES_PASSWORD=newpw');
    expect(merged).toContain('BIND_IP=1.2.3.4');
    expect(merged).not.toContain('new-key');
    expect(merged).not.toContain('oldpw');
  });
});

describe.skipIf(!hasTools)('full backup and moving to a new server', () => {
  const db = createDb(DB_URL);
  let dir = '';
  let cfg: ReturnType<typeof loadConfig>;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'botwa-mig-'));
    cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: DB_URL, ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: 'https://panel.test', BACKUP_DIR: path.join(dir, 'backups'), MEDIA_DIR: path.join(dir, 'media') });
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    await db.query(`INSERT INTO users (email, name, role, password_hash) VALUES ('keep@t.io','Keep Me','admin','x')`);
    await mkdir(path.join(dir, 'media', 'clean', 'ab'), { recursive: true });
    await writeFile(path.join(dir, 'media', 'clean', 'ab', 'file1'), 'attachment-bytes');
  });
  afterAll(async () => { await db.end(); });

  it('a full backup holds the database and the files, encrypted, and verifies', async () => {
    const b = await createBackup(cfg, 'full');
    expect(b.name).toMatch(/^botwa-full-\d{8}-\d{6}\.tar\.gz\.enc$/);
    const raw = await readFile(backupPath(cfg, b.name));
    expect(raw.subarray(0, 8).toString()).toBe('BOTWAFU1');
    expect(raw.includes(Buffer.from('attachment-bytes'))).toBe(false);
    expect(raw.includes(Buffer.from('keep@t.io'))).toBe(false);
    const v = await verifyBackup(cfg, backupPath(cfg, b.name));
    expect(v).toMatchObject({ ok: true, files: 1 });
    expect(v.tables).toBeGreaterThan(20);
  });

  it('a migration bundle opens only with the passphrase and restores database, files and settings', async () => {
    const env = `ENCRYPTION_KEY=${cfg.ENCRYPTION_KEY}\nDOMAIN=old.example\n`;
    const bundle = path.join(dir, 'move.bundle');
    await expect(createMigrationBundle(cfg, 'short', env, bundle)).rejects.toThrow('passphrase_too_short');
    await createMigrationBundle(cfg, PASS, env, bundle);
    const raw = await readFile(bundle);
    expect(raw.subarray(0, 8).toString()).toBe('BOTWAMG1');
    expect(raw.includes(Buffer.from(cfg.ENCRYPTION_KEY))).toBe(false);
    await expect(openMigrationBundle(bundle, 'wrong passphrase!!', path.join(dir, 'x1'))).rejects.toThrow('wrong_passphrase_or_damaged');
    const bad = Buffer.from(raw); bad[200] = bad[200]! ^ 1;
    await writeFile(path.join(dir, 'bad.bundle'), bad);
    await expect(openMigrationBundle(path.join(dir, 'bad.bundle'), PASS, path.join(dir, 'x2'))).rejects.toThrow();

    const out = path.join(dir, 'opened');
    const r = await openMigrationBundle(bundle, PASS, out);
    expect(r.files).toBe(1);
    expect(await readFile(path.join(out, 'env'), 'utf8')).toBe(env);

    // the "new server": an emptied database and media folder, then restore
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const fresh = { ...cfg, MEDIA_DIR: path.join(dir, 'media2') };
    await restoreFromFolder(fresh, out);
    expect((await db.query(`SELECT name FROM users WHERE email = 'keep@t.io'`)).rows[0].name).toBe('Keep Me');
    expect(await readFile(path.join(dir, 'media2', 'clean', 'ab', 'file1'), 'utf8')).toBe('attachment-bytes');
    expect((await db.query(`SELECT count(*)::int AS n FROM schema_migrations`)).rows[0].n).toBeGreaterThan(30);
    expect(await readdir(path.join(dir, 'media2'))).toEqual(['clean']);
  });
});

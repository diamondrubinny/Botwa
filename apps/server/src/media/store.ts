import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { audit } from '../audit.js';
import type { InboundMedia } from '../channels/types.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { clamScan, type ScanResult } from './clamav.js';
import { detect, sanitizeFileName, type Detected } from './validate.js';

const MAX_SCAN_ATTEMPTS = 120; // with a 60s retry loop: ~2h of scanner downtime before giving up

/**
 * Safe handling of customer-supplied files:
 *  - type decided by content allowlist; stored under a random id, never under a user-supplied name/path
 *  - written to quarantine/, moved to clean/ only after ClamAV says OK; infected files are deleted
 *  - never served unless status = clean. Fail closed: no scanner => media disabled (unless explicitly allowed for dev)
 */
export class MediaService {
  constructor(private readonly db: Db, private readonly cfg: Config) {}

  get enabled(): boolean {
    return !!this.cfg.CLAMAV_HOST || this.cfg.MEDIA_ALLOW_UNSCANNED;
  }
  get maxBytes(): number {
    return this.cfg.MEDIA_MAX_MB * 1024 * 1024;
  }
  private dir(sub: 'quarantine' | 'clean'): string {
    return path.join(this.cfg.MEDIA_DIR, sub);
  }
  cleanPath(storageName: string): string {
    return path.join(this.dir('clean'), storageName);
  }

  async init(): Promise<void> {
    for (const sub of ['quarantine', 'clean'] as const) await mkdir(this.dir(sub), { recursive: true, mode: 0o700 });
  }

  async scanBuffer(buf: Buffer): Promise<ScanResult> {
    const host = this.cfg.CLAMAV_HOST;
    if (host) return this.limit(() => clamScan(buf, { host, port: this.cfg.CLAMAV_PORT }));
    return this.cfg.MEDIA_ALLOW_UNSCANNED ? { status: 'clean' } : { status: 'error', detail: 'scanner_not_configured' };
  }

  private async insertRow(messageId: string, r: {
    kind?: string; mime?: string; size?: number; sha256?: string; fileName?: string; storageName?: string;
    status: 'pending' | 'clean' | 'infected' | 'blocked'; detail?: string;
  }): Promise<string> {
    const { rows } = await this.db.query(
      `INSERT INTO attachments (message_id, kind, mime, size, sha256, file_name, storage_name, status, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [messageId, r.kind ?? 'document', r.mime ?? null, r.size ?? null, r.sha256 ?? null, r.fileName ?? null, r.storageName ?? null, r.status, r.detail ?? null],
    );
    return rows[0].id;
  }

  /** Inbound file from WhatsApp/Telegram. Never throws: problems become a visible "blocked" attachment. */
  async ingestInbound(messageId: string, media: InboundMedia): Promise<void> {
    const fileName = sanitizeFileName(media.fileName, 'file');
    const block = (detail: string) => this.insertRow(messageId, { fileName, status: 'blocked', detail }).then(() => undefined);
    try {
      if (!this.enabled) return await block('media_disabled');
      if (media.size && media.size > this.maxBytes) return await block('too_large');
      if (!(await this.withinQuota(messageId))) return await block('quota_exceeded');
      let buf: Buffer;
      try { buf = await this.limit(() => media.download()); } catch { return await block('download_failed'); }
      if (buf.length > this.maxBytes) return await block('too_large');
      const d = await detect(buf);
      if (!d) return await block('type_not_allowed');

      const storageName = randomUUID();
      await this.writeFile('quarantine', storageName, buf);
      const id = await this.insertRow(messageId, {
        kind: d.kind, mime: d.mime, size: buf.length, sha256: createHash('sha256').update(buf).digest('hex'),
        fileName: sanitizeFileName(media.fileName, `file.${d.ext}`), storageName, status: 'pending',
      });
      await this.scan(id).catch(() => undefined); // scanner trouble => stays pending, retried by scanPending()
    } catch {
      await block('processing_failed').catch(() => undefined);
    }
  }

  // At most a few downloads/scans in flight, so a flood of files cannot exhaust memory.
  private active = 0;
  private waiters: (() => void)[] = [];
  private async limit<T>(fn: () => Promise<T>): Promise<T> {
    while (this.active >= 4) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    try { return await fn(); } finally { this.active--; this.waiters.shift()?.(); }
  }

  /** Disk-fill protection: global byte cap and a per-contact daily file cap (inbound media is customer-controlled). */
  private async withinQuota(messageId: string): Promise<boolean> {
    const { rows } = await this.db.query(
      `SELECT
         (SELECT COALESCE(sum(size), 0) FROM attachments WHERE storage_name IS NOT NULL)::bigint AS total,
         (SELECT count(*) FROM attachments a JOIN messages m ON m.id = a.message_id
            WHERE a.created_at > now() - interval '1 day'
              AND m.conversation_id = (SELECT conversation_id FROM messages WHERE id = $1))::int AS recent`,
      [messageId],
    );
    return Number(rows[0].total) < this.cfg.MEDIA_MAX_TOTAL_GB * 1024 ** 3 && rows[0].recent < this.cfg.MEDIA_MAX_FILES_PER_CONTACT_DAY;
  }

  private async writeFile(sub: 'quarantine' | 'clean', name: string, buf: Buffer): Promise<void> {
    const p = path.join(this.dir(sub), name);
    await writeFile(p, buf, { mode: 0o600, flag: 'wx' });
    await chmod(p, 0o600);
  }

  /** Scan one pending attachment; moves it to clean/, deletes it if infected, or counts a retry on scanner error. */
  async scan(attachmentId: string): Promise<'clean' | 'infected' | 'pending' | 'blocked'> {
    const { rows } = await this.db.query(`SELECT storage_name, scan_attempts FROM attachments WHERE id = $1 AND status = 'pending'`, [attachmentId]);
    const row = rows[0];
    if (!row) return 'blocked';
    const q = path.join(this.dir('quarantine'), row.storage_name);
    let buf: Buffer;
    try { buf = await readFile(q); } catch {
      const cur = await this.db.query('SELECT status FROM attachments WHERE id=$1', [attachmentId]);
      if (cur.rows[0] && cur.rows[0].status !== 'pending') return cur.rows[0].status; // a concurrent scan already finished
      await this.db.query(`UPDATE attachments SET status='blocked', detail='file_missing' WHERE id=$1 AND status='pending'`, [attachmentId]);
      return 'blocked';
    }
    const res = await this.scanBuffer(buf);
    if (res.status === 'clean') {
      try {
        await rename(q, this.cleanPath(row.storage_name));
      } catch {
        // lost a race with a concurrent scan of the same file; its outcome stands
        const cur = await this.db.query('SELECT status FROM attachments WHERE id=$1', [attachmentId]);
        return cur.rows[0]?.status ?? 'blocked';
      }
      await this.db.query(`UPDATE attachments SET status='clean', detail=NULL WHERE id=$1 AND status='pending'`, [attachmentId]);
      return 'clean';
    }
    if (res.status === 'infected') {
      await unlink(q).catch(() => undefined);
      await this.db.query(`UPDATE attachments SET status='infected', detail=$2, storage_name=NULL WHERE id=$1 AND status='pending'`, [attachmentId, res.detail]);
      await audit(this.db, { action: 'media.infected', target: attachmentId, meta: { signature: res.detail } });
      return 'infected';
    }
    const attempts = row.scan_attempts + 1;
    if (attempts >= MAX_SCAN_ATTEMPTS) {
      await unlink(q).catch(() => undefined);
      await this.db.query(`UPDATE attachments SET status='blocked', detail='scan_failed', storage_name=NULL, scan_attempts=$2 WHERE id=$1 AND status='pending'`, [attachmentId, attempts]);
      return 'blocked';
    }
    await this.db.query(`UPDATE attachments SET scan_attempts=$2, detail=$3 WHERE id=$1 AND status='pending'`, [attachmentId, attempts, res.detail]);
    return 'pending';
  }

  /**
   * Scan stored files again with the scanner's current signatures (new threats are found after a file was accepted).
   * A file found infected now is deleted and marked, and reported. Oldest checks first; returns what happened.
   */
  async rescanClean(limit = 200, olderThanHours = 24 * 7): Promise<{ scanned: number; infected: number; errors: number }> {
    const out = { scanned: 0, infected: 0, errors: 0 };
    if (!this.cfg.CLAMAV_HOST) return out;
    const { rows } = await this.db.query(
      `SELECT id, storage_name FROM attachments WHERE status = 'clean' AND storage_name IS NOT NULL
          AND (last_scanned_at IS NULL OR last_scanned_at < now() - make_interval(hours => $2)) ORDER BY last_scanned_at NULLS FIRST LIMIT $1`, [limit, olderThanHours]);
    for (const r of rows) {
      let buf: Buffer;
      try { buf = await readFile(this.cleanPath(r.storage_name)); } catch { out.errors++; continue; }
      const res = await this.scanBuffer(buf);
      if (res.status === 'clean') { out.scanned++; await this.db.query('UPDATE attachments SET last_scanned_at = now() WHERE id = $1', [r.id]); continue; }
      if (res.status === 'infected') {
        out.scanned++; out.infected++;
        await unlink(this.cleanPath(r.storage_name)).catch(() => undefined);
        await this.db.query(`UPDATE attachments SET status = 'infected', detail = $2, storage_name = NULL, last_scanned_at = now() WHERE id = $1`, [r.id, res.detail]);
        await audit(this.db, { action: 'media.infected_rescan', target: r.id, meta: { signature: res.detail } });
        continue;
      }
      out.errors++;
      break;   // the scanner is not answering: try again next round
    }
    return out;
  }

  async scanPending(limit = 20): Promise<number> {
    if (!this.enabled) return 0;
    const { rows } = await this.db.query(`SELECT id FROM attachments WHERE status='pending' ORDER BY created_at LIMIT $1`, [limit]);
    for (const r of rows) await this.scan(r.id).catch(() => undefined);
    return rows.length;
  }

  /** Staff upload that already passed scanning: store directly in clean/ and register against the sent message. */
  async storeSent(messageId: string, buf: Buffer, d: Detected, fileName: string): Promise<string> {
    const storageName = randomUUID();
    await this.writeFile('clean', storageName, buf);
    return this.insertRow(messageId, {
      kind: d.kind, mime: d.mime, size: buf.length, sha256: createHash('sha256').update(buf).digest('hex'),
      fileName, storageName, status: 'clean',
    });
  }

  /** Delete stored files for rows matching a condition; call BEFORE deleting the rows (cascade drops them). */
  async purgeFiles(where: string, params: unknown[]): Promise<number> {
    const { rows } = await this.db.query(
      `SELECT a.storage_name FROM attachments a JOIN messages m ON m.id = a.message_id
         JOIN conversations v ON v.id = m.conversation_id WHERE a.storage_name IS NOT NULL AND ${where}`,
      params,
    );
    for (const r of rows) {
      await unlink(this.cleanPath(r.storage_name)).catch(() => undefined);
      await unlink(path.join(this.dir('quarantine'), r.storage_name)).catch(() => undefined);
    }
    return rows.length;
  }
}

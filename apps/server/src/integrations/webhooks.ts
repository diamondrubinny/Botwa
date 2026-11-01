import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config.js';
import { decrypt } from '../crypto.js';
import type { Db } from '../db.js';
import { checkUrl, FetchError, safePost } from '../kb/fetch.js';

export const EVENTS = ['message.received', 'message.sent', 'conversation.status_changed', 'conversation.assigned'] as const;
export type EventType = (typeof EVENTS)[number];

/** Header value: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>  (the receiver must also check t is recent). */
export const sign = (secret: string, body: string, t = Math.floor(Date.now() / 1000)): string => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

export function verifySignature(secret: string, header: string, body: string, toleranceSec = 300, now = Math.floor(Date.now() / 1000)): boolean {
  const m = /^t=(\d{9,12}),v1=([0-9a-f]{64})$/.exec(header);
  if (!m || Math.abs(now - Number(m[1])) > toleranceSec) return false;
  const want = Buffer.from(sign(secret, body, Number(m[1])).split('v1=')[1]!, 'hex'), got = Buffer.from(m[2]!, 'hex');
  return want.length === got.length && timingSafeEqual(want, got);
}

export function webhookUrlProblem(raw: string, allowHttp = false): string | null {
  try {
    const u = checkUrl(raw);
    if (u.protocol !== 'https:' && !allowHttp) return 'https_required';
    return null;
  } catch (e) { return e instanceof FetchError ? e.message : 'bad_url'; }
}

export type Sender = (url: string, body: string, headers: Record<string, string>) => Promise<{ status: number }>;
const BACKOFF_SEC = [60, 300, 1800, 7200, 21600, 86400];
const DISABLE_AFTER = 20;

/**
 * Outgoing webhooks with a durable queue: every event is stored per subscriber, delivered with a signature, retried with
 * increasing delays (about 1 min to 1 day) and the endpoint is switched off after many consecutive failures.
 */
export class WebhookService {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private lastPurge = 0;

  constructor(private readonly db: Db, private readonly cfg: Config, private readonly send: Sender = (u, b, h) => safePost(u, b, h)) {}

  start(): void { this.timer = setInterval(() => void this.tick().catch(() => undefined), 5000); this.timer.unref(); }
  stop(): void { clearInterval(this.timer); }

  /** Queue an event for every enabled webhook subscribed to it. Never throws into the caller's flow. */
  async enqueue(type: EventType, data: Record<string, unknown> & { message?: { text?: string } }): Promise<number> {
    try {
      const { rows } = await this.db.query('SELECT id, include_text FROM webhooks WHERE enabled AND $1 = ANY(events)', [type]);
      const eventId = randomUUID();
      for (const w of rows) {
        const d = w.include_text || !data.message ? data : { ...data, message: { ...data.message, text: undefined } };
        const payload = { id: eventId, type, createdAt: new Date().toISOString(), data: d };
        await this.db.query('INSERT INTO webhook_deliveries (webhook_id, event_id, event, payload) VALUES ($1,$2,$3,$4)', [w.id, eventId, type, JSON.stringify(payload)]);
      }
      return rows.length;
    } catch { return 0; }
  }

  /** Deliver everything that is due. Safe to call concurrently (rows are claimed first). */
  async tick(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    try {
      const { rows } = await this.db.query(
        `UPDATE webhook_deliveries d SET next_attempt_at = now() + interval '2 minutes'
          WHERE d.id IN (SELECT id FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= now() ORDER BY next_attempt_at LIMIT 25 FOR UPDATE SKIP LOCKED)
          RETURNING d.id, d.webhook_id, d.event, d.payload, d.attempts`);
      for (const r of rows) await this.deliver(r);
      if (Date.now() - this.lastPurge > 3600_000) { this.lastPurge = Date.now(); await this.db.query(`DELETE FROM webhook_deliveries WHERE created_at < now() - interval '7 days'`).catch(() => undefined); }
      return rows.length;
    } finally { this.busy = false; }
  }

  private async deliver(r: { id: string; webhook_id: string; event: string; payload: unknown; attempts: number }): Promise<void> {
    const w = (await this.db.query('SELECT url, secret_enc, enabled FROM webhooks WHERE id = $1', [r.webhook_id])).rows[0];
    if (!w || !w.enabled) { await this.db.query(`UPDATE webhook_deliveries SET status = 'failed', last_error = 'webhook_disabled' WHERE id = $1`, [r.id]); return; }
    const body = JSON.stringify(r.payload);
    let status = 0, error: string | null = null;
    try {
      const res = await this.send(w.url, body, {
        'content-type': 'application/json', 'user-agent': 'BotwaWebhooks/1.0', 'x-botwa-event': r.event, 'x-botwa-delivery': r.id,
        'x-botwa-signature': sign(decrypt(w.secret_enc, this.cfg.ENCRYPTION_KEY), body),
      });
      status = res.status;
      if (status < 200 || status >= 300) error = `http_${status}`;
    } catch (e) { error = e instanceof Error ? e.message.slice(0, 80) : 'failed'; }
    const attempts = r.attempts + 1;
    if (!error) {
      await this.db.query(`UPDATE webhook_deliveries SET status = 'delivered', attempts = $2, response_code = $3, last_error = NULL, delivered_at = now() WHERE id = $1`, [r.id, attempts, status]);
      await this.db.query('UPDATE webhooks SET failures = 0 WHERE id = $1', [r.webhook_id]);
      return;
    }
    const last = attempts > BACKOFF_SEC.length;
    await this.db.query(
      `UPDATE webhook_deliveries SET attempts = $2, response_code = $3, last_error = $4, status = $5, next_attempt_at = now() + make_interval(secs => $6) WHERE id = $1`,
      [r.id, attempts, status || null, error, last ? 'failed' : 'pending', BACKOFF_SEC[Math.min(attempts - 1, BACKOFF_SEC.length - 1)]],
    );
    if (last) {
      const f = await this.db.query('UPDATE webhooks SET failures = failures + 1 WHERE id = $1 RETURNING failures', [r.webhook_id]);
      if ((f.rows[0]?.failures ?? 0) >= DISABLE_AFTER) await this.db.query(`UPDATE webhooks SET enabled = false, disabled_reason = 'too_many_failures' WHERE id = $1`, [r.webhook_id]);
    }
  }
}

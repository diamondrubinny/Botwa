import { z } from 'zod';
import type { Db } from '../db.js';

/** Outbound pacing that makes the account behave like a person (reduces the risk of WhatsApp/Telegram restricting it). */
export const sendingSchema = z.object({
  minDelayMs: z.number().int().min(0).max(60_000),
  maxDelayMs: z.number().int().min(0).max(120_000),
  perMinute: z.number().int().min(1).max(120),
  perDay: z.number().int().min(1).max(20_000),
  /** new numbers: cap grows with the channel's age (20 + 40/day) up to perDay */
  warmup: z.boolean(),
  /** show "typing…" (WhatsApp) for a time proportional to the message length before sending */
  typing: z.boolean(),
  /** staff may only write to a customer who messaged within this many hours (0 = no limit). Unsolicited messages are what gets numbers banned. */
  replyWindowHours: z.number().int().min(0).max(720).default(168),
  /** after this many consecutive send failures the channel pauses itself (0 = never) */
  failuresBeforePause: z.number().int().min(0).max(20).default(3),
  pauseMinutes: z.number().int().min(1).max(1440).default(15),
  /** mark customer messages as read when staff open the conversation (what a person does) */
  readReceipts: z.boolean().default(true),
}).refine((v) => v.maxDelayMs >= v.minDelayMs, { message: 'maxDelayMs must be >= minDelayMs' });
export type SendingSettings = z.infer<typeof sendingSchema>;

export const DEFAULT_SENDING: SendingSettings = { minDelayMs: 1500, maxDelayMs: 4000, perMinute: 12, perDay: 500, warmup: true, typing: true, replyWindowHours: 168, failuresBeforePause: 3, pauseMinutes: 15, readReceipts: true };

/** Unthrottled profile used when NODE_ENV=test so the suite is fast; production uses DEFAULT_SENDING unless configured. */
export const TEST_SENDING: SendingSettings = { minDelayMs: 0, maxDelayMs: 0, perMinute: 120, perDay: 20_000, warmup: false, typing: false, replyWindowHours: 168, failuresBeforePause: 3, pauseMinutes: 15, readReceipts: true };

export async function loadSending(db: Db, fallback: SendingSettings = DEFAULT_SENDING): Promise<SendingSettings> {
  const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'sending'`);
  const p = sendingSchema.safeParse(rows[0]?.value);
  return p.success ? p.data : fallback;
}

export const warmupCap = (s: SendingSettings, channelAgeDays: number) => (s.warmup ? Math.min(s.perDay, 20 + 40 * Math.max(0, Math.floor(channelAgeDays))) : s.perDay);

export class SendError extends Error {
  constructor(public code: 'send_throttled' | 'daily_limit' | 'queue_full' | 'channel_paused') { super(code); }
}

interface Lane { tail: Promise<unknown>; last: number; recent: number[]; pending: number; failures: number; pausedUntil: number }
const MAX_QUEUE = 50;

/**
 * One lane per channel: sends are serialised, spaced by a random human-like delay, limited per minute and per day.
 * Interactive callers use a short maxWait (fail fast with send_throttled); background callers may wait longer.
 */
export class ChannelSender {
  private lanes = new Map<string, Lane>();
  /** Called when a channel pauses itself after repeated failures (record an event / alert). */
  onAutoPause?: (channelId: string, until: Date, failures: number) => void;

  constructor(private readonly db: Db, private readonly now: () => number = Date.now, private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {}

  pausedUntil(channelId: string): number { return this.lanes.get(channelId)?.pausedUntil ?? 0; }
  resume(channelId: string): void { const l = this.lanes.get(channelId); if (l) { l.pausedUntil = 0; l.failures = 0; } }

  private lane(id: string): Lane {
    let l = this.lanes.get(id);
    if (!l) { l = { tail: Promise.resolve(), last: 0, recent: [], pending: 0, failures: 0, pausedUntil: 0 }; this.lanes.set(id, l); }
    return l;
  }

  /** Outbound messages in the last 24h and last minute (from the database, so restarts do not reset the caps). */
  async usage(channelId: string): Promise<{ day: number; minute: number; ageDays: number }> {
    const { rows } = await this.db.query(
      `SELECT count(*) FILTER (WHERE m.created_at > now() - interval '24 hours')::int AS day,
              count(*) FILTER (WHERE m.created_at > now() - interval '1 minute')::int AS minute,
              EXTRACT(EPOCH FROM (now() - ch.created_at)) / 86400 AS age
         FROM channels ch
         LEFT JOIN conversations c ON c.channel_id = ch.id
         LEFT JOIN messages m ON m.conversation_id = c.id AND m.direction = 'out' AND m.created_at > now() - interval '24 hours'
        WHERE ch.id = $1 GROUP BY ch.created_at`,
      [channelId],
    );
    const r = rows[0];
    return { day: r?.day ?? 0, minute: r?.minute ?? 0, ageDays: Number(r?.age ?? 0) };
  }

  async run<T>(channelId: string, settings: SendingSettings, fn: () => Promise<T>, opts: { maxWaitMs?: number } = {}): Promise<T> {
    const lane = this.lane(channelId);
    if (lane.pending >= MAX_QUEUE) throw new SendError('queue_full');
    lane.pending++;
    const maxWait = opts.maxWaitMs ?? 25_000;
    const job = lane.tail.catch(() => undefined).then(async () => {
      if (this.now() < lane.pausedUntil) throw new SendError('channel_paused');
      const u = await this.usage(channelId);
      if (u.day >= warmupCap(settings, u.ageDays)) throw new SendError('daily_limit');
      const t0 = this.now();
      const spacing = settings.minDelayMs + Math.random() * (settings.maxDelayMs - settings.minDelayMs);
      let wait = Math.max(0, lane.last + spacing - t0);
      lane.recent = lane.recent.filter((t) => t0 - t < 60_000);
      const minuteCount = Math.max(u.minute, lane.recent.length);
      if (minuteCount >= settings.perMinute) wait = Math.max(wait, 60_000 - (t0 - (lane.recent[0] ?? t0)));
      if (wait > maxWait) throw new SendError('send_throttled');
      if (wait > 0) await this.sleep(wait);
      lane.last = this.now();
      lane.recent.push(lane.last);
      try {
        const out = await fn();
        lane.failures = 0;
        return out;
      } catch (e) {
        // repeated failures usually mean the platform is rejecting us: stop for a while instead of hammering it
        lane.failures++;
        if (settings.failuresBeforePause > 0 && lane.failures >= settings.failuresBeforePause) {
          lane.pausedUntil = this.now() + settings.pauseMinutes * 60_000;
          this.onAutoPause?.(channelId, new Date(lane.pausedUntil), lane.failures);
          lane.failures = 0;
        }
        throw e;
      }
    });
    lane.tail = job;
    try { return await job; } finally { lane.pending--; }
  }
}

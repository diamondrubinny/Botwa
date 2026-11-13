import { z } from 'zod';
import type { Db } from './db.js';

/**
 * Monthly outgoing-message limit of an official WhatsApp number. The number (1000 by default) and what happens when it is reached
 * are the organisation's choice: Meta's free allowances and prices change, so check them in Meta's current pricing documentation.
 * - warn: keep sending, alert at warnAt% and at 100%
 * - block_auto: at the limit, automatic messages (bot, away reply, automations) stop; people can still answer
 * - block_all: at the limit, nothing more is sent this month
 */
export const usageLimitSchema = z.object({
  limit: z.number().int().min(0).max(10_000_000).default(1000),   // 0 = count only, no limit
  action: z.enum(['warn', 'block_auto', 'block_all']).default('warn'),
  warnAt: z.number().int().min(50).max(99).default(80),
});
export type UsageLimit = z.infer<typeof usageLimitSchema>;
export const DEFAULT_USAGE_LIMIT: UsageLimit = { limit: 1000, action: 'warn', warnAt: 80 };
export type UsageKind = 'text' | 'media' | 'template' | 'interactive' | 'reaction';
const KINDS: UsageKind[] = ['text', 'media', 'template', 'interactive', 'reaction'];

/** First day of the month in UTC (YYYY-MM-01), and the first day of the next one (when the count starts again). */
export function monthOf(d = new Date()): { month: string; resetsAt: string } {
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  return { month: new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10), resetsAt: new Date(Date.UTC(y, m + 1, 1)).toISOString() };
}

export async function loadUsageLimit(db: Db, channelId: string): Promise<UsageLimit> {
  const v = (await db.query('SELECT usage_limit FROM channels WHERE id = $1', [channelId])).rows[0]?.usage_limit;
  const p = usageLimitSchema.safeParse(v ?? {});
  return p.success ? p.data : DEFAULT_USAGE_LIMIT;
}

interface Row { text: number; media: number; template: number; interactive: number; reaction: number; seeded: number; blocked: number; warned: boolean; reached: boolean }
const total = (r: Row) => KINDS.reduce((n, k) => n + r[k], 0) + r.seeded;

/** This month's row for the number, created on first use with what this channel already sent this month (so mid-month starts are right). */
async function row(db: Db, numberKey: string, channelId: string, now: Date): Promise<Row> {
  const { month } = monthOf(now);
  await db.query(
    `INSERT INTO wa_monthly_usage (number_key, month, channel_id, seeded)
     SELECT $1, $2::date, $3, (SELECT count(*)::int FROM messages m JOIN conversations c ON c.id = m.conversation_id
                                WHERE c.channel_id = $3 AND m.direction = 'out' AND m.external_id IS NOT NULL AND m.created_at >= $2::date)
     ON CONFLICT (number_key, month) DO NOTHING`, [numberKey, month, channelId]);
  return (await db.query(`SELECT text, media, template, interactive, reaction, seeded, blocked, warned, reached FROM wa_monthly_usage WHERE number_key = $1 AND month = $2`, [numberKey, month])).rows[0] as Row;
}

export interface UsageReport { month: string; resetsAt: string; total: number; byKind: Record<UsageKind, number>; seeded: number; blocked: number; limit: UsageLimit; percent: number | null }

export async function usageReport(db: Db, numberKey: string, channelId: string, now = new Date()): Promise<UsageReport> {
  const r = await row(db, numberKey, channelId, now);
  const limit = await loadUsageLimit(db, channelId);
  const t = total(r);
  return { ...monthOf(now), total: t, byKind: Object.fromEntries(KINDS.map((k) => [k, r[k]])) as Record<UsageKind, number>, seeded: r.seeded, blocked: r.blocked, limit, percent: limit.limit > 0 ? Math.round((t / limit.limit) * 1000) / 10 : null };
}

/** May this message go out? Refusals are counted (shown in the panel). */
export async function usageAllows(db: Db, numberKey: string, channelId: string, auto: boolean, now = new Date()): Promise<boolean> {
  const limit = await loadUsageLimit(db, channelId);
  if (limit.limit === 0 || limit.action === 'warn') return true;
  if (limit.action === 'block_auto' && !auto) return true;
  const r = await row(db, numberKey, channelId, now);
  if (total(r) < limit.limit) return true;
  await db.query(`UPDATE wa_monthly_usage SET blocked = blocked + 1 WHERE number_key = $1 AND month = $2`, [numberKey, monthOf(now).month]);
  return false;
}

/** Count one message that went out. Returns which alert threshold this message crossed for the first time this month, if any. */
export async function countUsage(db: Db, numberKey: string, channelId: string, kind: UsageKind, now = new Date()): Promise<{ total: number; crossed: 'warn' | 'reached' | null; limit: UsageLimit }> {
  await row(db, numberKey, channelId, now);
  const { month } = monthOf(now);
  const r = (await db.query(`UPDATE wa_monthly_usage SET ${kind} = ${kind} + 1, channel_id = $3 WHERE number_key = $1 AND month = $2
                              RETURNING text, media, template, interactive, reaction, seeded, blocked, warned, reached`, [numberKey, month, channelId])).rows[0] as Row;
  const limit = await loadUsageLimit(db, channelId);
  const t = total(r);
  if (limit.limit === 0) return { total: t, crossed: null, limit };
  // claim each alert once (the conditional update makes it safe when two sends cross the line together)
  if (t >= limit.limit && !r.reached) {
    const won = (await db.query(`UPDATE wa_monthly_usage SET reached = true, warned = true WHERE number_key = $1 AND month = $2 AND NOT reached`, [numberKey, month])).rowCount;
    if (won) return { total: t, crossed: 'reached', limit };
  } else if (t >= Math.ceil((limit.limit * limit.warnAt) / 100) && !r.warned) {
    const won = (await db.query(`UPDATE wa_monthly_usage SET warned = true WHERE number_key = $1 AND month = $2 AND NOT warned`, [numberKey, month])).rowCount;
    if (won) return { total: t, crossed: 'warn', limit };
  }
  return { total: t, crossed: null, limit };
}

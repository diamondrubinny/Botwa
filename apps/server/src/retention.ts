import type { Config } from './config.js';
import type { Db } from './db.js';
import { purgeOldMessages } from './inbox.js';
import type { MediaService } from './media/store.js';

/** What the retention clean-up deletes, and after how many days (0 = kept). Shown in the panel as the policy in force. */
export function retentionPolicy(cfg: Config) {
  return [
    { key: 'messages', label: 'הודעות, קבצים, פרטי הזדהות ושיחות ישנות', days: cfg.MESSAGE_RETENTION_DAYS },
    { key: 'kb_queries', label: 'יומן שאלות מאגר הידע', days: cfg.KB_QUERY_RETENTION_DAYS },
    { key: 'kb_learn', label: 'הצעות למידה שלא אושרו', days: 90 },
    { key: 'webchat_visitors', label: 'מבקרי הצ׳אט באתר (מזהה דפדפן)', days: 90 },
    { key: 'audit', label: 'יומן הפעולות (ביקורת)', days: cfg.AUDIT_RETENTION_DAYS },
    { key: 'forms_unsigned', label: 'בקשות טופס שלא נחתמו', days: cfg.FORM_UNSIGNED_RETENTION_DAYS },
    { key: 'forms_signed', label: 'טפסים חתומים', days: cfg.FORM_SIGNED_RETENTION_DAYS },
  ] as const;
}
export type RetentionKey = ReturnType<typeof retentionPolicy>[number]['key'];
export type RetentionCounts = Partial<Record<RetentionKey, number>>;

const n = (r: { rowCount: number | null }) => r.rowCount ?? 0;
let running = false;

/**
 * One pass of every retention rule, recorded in retention_runs with how many records of each kind were deleted (counts only).
 * A rule with 0 days keeps everything. A failing rule does not stop the others; the error is recorded.
 */
export async function runRetention(db: Db, cfg: Config, media?: MediaService, manual = false): Promise<{ counts: RetentionCounts; error?: string }> {
  if (running) return { counts: {}, error: 'already_running' };
  running = true;
  const counts: RetentionCounts = {};
  const errors: string[] = [];
  const step = async (key: RetentionKey, days: number, fn: () => Promise<number>) => {
    if (days <= 0) return;
    try { counts[key] = await fn(); } catch (e) { errors.push(`${key}: ${(e as Error).message.slice(0, 120)}`); }
  };
  try {
    await step('messages', cfg.MESSAGE_RETENTION_DAYS, () => purgeOldMessages(db, cfg.MESSAGE_RETENTION_DAYS, media));
    await step('kb_queries', cfg.KB_QUERY_RETENTION_DAYS, async () => n(await db.query(`DELETE FROM kb_queries WHERE created_at < now() - make_interval(days => $1)`, [cfg.KB_QUERY_RETENTION_DAYS])));
    await step('kb_learn', 90, async () => n(await db.query(`DELETE FROM kb_learn WHERE status <> 'approved' AND updated_at < now() - interval '90 days'`)));
    await step('webchat_visitors', 90, async () => n(await db.query(`DELETE FROM webchat_visitors WHERE last_seen_at < now() - interval '90 days'`)));
    await step('audit', cfg.AUDIT_RETENTION_DAYS, async () => n(await db.query(`DELETE FROM audit_log WHERE created_at < now() - make_interval(days => $1)`, [cfg.AUDIT_RETENTION_DAYS])));
    // never signed: nothing of legal weight; the request goes with its codes, the signer's phone and its events
    await step('forms_unsigned', cfg.FORM_UNSIGNED_RETENTION_DAYS, async () => n(await db.query(
      `DELETE FROM form_requests r WHERE r.status <> 'signed' AND r.created_at < now() - make_interval(days => $1)
          AND NOT EXISTS (SELECT 1 FROM form_submissions s WHERE s.request_id = r.id)`, [cfg.FORM_UNSIGNED_RETENTION_DAYS])));
    await step('forms_signed', cfg.FORM_SIGNED_RETENTION_DAYS, async () => n(await db.query(
      `DELETE FROM form_requests r WHERE r.status = 'signed' AND coalesce(r.signed_at, r.created_at) < now() - make_interval(days => $1)`, [cfg.FORM_SIGNED_RETENTION_DAYS])));
    const error = errors.length ? errors.join('; ') : undefined;
    await db.query(`INSERT INTO retention_runs (manual, counts, error) VALUES ($1, $2, $3)`, [manual, JSON.stringify(counts), error ?? null]);
    await db.query(`DELETE FROM retention_runs WHERE ran_at < now() - interval '400 days'`);
    return { counts, ...(error ? { error } : {}) };
  } finally { running = false; }
}

export async function retentionRuns(db: Db, limit = 30): Promise<{ ranAt: string; manual: boolean; counts: RetentionCounts; error: string | null }[]> {
  return (await db.query(`SELECT ran_at AS "ranAt", manual, counts, error FROM retention_runs ORDER BY ran_at DESC LIMIT $1`, [limit])).rows;
}

import type { Db } from './db.js';

export async function audit(
  db: Db,
  entry: { actorId?: string | null; action: string; target?: string; ip?: string; meta?: Record<string, unknown> },
): Promise<void> {
  await db.query('INSERT INTO audit_log (actor_id, action, target, ip, meta) VALUES ($1,$2,$3,$4,$5)', [
    entry.actorId ?? null,
    entry.action,
    entry.target ?? null,
    entry.ip ?? null,
    entry.meta ? JSON.stringify(entry.meta) : null,
  ]);
}

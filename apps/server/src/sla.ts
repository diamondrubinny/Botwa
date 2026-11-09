import { z } from 'zod';
import type { Db } from './db.js';

/** Service-level target: a customer message that waits longer than this for a human reply is a breach. Wall-clock minutes. */
export const slaSchema = z.object({ enabled: z.boolean(), targetMinutes: z.number().int().min(1).max(10080) });
export type Sla = z.infer<typeof slaSchema>;
export const DEFAULT_SLA: Sla = { enabled: false, targetMinutes: 30 };

export async function loadSla(db: Db): Promise<Sla> {
  const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'sla'`);
  const p = slaSchema.safeParse(rows[0]?.value);
  return p.success ? p.data : DEFAULT_SLA;
}

/**
 * Open conversations whose latest human-relevant message is from the customer and older than the target,
 * not yet alerted for that message. Snoozed conversations and ones the menu bot still holds are excluded.
 */
export async function dueSlaAlerts(db: Db, targetMinutes: number): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT c.id FROM conversations c
       JOIN LATERAL (SELECT direction, created_at FROM messages m WHERE m.conversation_id = c.id AND NOT m.auto ORDER BY m.created_at DESC LIMIT 1) lm ON true
      WHERE c.status = 'open' AND c.bot_state IS DISTINCT FROM 'menu' AND (c.snoozed_until IS NULL OR c.snoozed_until <= now())
        AND lm.direction = 'in' AND lm.created_at <= now() - make_interval(mins => $1)
        AND (c.sla_alerted_at IS NULL OR c.sla_alerted_at < lm.created_at)
      LIMIT 200`,
    [targetMinutes],
  );
  return rows.map((r) => r.id as string);
}

/** Fire one alert per breaching conversation (webhook + push). Returns how many were raised. */
export async function runSlaCheck(
  db: Db,
  raise: (conversationId: string) => void,
): Promise<number> {
  const sla = await loadSla(db);
  if (!sla.enabled) return 0;
  let n = 0;
  for (const id of await dueSlaAlerts(db, sla.targetMinutes)) {
    const u = await db.query(`UPDATE conversations SET sla_alerted_at = now() WHERE id = $1 RETURNING id`, [id]);
    if (u.rowCount) { raise(id); n++; }
  }
  return n;
}

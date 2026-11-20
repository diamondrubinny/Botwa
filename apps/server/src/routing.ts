import { z } from 'zod';
import type { Db } from './db.js';

export const routingSchema = z.object({ mode: z.enum(['off', 'round_robin', 'least_busy']) });
export type RoutingSettings = z.infer<typeof routingSchema>;

export async function loadRouting(db: Db): Promise<RoutingSettings> {
  const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'routing'`);
  const p = routingSchema.safeParse(rows[0]?.value);
  return p.success ? p.data : { mode: 'off' };
}

/**
 * Assign an unassigned conversation to an on-duty, active agent (role 'agent' only; supervisors keep oversight).
 *  round_robin: the agent who was assigned longest ago.   least_busy: fewest open conversations, then longest-ago.
 * Serialised with an advisory lock so concurrent inbound messages cannot both pick the same "least busy" agent.
 * Returns the chosen user id, or null when routing is off / nobody is available / already assigned.
 */
export async function autoAssign(db: Db, conversationId: string): Promise<string | null> {
  const mode = (await loadRouting(db)).mode;
  if (mode === 'off') return null;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(727001)');
    const order = mode === 'least_busy'
      ? `(SELECT count(*) FROM conversations c WHERE c.assigned_to = u.id AND c.status = 'open') ASC, u.last_assigned_at ASC NULLS FIRST, u.id`
      : `u.last_assigned_at ASC NULLS FIRST, u.id`;
    const { rows } = await client.query(
      `WITH pick AS (
         SELECT u.id FROM users u WHERE u.active AND u.available AND u.role = 'agent' ORDER BY ${order} LIMIT 1
       ), upd AS (
         UPDATE conversations SET assigned_to = (SELECT id FROM pick)
          WHERE id = $1 AND assigned_to IS NULL AND EXISTS (SELECT 1 FROM pick) RETURNING assigned_to
       )
       UPDATE users SET last_assigned_at = now() WHERE id IN (SELECT assigned_to FROM upd) RETURNING id`,
      [conversationId],
    );
    await client.query('COMMIT');
    return rows[0]?.id ?? null;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

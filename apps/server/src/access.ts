import type { AuthUser } from './auth.js';
import type { Db } from './db.js';

import { can } from './permissions.js';

/** sees every conversation (supervisors/admins and any custom role granted inbox.view_all) */
export const isManager = (u: AuthUser) => can(u, 'inbox.view_all');

export interface AccessibleConversation {
  id: string;
  channel_id: string;
  assigned_to: string | null;
  status: string;
  external_id: string;
  blocked: boolean;
  opted_out: boolean;
  channel_type?: string;
}

/** Agents may only touch conversations assigned to them or still unassigned. Returns null (=> 404) otherwise. */
export async function loadAccessible(db: Db, user: AuthUser, id: string): Promise<AccessibleConversation | null> {
  const { rows } = await db.query(
    `SELECT c.id, c.channel_id, c.assigned_to, c.status, ct.external_id, ct.blocked, ct.opted_out, ch.type AS channel_type
       FROM conversations c JOIN contacts ct ON ct.id = c.contact_id JOIN channels ch ON ch.id = c.channel_id WHERE c.id = $1`,
    [id],
  );
  const c = rows[0];
  if (!c) return null;
  if (!isManager(user) && c.assigned_to !== null && c.assigned_to !== user.id) return null;
  return c;
}

export type SendBlock = 'contact_blocked' | 'contact_opted_out' | 'outside_reply_window';

/**
 * Policy checks before staff write to a customer. Replying is fine; writing to someone who has not contacted us recently,
 * who asked us to stop, or who is blocked is exactly what gets numbers reported and banned.
 */
export async function sendBlock(db: Db, conv: AccessibleConversation, replyWindowHours: number): Promise<SendBlock | null> {
  if (conv.blocked) return 'contact_blocked';
  if (conv.opted_out) return 'contact_opted_out';
  // The official API only allows free-form messages within 24h of the customer's last message (verify against Meta's docs).
  if (conv.channel_type === 'whatsapp_cloud') replyWindowHours = replyWindowHours > 0 ? Math.min(replyWindowHours, 24) : 24;
  if (replyWindowHours > 0) {
    const { rows } = await db.query(
      `SELECT (max(created_at) IS NOT NULL AND max(created_at) > now() - make_interval(hours => $2)) AS ok
         FROM messages WHERE conversation_id = $1 AND direction = 'in'`,
      [conv.id, replyWindowHours],
    );
    if (!rows[0]?.ok) return 'outside_reply_window';
  }
  return null;
}

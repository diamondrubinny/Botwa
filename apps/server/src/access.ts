import type { AuthUser } from './auth.js';
import type { Db } from './db.js';

export const isManager = (u: AuthUser) => u.role === 'admin' || u.role === 'supervisor';

export interface AccessibleConversation {
  id: string;
  channel_id: string;
  assigned_to: string | null;
  status: string;
  external_id: string;
  blocked: boolean;
}

/** Agents may only touch conversations assigned to them or still unassigned. Returns null (=> 404) otherwise. */
export async function loadAccessible(db: Db, user: AuthUser, id: string): Promise<AccessibleConversation | null> {
  const { rows } = await db.query(
    `SELECT c.id, c.channel_id, c.assigned_to, c.status, ct.external_id, ct.blocked
       FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = $1`,
    [id],
  );
  const c = rows[0];
  if (!c) return null;
  if (!isManager(user) && c.assigned_to !== null && c.assigned_to !== user.id) return null;
  return c;
}

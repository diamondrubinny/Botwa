import type { Db } from '../db.js';

export interface StoredUsername { username: string | null; status: string; context: string | null; updatedAt: string }

/** Keep what Meta last said about the number's business username (read on the panel, or reported by its webhook). */
export async function saveUsername(db: Db, channelId: string, v: { username?: string | null; status?: string; context?: string | null }): Promise<void> {
  const status = ['approved', 'reserved', 'deleted', 'none'].includes(v.status ?? '') ? v.status! : 'none';
  const username = status === 'deleted' || status === 'none' ? null : (v.username ?? '').toLowerCase().slice(0, 35) || null;
  const context = v.context ? String(v.context).slice(0, 40) : null;
  await db.query(
    `INSERT INTO wa_business_usernames (channel_id, username, status, context) VALUES ($1,$2,$3,$4)
     ON CONFLICT (channel_id) DO UPDATE SET username = EXCLUDED.username, status = EXCLUDED.status, context = EXCLUDED.context, updated_at = now()`,
    [channelId, username, status, context],
  );
}

export async function loadUsername(db: Db, channelId: string): Promise<StoredUsername | null> {
  const r = (await db.query(`SELECT username, status, context, updated_at FROM wa_business_usernames WHERE channel_id = $1`, [channelId])).rows[0];
  return r ? { username: r.username, status: r.status, context: r.context, updatedAt: new Date(r.updated_at).toISOString() } : null;
}

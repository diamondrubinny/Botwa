import type { Db } from '../db.js';
import { flowSchema, validateFlow, type Flow } from './schema.js';

/** The saved flow, or null when none is saved / it no longer validates (the menu bot is used instead). */
export async function loadFlow(db: Db): Promise<Flow | null> {
  const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'flow'`);
  const p = flowSchema.safeParse(rows[0]?.value);
  return p.success && validateFlow(p.data).length === 0 ? p.data : null;
}

export async function saveFlow(db: Db, flow: Flow): Promise<void> {
  await db.query(`INSERT INTO settings (key, value) VALUES ('flow', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(flow)]);
}

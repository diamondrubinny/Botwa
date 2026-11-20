import type { Db } from '../db.js';
import { resolveArea } from './areas.js';
import { officersForTopic } from './officers.js';
import { officerUserFor } from './whoIs.js';

export type ResponsibleVia = 'text' | 'tag' | 'area' | 'default' | 'backup' | 'officer';
export interface Responsible { userId: string; via: ResponsibleVia; topic?: string }

const VIA_TEXT: Record<ResponsibleVia, string> = {
  text: 'לפי הנושא שבהודעת הלקוח',
  tag: 'לפי נושא הפנייה',
  area: 'לפי האזור או הבניין שהלקוח ציין',
  default: 'ממונה הבטיחות האחראי (ברירת מחדל)',
  backup: 'הממונה החלופי',
  officer: 'ממונה בטיחות זמין עם הכי מעט פניות פתוחות',
};
export const responsibleNote = (r: Responsible, name: string) => `👷 הפנייה שויכה ל${name}: ${VIA_TEXT[r.via]}${r.topic ? ` (${r.topic})` : ''}.`;

const activeUser = async (db: Db, id: string | null | undefined): Promise<string | null> =>
  id ? ((await db.query(`SELECT id FROM users WHERE id = $1 AND active`, [id])).rows[0]?.id as string | undefined) ?? null : null;

/**
 * The safety officer responsible for a conversation the bot hands over, never "whoever is free":
 * 1. the officer of a topic named in the customer's message; 2. the officer of a topic the conversation is tagged with (the topic
 * chosen in the flow); 3. the officer of the area or building the customer gave; 4. the unit's default responsible officer;
 * 5. the backup officer (escalation); 6. any safety officer with an active account, the least busy. Null only when the unit has no
 * officer with an account at all (then normal routing applies).
 */
export async function findResponsible(db: Db, convId: string, opts: { text?: string | null; defaultUserId?: string | null; backupUserId?: string | null } = {}): Promise<Responsible | null> {
  // what the customer wrote lately (when the caller did not pass the message itself)
  const text = opts.text !== undefined ? opts.text : ((await db.query(`SELECT string_agg(body, ' ') AS t FROM (SELECT body FROM messages WHERE conversation_id = $1 AND direction = 'in' AND body <> '' ORDER BY created_at DESC LIMIT 3) x`, [convId])).rows[0]?.t as string | null);
  const byText = await officerUserFor(db, text).catch(() => null);
  if (byText) return { userId: byText.userId, via: 'text', topic: byText.topic };

  const tags = (await db.query(`SELECT t.name FROM conversation_tags x JOIN tags t ON t.id = x.tag_id WHERE x.conversation_id = $1 ORDER BY t.name`, [convId])).rows as { name: string }[];
  for (const { name } of tags) {
    const o = (await officersForTopic(db, name).catch(() => [])).find((x) => x.userId && x.userActive);
    if (o) return { userId: o.userId!, via: 'tag', topic: name };
  }

  const place = (await db.query(
    `SELECT c.flow_state->'vars'->>'where' AS w, c.flow_state->'vars'->>'building' AS b, ct.profile->>'building' AS pb
       FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = $1`, [convId])).rows[0] as { w: string | null; b: string | null; pb: string | null } | undefined;
  for (const p of [place?.w, place?.b, place?.pb]) {
    const hit = p ? await resolveArea(db, p).catch(() => null) : null;
    if (hit) return { userId: hit, via: 'area' };
  }

  const def = await activeUser(db, opts.defaultUserId);
  if (def) return { userId: def, via: 'default' };
  const backup = await activeUser(db, opts.backupUserId);
  if (backup) return { userId: backup, via: 'backup' };

  const any = (await db.query(
    `SELECT u.id FROM officers o JOIN users u ON u.id = o.user_id
      WHERE o.active AND u.active
      ORDER BY (SELECT count(*) FROM conversations c WHERE c.assigned_to = u.id AND c.status = 'open') ASC, o.sort, o.created_at LIMIT 1`)).rows[0]?.id as string | undefined;
  return any ? { userId: any, via: 'officer' } : null;
}

/** Give the conversation to its responsible officer when nobody holds it. Returns who got it (null: nobody, or someone held it already). */
export async function assignResponsible(db: Db, convId: string, opts: Parameters<typeof findResponsible>[2] = {}): Promise<Responsible | null> {
  const r = await findResponsible(db, convId, opts);
  if (!r) return null;
  const u = await db.query(`UPDATE conversations SET assigned_to = $2, assigned_at = now() WHERE id = $1 AND assigned_to IS NULL RETURNING id`, [convId, r.userId]).catch(() => ({ rowCount: 0 }));
  if (!u.rowCount) return null;
  const name = ((await db.query(`SELECT COALESCE(name_he, name) AS n FROM users WHERE id = $1`, [r.userId])).rows[0]?.n as string | undefined) ?? 'הממונה';
  await db.query(`INSERT INTO conversation_notes (conversation_id, body) VALUES ($1, $2)`, [convId, responsibleNote(r, name)]).catch(() => undefined);
  await db.query(`UPDATE users SET last_assigned_at = now() WHERE id = $1`, [r.userId]).catch(() => undefined);
  return r;
}

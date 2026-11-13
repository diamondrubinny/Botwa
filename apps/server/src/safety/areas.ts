import type { Db } from '../db.js';
import { normalizeWord } from '../kb/text.js';

const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[׳'"״"]/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(normalizeWord).join(' ');

/**
 * The officer responsible for a place the customer named: the first area (by order) with a keyword contained in the text
 * as whole words ("בניין 12" matches "בניין 12 קומה 3" but "12" does not match "112").
 */
export async function resolveArea(db: Db, text: string): Promise<string | null> {
  const t = ` ${norm(text)} `;
  if (t.trim() === '') return null;
  const { rows } = await db.query(`SELECT a.user_id, a.keywords FROM responsibility_areas a JOIN users u ON u.id = a.user_id AND u.active ORDER BY a.sort, a.created_at`);
  for (const r of rows) {
    for (const k of r.keywords as string[]) {
      const n = norm(k);
      if (n && t.includes(` ${n} `)) return r.user_id as string;
    }
  }
  return null;
}

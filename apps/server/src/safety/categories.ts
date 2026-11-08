import type { Db } from '../db.js';
import { queryTokens, variants } from '../kb/text.js';

/** The SafetyBoard topics and the words that put a provision or an answer into them. Editable in the panel; these are the starting values. */
export const DEFAULT_BOARD: { name: string; keywords: string[] }[] = [
  { name: 'גזים דחוסים', keywords: ['גזים דחוסים', 'גז דחוס', 'בלוני גז', 'בלון גז', 'מכל גז', 'מכלי גז'] },
  { name: 'גפ״ם', keywords: ['גפם', 'גפ״ם', 'גז פחממני', 'גז בישול'] },
  { name: 'סולמות', keywords: ['סולם', 'סולמות'] },
  { name: 'מעקות', keywords: ['מעקה', 'מעקות'] },
  { name: 'עבודה בגובה', keywords: ['עבודה בגובה', 'עבודות בגובה', 'נפילה מגובה', 'רתמת בטיחות', 'גג', 'גגות'] },
  { name: 'פיגומים', keywords: ['פיגום', 'פיגומים'] },
  { name: 'חפירה', keywords: ['חפירה', 'חפירות', 'דיפון', 'תעלה'] },
  { name: 'כימיקלים המחייבים ניטור', keywords: ['ניטור', 'חשיפה לחומרים', 'חומרים מסוכנים', 'חומר מסוכן', 'גיהות', 'חומרים כימיים', 'חומר כימי'] },
  { name: 'כלי לחץ / דוודים', keywords: ['כלי לחץ', 'דוד', 'דוודים', 'מכל לחץ', 'מיכל לחץ', 'מדחס', 'קומפרסור'] },
  { name: 'גילוי אש', keywords: ['גילוי אש', 'גלאי עשן', 'מערכת גילוי', 'גילוי דליקה'] },
  { name: 'מתזים', keywords: ['מתזים', 'מתז', 'ספרינקלרים', 'כיבוי אוטומטי', 'כיבוי אש'] },
  { name: 'לייזרים', keywords: ['לייזר', 'לייזרים'] },
  { name: 'קרינה מייננת', keywords: ['קרינה מייננת', 'קרינה', 'רנטגן', 'רדיואקטיבי', 'איזוטופ', 'איזוטופים'] },
  { name: 'אביזרי הרמה', keywords: ['אביזרי הרמה', 'אביזר הרמה', 'הרמה', 'עגורן', 'מנוף', 'מלגזה', 'סל הרמה'] },
  { name: 'מעליות/מעלונים', keywords: ['מעלית', 'מעליות', 'מעלון', 'מעלונים'] },
  { name: 'חלל מוקף', keywords: ['חלל מוקף', 'חללים מוקפים', 'מקום מוקף', 'כניסה לחלל'] },
  { name: 'מעבדות', keywords: ['מעבדה', 'מעבדות'] },
  { name: 'מיגון מכונות', keywords: ['מיגון', 'מיגון מכונות', 'מכונה', 'מכונות', 'מגן מכונה'] },
  { name: 'הדרכות', keywords: ['הדרכה', 'הדרכות', 'הכשרה', 'הכשרות', 'תדריך'] },
  { name: 'רעש מזיק', keywords: ['רעש', 'רעש מזיק', 'בדיקת שמיעה', 'מגן שמיעה'] },
  { name: 'תאורה', keywords: ['תאורה', 'תאורת חירום', 'עוצמת הארה', 'הארה'] },
];

export interface BoardCategory { id: string; name: string; keywords: string[]; sort: number }

/** Creates the board categories that do not exist yet (by name). Existing ones keep their edited keywords. */
export async function ensureBoardCategories(db: Db): Promise<void> {
  let sort = 0;
  for (const c of DEFAULT_BOARD) {
    sort++;
    await db.query(
      `INSERT INTO kb_categories (name, keywords, board, sort) VALUES ($1,$2,true,$3)
       ON CONFLICT (name) DO UPDATE SET board = true, sort = CASE WHEN kb_categories.board THEN kb_categories.sort ELSE EXCLUDED.sort END,
                                        keywords = CASE WHEN cardinality(kb_categories.keywords) = 0 THEN EXCLUDED.keywords ELSE kb_categories.keywords END`,
      [c.name, c.keywords, sort],
    );
  }
}

export async function boardCategories(db: Db): Promise<BoardCategory[]> {
  return (await db.query('SELECT id, name, keywords, sort FROM kb_categories WHERE board ORDER BY sort, name')).rows as BoardCategory[];
}

/** All the words of a keyword phrase (with Hebrew prefix variants) must appear in the text. Short generic hits are ignored by the caller's cap. */
export function matchesKeyword(textWords: Set<string>, phrase: string): boolean {
  const toks = queryTokens(phrase);
  return toks.length > 0 && toks.every((t) => variants(t).some((v) => textWords.has(v)));
}

export function matchCategories(text: string, cats: BoardCategory[], max = 3): string[] {
  const have = new Set(queryTokens(text).flatMap((w) => variants(w)));
  const scored = cats
    .map((c) => ({ id: c.id, hits: c.keywords.filter((k) => matchesKeyword(have, k)).length }))
    .filter((c) => c.hits > 0)
    .sort((a, b) => b.hits - a.hits);
  return scored.slice(0, max).map((c) => c.id);
}

/** Replace the board categories of a source by those its text matches. */
export async function assignCategories(db: Db, sourceId: string, text: string, cats: BoardCategory[]): Promise<number> {
  const ids = matchCategories(text, cats);
  await db.query('DELETE FROM kb_source_cats WHERE source_id = $1', [sourceId]);
  for (const id of ids) await db.query('INSERT INTO kb_source_cats (source_id, category_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [sourceId, id]);
  return ids.length;
}

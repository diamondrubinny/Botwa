import type { Db } from '../../db.js';
import type { KnowledgeBase } from '../service.js';

/**
 * A directory of the Israel Institute for Occupational Safety and Hygiene (המוסד לבטיחות ולגיהות, osh.org.il): one entry per
 * topic page, written by us (a sentence and the link), so the bot can point to the Institute's material. Its texts are NOT
 * copied: the site's terms forbid copying or republishing without the Institute's prior written consent (checked 2026-11-14,
 * /heb/About/AboutSite/). Every page address and title below was checked on that date.
 */
export const IOSH_ORIGIN = 'gov:iosh';
export const IOSH_CATEGORY = 'המוסד לבטיחות ולגיהות (קישורים)';
export const IOSH_VERSION = 1;
const BASE = 'https://www.osh.org.il/heb/';

const TOPICS: { key: string; topic: string; path: string; words: string[] }[] = [
  { key: 'noise', topic: 'רעש במקומות עבודה', path: 'Prof/noise/article,385/', words: ['רעש', 'רעש מזיק', 'שמיעה', 'אטמי אוזניים', 'מגיני שמיעה'] },
  { key: 'radiation', topic: 'קרינה בלתי מייננת', path: 'Prof/radiation_page/', words: ['קרינה', 'קרינה בלתי מייננת', 'לייזר', 'שדות אלקטרומגנטיים', 'אולטרה סגול'] },
  { key: 'silica', topic: 'סיליקה', path: 'Prof/silica/', words: ['סיליקה', 'אבק', 'אבק מזיק', 'שיש', 'אבן קיסר'] },
  { key: 'ergonomics', topic: 'ארגונומיה וגורמי אנוש', path: 'Prof/ergonomics/', words: ['ארגונומיה', 'יציבה', 'הרמת משאות', 'עמדת עבודה', 'מחשב'] },
  { key: 'electricity', topic: 'חשמל', path: 'Prof/hashmal_n/', words: ['חשמל', 'התחשמלות', 'לוח חשמל', 'עבודות חשמל'] },
  { key: 'bio', topic: 'בטיחות ובריאות ביולוגית', path: 'Prof/bio_page/', words: ['ביולוגי', 'בטיחות ביולוגית', 'Biosafety', 'חומר ביולוגי', 'מעבדה ביולוגית'] },
  { key: 'hazmat-transport', topic: 'שינוע חומרים מסוכנים', path: 'Prof/info_inner_homas/', words: ['חומ"ס', 'חומרים מסוכנים', 'שינוע', 'הובלת חומרים מסוכנים'] },
  { key: 'construction', topic: 'בטיחות וגהות בתחום הבנייה', path: 'Prof/bniya1/', words: ['בנייה', 'פיגומים', 'אתר בנייה', 'עבודה בגובה', 'חפירה'] },
  { key: 'exposure', topic: 'חשיפה תעסוקתית לגורמים מזיקים', path: 'Prof/hasifa_taasukati/', words: ['חשיפה תעסוקתית', 'גורמים מזיקים', 'ניטור', 'כימיקלים', 'גיהות'] },
  { key: 'cis', topic: 'דפי מידע טכניים (CIS) בעברית, ברוסית ובערבית', path: 'Prof/cis/', words: ['דפי מידע', 'CIS', 'גיליון מידע', 'ערבית', 'רוסית'] },
  { key: 'lessons', topic: 'הפקת לקחים מתאונות בעבודה', path: 'Prof/info_inner_ar/', words: ['תאונת עבודה', 'הפקת לקחים', 'תחקיר', 'כמעט ונפגע'] },
  { key: 'disability', topic: 'עובדים עם מוגבלות', path: 'Prof/mador/', words: ['מוגבלות', 'נגישות', 'עובדים עם מוגבלות'] },
  { key: 'emergency', topic: 'עבודה בטוחה ובריאה בעת מלחמה וחירום', path: 'Prof/war/', words: ['חירום', 'מלחמה', 'מרחב מוגן', 'מצב חירום'] },
  { key: 'laws', topic: 'חוקים ותקנות בבטיחות ובגיהות', path: 'info/laws/', words: ['חוקים', 'תקנות', 'חקיקה', 'רגולציה'] },
  { key: 'dictionary', topic: 'מילונים מקצועיים בבטיחות ובגיהות', path: 'info/dictionary/', words: ['מילון', 'מונחים', 'הגדרות'] },
  { key: 'query', topic: 'מענה לשאילתות פרטניות (שאלה מקצועית למוסד)', path: 'queryform/', words: ['שאלה מקצועית', 'שאילתה', 'פנייה למוסד', 'ייעוץ'] },
];

export const ioshEntry = (t: (typeof TOPICS)[number]) => ({
  title: `המוסד לבטיחות ולגיהות: ${t.topic}`,
  variants: [t.topic, ...t.words].slice(0, 12),
  body: `המוסד לבטיחות ולגיהות (המוס״ל) מפרסם מידע מקצועי בנושא ${t.topic}: הסברים, הנחיות ופרסומים. המידע המלא נמצא באתר המוסד: ${BASE}${t.path}`,
  url: `${BASE}${t.path}`,
});

/**
 * Adds the directory once per version (an entry an admin deleted does not come back; an edited one is left alone). Shown to the
 * bot and the staff: it holds only our sentence and a link.
 */
export async function seedIosh(db: Db, kb: Pick<KnowledgeBase, 'indexWritten'>): Promise<number> {
  const done = (await db.query(`SELECT value FROM settings WHERE key = 'iosh_links_version'`)).rows[0]?.value;
  if (typeof done === 'number' && done >= IOSH_VERSION) return 0;
  const cat = (await db.query(`INSERT INTO kb_categories (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [IOSH_CATEGORY])).rows[0].id as string;
  let added = 0;
  for (const t of TOPICS) {
    if ((await db.query(`SELECT 1 FROM kb_sources WHERE origin = $1 AND external_id = $2`, [IOSH_ORIGIN, t.key])).rowCount) continue;
    const e = ioshEntry(t);
    const id = (await db.query(
      `INSERT INTO kb_sources (kind, title, variants, body, url, origin, external_id, meta, audience, category_id)
       VALUES ('faq', $1, $2, $3, $4, $5, $6, $7, 'both', $8) RETURNING id`,
      [e.title, e.variants, e.body, e.url, IOSH_ORIGIN, t.key, JSON.stringify({ source: 'osh.org.il', copied: false }), cat])).rows[0].id as string;
    await kb.indexWritten(id).catch(() => undefined);
    added++;
  }
  await db.query(`INSERT INTO settings (key, value) VALUES ('iosh_links_version', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(IOSH_VERSION)]);
  return added;
}

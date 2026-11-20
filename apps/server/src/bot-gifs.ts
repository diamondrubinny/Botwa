import type { Db } from './db.js';

/** Moments at which the bot may add a GIF, by the nature of the conversation. */
export type GifMoment = 'greeting' | 'thanks' | 'handoff' | 'close';

/**
 * Words in a gallery GIF's title or keywords that suit each moment, best first. The built-in GIFs carry these words; an admin
 * makes another GIF eligible by adding one of them to its keywords, and keeps any GIF away from the bot with "לא לבוט".
 */
export const MOMENT_WORDS: Record<GifMoment, string[]> = {
  greeting: ['ברוכים הבאים', 'נפנוף', 'welcome'],
  thanks: ['שמחנו לעזור', 'בשמחה', 'glad to help'],
  handoff: ['נציג בדרך', 'חוזרים אליך', 'agent coming'],
  close: ['יום נעים', 'שמרו על עצמכם', 'have a nice day', 'take care'],
};
export const NOT_FOR_BOT = 'לא לבוט';

/**
 * A playful GIF is out of place when someone may be hurt or in danger: accidents, injuries, fire, leaks, emergencies, grief.
 * Checked on the customer's recent messages and the conversation's tags.
 */
const SENSITIVE = /(תאונ|נפגע|פגיע|פצוע|פציע|כווי|דליפ|נשפך|שריפ|דלק[הת]|עשן|פיצוץ|חירום|דחוף|מסוכן|סכנ|אמבולנס|מד"א|מד״א|התעלפ|לא נושם|קשיי נשימה|חשמול|התחשמל|נפל|נפיל|דימום|דם |מוות|נפטר|הלוויה|אבל|כאב|accident|injur|fire|emergency|urgent|leak)/i;
export const isSensitive = (text: string) => SENSITIVE.test(` ${text} `);

export interface GifPick { id: string; title: string; gif: Buffer; mp4: Buffer | null }

/** A random gallery GIF that suits the moment (never one marked "לא לבוט"); with needMp4, only GIFs that have their MP4 copy. */
export async function pickGif(db: Db, moment: GifMoment, needMp4 = false, random: () => number = Math.random): Promise<GifPick | null> {
  const words = MOMENT_WORDS[moment];
  const { rows } = await db.query(
    `SELECT id, title FROM gif_gallery
      WHERE EXISTS (SELECT 1 FROM unnest($1::text[]) w WHERE lower(title || ' ' || keywords) LIKE '%' || lower(w) || '%')
        AND position($2 IN keywords) = 0 AND ($3::boolean = false OR mp4 IS NOT NULL)
      ORDER BY created_at LIMIT 50`, [words, NOT_FOR_BOT, needMp4]);
  if (!rows.length) return null;
  const choice = rows[Math.floor(random() * rows.length) % rows.length] as { id: string };
  const g = (await db.query('SELECT id, title, gif, mp4 FROM gif_gallery WHERE id = $1', [choice.id])).rows[0];
  return g ? { id: g.id, title: g.title, gif: g.gif, mp4: g.mp4 } : null;
}

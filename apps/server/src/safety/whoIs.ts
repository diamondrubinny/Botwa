import type { Db } from '../db.js';

/**
 * "מי הממונה על בטיחות אש?", "מה הטלפון של ממונה הגזים?", "למי פונים בנושא לייזרים?": Betty answers from the officers list
 * (Safety > officers and topics): name, office phone and e-mail. Only officers marked as public; their WhatsApp (often a personal
 * mobile) only when allowed for that officer. Asked about contact but no topic recognised: the topics there are officers for.
 */
const ASK = /(ממונה|ממונת|ממוני|אחראי|אחראית|מי מטפל|מי מטפלת|למי (לפנות|פונים|אפשר לפנות)|טלפון|מספר (ה)?טלפון|פרטי (ה)?קשר|איך (משיגים|יוצרים קשר|מגיעים ל)|מייל|אימייל|מי (ה)?ממונה)/;
/** Customer words → words that appear in topic names (so "שריפה" finds "גילוי אש" and "מתזים"). */
const ALIASES: [RegExp, string[]][] = [
  [/^(אש|שריפ|שרפ|דליק|כיבוי|מטפ|ספרינקלר|עשן|כבאות)/, ['אש', 'מתזים', 'כיבוי', 'כבאות']],
  [/^(גז|גזים|גפמ|גפ"ם|גפ״ם|בלון|בלונים|צילינדר|חמצן|חנקן)/, ['גז', 'גפ']],
  [/^(לייזר|לייזרים)/, ['לייזר']],
  [/^(קרינה|רדיו|רנטגן|מייננת)/, ['קרינה']],
  [/^(כימי|כימיקל|חומס|חומ"ס|חומ״ס|מסוכנ|פסולת)/, ['כימ', 'חומ']],
  [/^(חשמל)/, ['חשמל']],
  [/^(גובה|סולם|סולמות|פיגום|פיגומים|גג|מעקה|מעקות)/, ['גובה', 'סולמ', 'פיגומ', 'מעק']],
  [/^(מעלית|מעליות|מעלון)/, ['מעלי', 'מעלו']],
  [/^(ביולוג|ביו|חיידק|נגיפ|bio)/i, ['biosafety', 'ביולוג']],
  [/^(אסבסט)/, ['אסבסט']],
  [/^(רעש)/, ['רעש']],
  [/^(הרמה|עגורן|מנוף|מלגזה)/, ['הרמה', 'עגורנ']],
  [/^(לחץ|דוד|דודים|קיטור)/, ['לחץ', 'דוד']],
  [/^(חפירה|חפירות)/, ['חפיר']],
  [/^(מכונה|מכונות|מיגון)/, ['מכונ', 'מיגון']],
  [/^(הדרכה|הדרכות|קורס)/, ['הדרכ']],
  [/^(גיהות|ניטור)/, ['גיהות', 'ניטור']],
  [/^(חלל|מוקף)/, ['חלל']],
  [/^(מפגע|מפגעים)/, ['מפגע']],
  [/^(תאורה)/, ['תאורה']],
];
const STOP = new Set(['ממונה', 'ממונת', 'ממוני', 'על', 'של', 'מי', 'מה', 'את', 'הטלפון', 'טלפון', 'מספר', 'בנושא', 'נושא', 'בטיחות', 'הבטיחות', 'למי', 'פונים', 'לפנות', 'אחראי', 'אחראית', 'איך', 'אפשר', 'שלו', 'שלה', 'המשרד', 'משרדי', 'המשרדי', 'מייל', 'אימייל', 'פרטי', 'קשר']);
const stem = (w: string) => w.replace(/^[והבלמשכ](?=[א-ת]{3,})/, '').replace(/(ים|ות)$/, '');
const words = (s: string) => s.toLowerCase().replace(/[?!.,:;()"״׳'/\\-]/g, ' ').split(/\s+/).filter(Boolean);

export interface PublicOfficer { name: string; officePhone: string | null; email: string | null; phone: string | null; showWhatsapp: boolean; topics: string[] }

/** The topics a question names, from the topics officers exist for. */
export function topicsIn(text: string, topics: string[]): string[] {
  const q = words(text).filter((w) => !STOP.has(w));
  const qs = new Set(q.map(stem));
  const hints = q.flatMap((w) => ALIASES.filter(([re]) => re.test(w) || re.test(stem(w))).flatMap(([, t]) => t));
  return topics.filter((topic) => {
    const tl = topic.toLowerCase();
    if (hints.some((h) => tl.includes(h))) return true;
    return words(topic).filter((w) => w.length >= 3 && !STOP.has(w)).some((w) => qs.has(stem(w)));
  });
}

export function formatOfficers(found: { topic: string; officers: PublicOfficer[] }[]): string {
  return found.map(({ topic, officers }) => [
    `👷 ${topic}:`,
    ...officers.slice(0, 3).map((o) => {
      const lines = [o.name, o.officePhone && `☎️ טלפון משרדי: ${o.officePhone}`, o.showWhatsapp && o.phone && `💬 ווצאפ: https://wa.me/${o.phone}`, o.email && `✉️ ${o.email}`].filter(Boolean);
      return lines.length > 1 ? lines.join('\n') : `${o.name} (אפשר לכתוב כאן, ונעביר את הפנייה)`;
    }),
  ].join('\n')).join('\n\n');
}

/** Betty's answer to a question about who is responsible for a topic, or null when the message is not such a question. */
export async function officerReply(db: Db, text: string | null | undefined): Promise<string | null> {
  if (!text || text.length > 160 || !ASK.test(text)) return null;
  const rows = (await db.query(
    `SELECT o.name, o.office_phone AS "officePhone", o.email, o.phone, o.show_whatsapp AS "showWhatsapp", array_agg(t.topic ORDER BY t.topic) AS topics
       FROM officers o JOIN officer_topics t ON t.officer_id = o.id WHERE o.active AND o.public GROUP BY o.id ORDER BY o.sort, o.created_at`)).rows as PublicOfficer[];
  if (!rows.length) return null;
  const all = [...new Set(rows.flatMap((r) => r.topics))];
  const hit = topicsIn(text, all).slice(0, 3);
  if (!hit.length) {
    // asked about a person in charge, no topic recognised: only when it is clearly about officers
    if (!/(ממונה|ממונת|ממוני|אחראי|אחראית)/.test(text)) return null;
    return `על איזה נושא? יש לנו ממונים בנושאים: ${all.slice(0, 25).join(', ')}.\nכתבו למשל: "מי הממונה על ${all[0]}?"`;
  }
  return formatOfficers(hit.map((topic) => ({ topic, officers: rows.filter((r) => r.topics.includes(topic)) })));
}

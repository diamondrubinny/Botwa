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
  [/^(לייזר|ליזר)/, ['לייזר', 'ליזר']],
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
/** Hebrew spelled with or without extra letters ("ליזר" / "לייזר", "כימיקלים" / "כימיקאלים"): doubled yod and vav count once. */
const plain = (s: string) => s.replace(/יי/g, 'י').replace(/וו/g, 'ו');
const stem = (w: string) => plain(w).replace(/^[והבלמשכ](?=[א-ת]{3,})/, '').replace(/(ים|ות)$/, '');
const words = (s: string) => plain(s.toLowerCase()).replace(/[?!.,:;()"״׳'/\\-]/g, ' ').split(/\s+/).filter(Boolean);

/** One letter added, missing, changed or swapped. */
function near(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1 || a === b) return a === b;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
  }
  return d[a.length]![b.length]! <= 1;
}
/** Real words one letter away from "ממונה" that mean something else ("from her", "a meter", "counts"). */
const NOT_OFFICER = new Set(['ממנה', 'מונה', 'מנה', 'ממונן', 'שמונה', 'תמונה', 'אמונה', 'ממומן', 'ממונע']);
/** Typos of "ממונה" ("מומנה", "ממונא", "מימונה") read as "ממונה", so the question is still recognised. */
export function fixOfficerTypos(text: string): string {
  return text.replace(/[א-ת"״]+/g, (w) => {
    const m = /^([והלש]?)(.+)$/.exec(w)!;
    for (const core of [w, m[2]!]) {
      if (core.length < 4 || core.length > 6 || NOT_OFFICER.has(core) || NOT_OFFICER.has(w)) continue;
      if (near(core, 'ממונה') || near(core, 'ממונת') || near(core, 'ממוני')) return `${core === w ? '' : m[1]}ממונה`;
    }
    return w;
  });
}

export interface PublicOfficer { name: string; officePhone: string | null; email: string | null; phone: string | null; showWhatsapp: boolean; topics: string[] }

/** The topics a question names, from the topics officers exist for. */
export function topicsIn(text: string, topics: string[]): string[] {
  const q = words(text).filter((w) => !STOP.has(w));
  const qs = new Set(q.map(stem));
  const hints = q.flatMap((w) => ALIASES.filter(([re]) => re.test(w) || re.test(stem(w))).flatMap(([, t]) => t));
  return topics.filter((topic) => {
    const tl = plain(topic.toLowerCase());
    if (hints.some((h) => tl.includes(plain(h)))) return true;
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
  if (!text || text.length > 160) return null;
  text = fixOfficerTypos(text);
  if (!ASK.test(text)) return null;
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

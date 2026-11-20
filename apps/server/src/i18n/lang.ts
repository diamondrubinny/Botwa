/**
 * The language a customer writes in: Hebrew, English or Arabic, by counting letters (addresses, e-mails, numbers and emoji do not
 * count). A message with too few letters to tell (a number, "ok", an emoji, one Arabic word inside Hebrew) does not change the
 * conversation's language.
 */
export type Lang = 'he' | 'en' | 'ar' | 'ru';
export const LANGS: readonly Lang[] = ['he', 'en', 'ar', 'ru'];
export const asLang = (v: unknown): Lang => (v === 'en' || v === 'ar' || v === 'ru' ? v : 'he');

export function detectLang(text: string | null | undefined): Lang | null {
  if (!text) return null;
  const t = text.replace(/https?:\/\/\S+|www\.\S+|\S+@\S+\.\S+/gi, ' ');
  const he = (t.match(/[א-ת]/g) ?? []).length;
  const en = (t.match(/[A-Za-z]/g) ?? []).length;
  const ar = (t.match(/[\u0621-\u063A\u0641-\u064A\u0671-\u06D3\u06FA-\u06FF]/g) ?? []).length;
  // Arabic: more Arabic letters than Hebrew ones, and at least a short word ("شكرا", "مرحبا"), not one letter inside Hebrew
  if (ar >= 3 && ar > he && ar >= en / 2) return 'ar';
  // Russian: Cyrillic letters, at least a short word ("привет", "спасибо"), more than Hebrew ones
  const ru = (t.match(/[\u0400-\u04FF]/g) ?? []).length;
  if (ru >= 3 && ru > he && ru >= en / 2) return 'ru';
  if (he >= 2 && he >= en / 2) return 'he';
  // English: real words (not a lone "ok"/"hi" mixed into Hebrew, not a code like "BOTWA-1234")
  if (en >= 3 && he === 0 && ar === 0 && ru === 0 && /[a-z]{2,}/i.test(t) && !/^\s*botwa[-\s]?\d+\s*$/i.test(t)) return 'en';
  if (en >= 12 && en > he * 4) return 'en';
  return null;
}

/** Which way a text reads: by the majority of its letters (not by its first character, which may be an emoji, a number or a name). */
export function textDir(text: string): 'rtl' | 'ltr' {
  const he = (text.match(/[֐-׿؀-ۿ]/g) ?? []).length;
  const en = (text.match(/[A-Za-z]/g) ?? []).length;
  return he > 0 && he * 3 >= en ? 'rtl' : 'ltr';
}

const RLM = '‏', LRM = '‎';
/** The first character with a direction in a line: 'rtl', 'ltr', or null (digits, punctuation, emoji only). */
function firstStrong(line: string): 'rtl' | 'ltr' | null {
  for (const ch of line) {
    if (/[֐-׿؀-ۿ]/.test(ch)) return 'rtl';
    if (/[A-Za-zÀ-ɏ\u0400-\u04FF]/.test(ch)) return 'ltr';
  }
  return null;
}

/**
 * Invisible direction marks for apps that align each message (or line) by its first letter (WhatsApp, Telegram, SMS): in a
 * Hebrew message, a line that starts with an English word, a link, a number or an emoji gets a right-to-left mark so it stays on
 * the right; in an English message, the same with left-to-right. Only lines that need it; the stored message is unchanged.
 */
export function withDirectionMarks(text: string): string {
  if (!text) return text;
  const dir = textDir(text);
  const mark = dir === 'rtl' ? RLM : LRM;
  return text.split('\n').map((line) => {
    if (!line.trim() || line.startsWith(RLM) || line.startsWith(LRM)) return line;
    return firstStrong(line) === dir ? line : mark + line;
  }).join('\n');
}

/** Arabic as it is typed in practice: without diacritics and tatweel, one alef, ي for ى, ه for ة (for matching only). */
export const arNorm = (s: string) => s.replace(/[\u064B-\u0652\u0670\u0640]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/\s+/g, ' ').trim();

/** Russian as typed in practice: lower case, ё as е (for matching only). */
export const ruNorm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

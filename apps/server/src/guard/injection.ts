/**
 * Prompt-injection and misuse guard for the bot. Betty is mostly deterministic (flow, menu, quoted knowledge-base passages), so the
 * one place a crafted message could steer her is the optional local model that words answers. This module:
 *  - spots messages that try to override the bot's rules, reveal its instructions or make it play another role;
 *  - cleans untrusted text (the customer's question, crawled passages) before a model sees it;
 *  - checks what a model wrote before a customer sees it.
 * Pattern matching cannot catch every phrasing: it is one layer. The model has no tools and only sees knowledge-base passages.
 */

const ZERO_WIDTH = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
/** chat-template and role markers that models treat as structure */
const ROLE_MARKERS = /<\|[^|>]{0,40}\|>|\[\/?(INST|SYS|SYSTEM)\]|<<\/?SYS>>|<\/?(system|assistant|user|instructions?|prompt|knowledge|customer_question)>|^\s*#{2,}\s*(system|instruction|instructions|prompt|הוראות|הנחיות)\b.*$|^\s*(system|assistant|developer)\s*:/gim;

const VERB_HE = '(?:^|\\s)(?:ל|ו)?(?:תתעלמ|התעלמ|תתעלם|התעלם|תשכח|שכח|תבטל|בטל|תעקפ|עקפ|תעקוף|עקוף)\\S*\\s+(?:מ|על\\s+|את\\s+)?';
const TARGET_HE = '(?:ה)?(?:הוראות|הנחיות|כללים|חוקים|פרומפט|הגבלות|מגבלות)';
const QUAL_HE = '\\s+(?:הקודמות|הקודמים|הקודם|שלך|שקיבלת|שנתנו\\s+לך|המקוריות|המקוריים|של\\s+המערכת|שלמעלה)';
const HE = [
  // "ignore / forget / bypass ALL the instructions", "...the previous instructions / your rules"
  new RegExp(`${VERB_HE}כל\\s+${TARGET_HE}`),
  new RegExp(`${VERB_HE}${TARGET_HE}${QUAL_HE}`),
  // "your system instructions", "show me your instructions / prompt"
  /(הנחיות|הוראות)\s+(ה)?מערכת\s+(שלך|שקיבלת)|פרומפט\s+(ה)?מערכת|(ה)?פרומפט\s+(שלך|שקיבלת)|(מה|תראי|תראה|הראי|הראה|תציגי|תציג|הציגי|חשפי|תחשפי|תגלי|גלי|תכתבי|כתבי|תעתיקי|העתיקי)\s+(לי\s+)?(את\s+)?(ה)?(הוראות|הנחיות|כללים)\s+(שלך|שקיבלת)/,
  // "from now on you are… / pretend to be… / act like… / developer mode / answer without restrictions"
  /מעכשיו\s+(את|אתה|תהיי|תהיה)\s+(לא\s+)?(בוט|עוזר|עוזרת|מודל|מערכת|חופשי|חופשייה|בלי\s+הגבלות|ללא\s+הגבלות)|(תעמידי|תעמיד|העמידי|העמד)\s+פנים|(תתנהגי|תתנהג)\s+כמו\s+(בוט|מודל|עוזר|עוזרת|מישהו|מישהי|האקר|אדם)|(תשחקי|תשחק)\s+(את\s+)?(ה)?תפקיד|מצב\s+(מפתח|מפתחים|ללא\s+הגבלות|בלי\s+הגבלות)|(תעני|ענה|תענה|עני|דברי|תדברי)\s+(בלי|ללא)\s+(שום\s+)?(הגבלות|מגבלות|צנזורה|סינון)/,
];
const EN = [
  /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,25}\b(previous|prior|above|earlier|preceding|initial|your|system|all (of )?(your|the) (previous|prior))\b[^.\n]{0,20}\b(instructions?|prompts?|rules|guidelines|directives|constraints)\b/i,
  /\b(system|initial|hidden|original|developer)\s+(prompt|instructions?)\b/i,
  /\b(reveal|show|print|repeat|output|tell me|what are|leak|dump)\b[^.\n]{0,25}\byour\s+(instructions?|prompt|rules|guidelines|configuration)\b/i,
  /\b(you are now|from now on,? you are|act as (an? )?(unrestricted|uncensored|different|evil|dan)\b|pretend (to be|you are)|roleplay as|developer mode|jailbreak|dan mode|do anything now|answer without (any )?(restrictions|filters|limits))/i,
];

/** True when the message tries to override the bot's rules, reveal its instructions or switch its role. */
export function detectInjection(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.replace(ZERO_WIDTH, '').replace(/\s+/g, ' ').trim();
  if (t.length < 6) return false;
  if (new RegExp(ROLE_MARKERS.source, 'im').test(text)) return true;
  return HE.some((r) => r.test(t)) || EN.some((r) => r.test(t));
}

/** Untrusted text for a model: no invisible/direction characters, no role markers, no runs of whitespace, capped. */
export function sanitizeUntrusted(text: string, max = 1500): string {
  return text.replace(ZERO_WIDTH, '').replace(ROLE_MARKERS, ' ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

/** phrases of the model's own rules: a reply that quotes them leaks the instructions */
const LEAK = /NO_ANSWER|כללים מחייבים|הוראות שמופיעות בתוך|<\/?(customer_question|knowledge)>|system prompt|my instructions|ההנחיות שלי|ההוראות שלי|as an ai|as a language model|i am an ai|מודל שפה|בינה מלאכותית/i;

/**
 * Is what the model wrote safe to send? No quoting of its instructions, no claims of being a model, no code or markup, and no e-mail
 * address that is not in the passages. (Numbers and links are checked by onlyKnownFacts.)
 */
export function safeModelOutput(answer: string, passages: string): boolean {
  if (LEAK.test(answer)) return false;
  if (/```|<\s*\/?\s*(script|iframe|img|a|style|svg)\b|javascript:|data:text/i.test(answer)) return false;
  const emails = answer.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? [];
  return emails.every((e) => passages.includes(e));
}

/** The bot's reply to an attempt: polite, fixed, never repeating what was written. */
export const INJECTION_REPLY = 'אני עונה רק על שאלות בנושאי הבטיחות של היחידה, לפי המידע שלה 🙂 במה אפשר לעזור? לתפריט כתבו "תפריט", ולנציג "נציג".';
export const INJECTION_NOTE = 'הבוט זיהה בשיחה ניסיון לעקוף את ההנחיות שלו (הנדסת פרומפט) וענה בתשובה קבועה. תוכן ההודעה לא נשלח למודל.';
/** attempts in one conversation before it goes to a person */
export const INJECTION_HANDOFF_AFTER = 3;
/** the most of one message the bot reads (the message itself is stored whole for the team) */
export const BOT_INPUT_MAX = 2000;

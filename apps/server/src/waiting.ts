/**
 * "מתי חוזרים אליי?", "מה קורה עם הפנייה שלי?", "מישהו שם?": a customer whose inquiry is already with the team asks how it is
 * going. Short messages only, so a new question that merely contains such words is left to the normal handling.
 */
const ASKS = /(מתי (חוזרים|תחזרו|יחזרו|תחזור|תחזרי|יחזור|יטפלו|תטפלו|מטפלים|יענו|תענו|עונים)|מה (קורה|קרה|המצב|עם) (עם |ב)?(ה)?פני(י)?ה|מה עם הפנייה|יש (עדכון|חדש|תשובה)|מישהו (שם|עונה|רואה|יענה|מטפל)|אף אחד (לא )?(עונה|מטפל|חוזר)|עדיין (מחכה|מחכים|ממתין|ממתינה)|כמה זמן (לחכות|עוד|זה לוקח)|למה (לא )?(עונים|חוזרים)|הלו+|שלום\?+$|^(את|אתה|מישהו) (כאן|פה|שם)\??$)/;
/** The same questions in English. */
const ASKS_EN = /(when will (you|someone|somebody|anyone) (get back|reply|answer|respond|call)|any (update|news)|(is )?(any ?one|any ?body|someone) (there|answering|here)|still waiting|how (much )?long (will|do i|should|until)|why (is )?(no ?one|nobody|isn'?t anyone) (answering|replying|getting back)|what('?s| is) (happening|going on) with my (request|ticket|inquiry))/i;
export function isWaitingQuestion(text: string | null | undefined): boolean {
  if (!text) return false;
  if (/^\s*[?？]+\s*$/.test(text)) return true;                  // a lone "?" while waiting: "is anyone there?"
  const t = text.trim().toLowerCase().replace(/[!.,״"׳:;()‎‏]/g, ' ').replace(/\s+/g, ' ').replace(/אליי/g, 'אלי');
  return t.length <= 80 && t.split(' ').length <= 10 && (ASKS.test(t) || ASKS_EN.test(t));
}

/**
 * "מה עם הדיווח שלי מאתמול?", "האם המפגע טופל?", "what happened with my report?": about an earlier inquiry, also one already closed.
 */
const PAST = /(מה (קורה|קרה|המצב|נשמע|עם) (עם |ב)?(ה)?(דיווח|פני(י)?ה|קריאה|מפגע|תלונה)|מה עם (ה)?(דיווח|מפגע|תלונה|קריאה)|האם (זה |המפגע |הדיווח |הפנייה |הבעיה )?טופל(ה)?|(המפגע|הדיווח|הפנייה|הבעיה) טופל(ה)?\?|(טופל|טופלה)\?|סטטוס (של )?(ה)?(דיווח|פנייה|קריאה))/;
const PAST_EN = /(status of my (report|request|ticket|complaint)|what happened (with|to) my (report|request|ticket|complaint)|(was|has) (it|my report|the hazard|my request) (been )?(handled|fixed|dealt with|resolved)\??)/i;
export function isPastReportQuestion(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim().toLowerCase().replace(/[!.,״"׳:;()‎‏]/g, ' ').replace(/\s+/g, ' ');
  return t.length <= 100 && t.split(' ').length <= 14 && (PAST.test(t) || PAST_EN.test(t));
}

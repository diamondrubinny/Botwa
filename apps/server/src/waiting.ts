/**
 * "מתי חוזרים אליי?", "מה קורה עם הפנייה שלי?", "מישהו שם?": a customer whose inquiry is already with the team asks how it is
 * going. Short messages only, so a new question that merely contains such words is left to the normal handling.
 */
const ASKS = /(מתי (חוזרים|תחזרו|יחזרו|תחזור|תחזרי|יחזור|יטפלו|תטפלו|מטפלים|יענו|תענו|עונים)|מה (קורה|קרה|המצב|עם) (עם |ב)?(ה)?פני(י)?ה|מה עם הפנייה|יש (עדכון|חדש|תשובה)|מישהו (שם|עונה|רואה|יענה|מטפל)|אף אחד (לא )?(עונה|מטפל|חוזר)|עדיין (מחכה|מחכים|ממתין|ממתינה)|כמה זמן (לחכות|עוד|זה לוקח)|למה (לא )?(עונים|חוזרים)|הלו+|שלום\?+$)/;
export function isWaitingQuestion(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim().toLowerCase().replace(/[!.,״"׳:;()‎‏]/g, ' ').replace(/\s+/g, ' ').replace(/אליי/g, 'אלי');
  return t.length <= 80 && t.split(' ').length <= 10 && ASKS.test(t);
}

import { describe, expect, it } from 'vitest';
import { isWaitingQuestion } from '../src/waiting.js';

describe('"when will you get back to me?"', () => {
  it('recognises a waiting customer asking how it is going', () => {
    for (const t of ['מתי חוזרים אלי ?', 'מתי חוזרים אליי', 'מתי תחזרו אליי?', 'מה קורה עם הפנייה שלי?', 'מה עם הפנייה', 'יש עדכון?', 'מישהו שם?', 'אף אחד לא עונה', 'עדיין מחכה', 'כמה זמן לחכות?', 'הלוווו']) expect(isWaitingQuestion(t), t).toBe(true);
  });
  it('leaves other messages to the normal handling', () => {
    for (const t of ['שלום', 'תודה', 'יש שריפה', 'מתי הקורס הבא בנושא עבודה בגובה ואיפה נרשמים אליו בדיוק?', 'אני צריך טופס פינוי', '']) expect(isWaitingQuestion(t), t).toBe(false);
  });
});

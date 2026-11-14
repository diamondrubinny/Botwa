import { describe, expect, it } from 'vitest';
import { isEmergency } from '../src/emergency.js';

describe('an emergency in a message', () => {
  it('danger, injury, fire, smoke, leaks, shock, explosion', () => {
    for (const t of ['מצב חירום', 'הצילו!', 'יש שריפה בבניין 3', 'יש עשן במעבדה', 'דליפת גז במסדרון', 'מריח גז בחדר 214', 'עובד התחשמל', 'מישהו התעלף',
      'יש פצוע במעבדה', 'הוא לא נושם', 'צריך אמבולנס', 'נשפך חומר מסוכן על הרצפה', 'פיצוץ במעבדה', 'אני תקועה במעלית', 'SOS', 'נכווה מחומצה']) expect(isEmergency(t), t).toBe(true);
  });
  it('questions about procedures, equipment and past events are not an emergency', () => {
    for (const t of ['איפה נמצאות יציאות החירום?', 'מתי תרגיל הפינוי?', 'צריך להחליף גלאי עשן', 'מה נוהל חירום במעבדה?', 'דיווח תאונה', 'זה דחוף, צריך את הטופס היום',
      'נפלתי לפני שבוע וכואב לי הקרסול', 'קיבלתי שובר', 'שלום', '']) expect(isEmergency(t), t).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { factReply, isFactRequest, SAFETY_FACTS } from '../src/safety/facts.js';

describe('Betty tells a safety fact', () => {
  it('recognises the request, not ordinary questions', () => {
    for (const t of ['תספרי לי עובדת בטיחות מעניינת', 'עובדה מעניינת', 'יש לך טיפ בטיחות?', 'הידעת?', 'ספרי לי משהו מעניין על בטיחות']) expect(isFactRequest(t), t).toBe(true);
    for (const t of ['אני עובדת במעבדה, איזה ציוד בטיחות צריך?', 'עובדה שהמזגן לא עובד', 'ספר לי על נוהל בטיחות במעבדה', 'עוד', 'מספר חדר 305']) expect(isFactRequest(t), t).toBe(false);
  });
  it('a fact not told yet; "עוד" right after a fact gives another; every fact once before any repeats', () => {
    const told: string[] = [];
    let r = factReply('עובדת בטיחות מעניינת', told, false, () => 0)!;
    expect(r.startsWith('💡 הידעת?')).toBe(true);
    told.push(r);
    expect(factReply('עוד', told, false)).toBeNull();                    // "עוד" alone, not after a fact: not this
    for (let i = 1; i < SAFETY_FACTS.length; i++) { r = factReply('עוד', told, true, () => 0)!; expect(told).not.toContain(r); told.push(r); }
    expect(new Set(told).size).toBe(SAFETY_FACTS.length);
    expect(factReply('עוד', told, true, () => 0)).toBeTruthy();           // all told: starts again
  });
});

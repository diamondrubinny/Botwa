import { describe, expect, it } from 'vitest';
import { cleanName, firstName, renderBotText } from '../src/bot-text.js';
import { buildSafetyFlow } from '../src/flow/safetyTemplate.js';
import { flowSchema, validateFlow } from '../src/flow/schema.js';

describe('bot text variables', () => {
  it('names the bot and greets a known customer by first name', () => {
    expect(renderBotText('היי {שם פרטי}, כאן {בוט} 😊', { botName: 'בטי', fullName: 'יוסי כהן' })).toBe('היי יוסי, כאן בטי 😊');
    expect(renderBotText('שלום {שם}', { fullName: 'דנה  לוי' })).toBe('שלום דנה לוי');
  });
  it('leaves no stray punctuation when the customer is not known, and "the bot" without a persona name', () => {
    expect(renderBotText('שלום {שם פרטי}! כאן {בוט}.', {})).toBe('שלום! כאן הבוט.');
    expect(renderBotText('היי {שם פרטי}, טוב לראות אותך', { fullName: '' })).toBe('היי, טוב לראות אותך');
    expect(renderBotText('{שם פרטי}, תודה', {})).toBe('תודה');
  });
  it('keeps unknown braces and texts without variables as written', () => {
    expect(renderBotText('קוד {abc} נשאר', { botName: 'בטי' })).toBe('קוד {abc} נשאר');
    expect(renderBotText('בלי משתנים  כאן', {})).toBe('בלי משתנים  כאן');
    expect(renderBotText('{constructor} {toString}', {})).toBe('{constructor} {toString}');
  });
  it('never calls someone by a phone number, an emoji nickname or a placeholder', () => {
    for (const bad of ['972501234567', '😎😎', 'מבקר באתר #ab12', 'Guest', 'a', '<b>x</b>']) expect(cleanName(bad)).toBe('');
    expect(firstName('‏רונית כהן')).toBe('רונית');
    expect(firstName("ז'ורז' לוי")).toBe("ז'ורז'");
    expect(firstName('Dana Levi')).toBe('Dana');
  });
  it('the safety template greets returning customers and thanks after identification, and stays valid', () => {
    const f = buildSafetyFlow(() => '11111111-1111-4111-8111-111111111111');
    expect(flowSchema.safeParse(f).success).toBe(true);
    expect(validateFlow(f)).toEqual([]);
    const by = new Map(f.nodes.map((n) => [n.id, n] as const));
    expect(by.get('start')).toMatchObject({ yes: 'welcome_back' });
    expect(by.get('welcome_back')).toMatchObject({ next: 'topics' });
    expect(by.get('remember')).toMatchObject({ next: 'id_saved' });
    expect((by.get('id_intro') as { text: string }).text).toMatch(/^שלום, כאן \{בוט\} מיחידת הבטיחות/);
  });
});

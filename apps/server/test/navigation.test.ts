import { describe, expect, it } from 'vitest';
import { decide, DEFAULT_BOT, isBackRequest, isMenuRequest, normalize } from '../src/bot.js';
import { NAV_HINT, runFlow, type FlowContext, type FlowState } from '../src/flow/engine.js';
import { flowSchema } from '../src/flow/schema.js';

const n = (s: string) => normalize(s);
const ctx: FlowContext = { isOpen: true, channelType: 'whatsapp', humanKeywords: ['נציג'], humanOption: true, invalidRetries: 1, invalidMessage: 'לא הבנתי', now: 1_000_000, kbAnswer: async () => null, matchOption: async () => null };

describe('navigation words', () => {
  it('understands the usual ways of asking for the menu or for one step back, and only whole messages', () => {
    for (const s of ['תפריט', 'תחזור לתפריט', 'חזור לתפריט הראשי', 'חזרה לתפריט', 'לתפריט', 'בבקשה תחזור לתפריט', 'תפריט ראשי', 'Menu', 'התחלה', 'להתחיל מחדש']) expect(isMenuRequest(n(s)), s).toBe(true);
    for (const s of ['אחורה', 'תחזור אחורה', 'חזור אחורה!', 'חזרה לשלב הקודם', 'לשאלה הקודמת', 'תחזור לתפריט הקודם', 'back', 'אפשר לחזור אחורה', 'צעד אחורה']) expect(isBackRequest(n(s)), s).toBe(true);
    for (const s of ['מה התפריט במסעדה?', 'הכאב בגב אחורה', 'שלום', '1', 'תפריט בטיחות לעבודה בגובה']) { expect(isMenuRequest(n(s)), s).toBe(false); expect(isBackRequest(n(s)), s).toBe(false); }
  });
});

describe('menu bot', () => {
  it('"back" or "menu" shows the menu again, also while it waits for the place of a topic', () => {
    const bot = { ...DEFAULT_BOT, enabled: true, items: [{ title: 'מפגע', answer: 'נא לפרט', route: { userId: '22222222-2222-4222-8222-222222222222', byArea: true } }] };
    expect(decide(bot, { state: 'area', invalid: 0, item: 0 }, 'תחזור אחורה')).toMatchObject({ menu: true, next: { state: 'menu' } });
    expect(decide(bot, { state: 'menu', invalid: 0 }, 'תחזור לתפריט')).toMatchObject({ menu: true });
  });
});

describe('flow: back and menu', () => {
  const flow = flowSchema.parse({
    start: 'main', nodes: [
      { id: 'main', type: 'menu', text: 'במה נוכל לעזור?', options: [{ label: 'דיווח', next: 'kind' }, { label: 'מידע', next: 'info' }] },
      { id: 'info', type: 'message', text: 'מידע', next: 'main' },
      { id: 'kind', type: 'menu', text: 'סוג הדיווח?', options: [{ label: 'מפגע', next: 'where' }, { label: 'תאונה', next: 'where' }] },
      { id: 'where', type: 'question', text: 'איפה זה קרה?', save: 'place', next: 'what' },
      { id: 'what', type: 'question', text: 'מה קרה?', save: 'text', next: 'end' },
      { id: 'end', type: 'end', text: 'תודה!' },
    ],
  });
  it('a step back asks the previous step again; at the first step it starts over; "menu" goes to the start; a submenu shows the hint', async () => {
    let r = await runFlow(flow, null, 'שלום', ctx);
    expect(r.replies.at(-1)).toContain('במה נוכל לעזור?');
    expect(r.replies.at(-1)).not.toContain(NAV_HINT);                       // the first menu: no hint
    r = await runFlow(flow, r.state, '1', ctx);
    expect(r.replies.at(-1)).toContain('סוג הדיווח?');
    expect(r.replies.at(-1)).toContain(NAV_HINT);                           // a submenu: the hint, above the numbered options
    expect(r.replies.at(-1)!.trim().endsWith('0. נציג אנושי')).toBe(true);  // options stay last (they become buttons)
    r = await runFlow(flow, r.state, '2', ctx);
    expect(r.replies).toEqual(['איפה זה קרה?']);                            // questions stay short
    r = await runFlow(flow, r.state, 'בניין 3', ctx);
    expect(r.replies).toEqual(['מה קרה?']);
    let s: FlowState = r.state;
    r = await runFlow(flow, s, 'תחזור אחורה', ctx);
    expect(r.replies).toEqual(['איפה זה קרה?']);
    r = await runFlow(flow, r.state, 'אחורה', ctx);
    expect(r.replies.at(-1)).toContain('סוג הדיווח?');
    r = await runFlow(flow, r.state, 'אחורה', ctx);
    expect(r.replies.at(-1)).toContain('במה נוכל לעזור?');
    r = await runFlow(flow, r.state, 'אחורה', ctx);                         // nothing before the first step: start over
    expect(r.replies.at(-1)).toContain('במה נוכל לעזור?');
    // a fresh answer after going back continues normally and keeps what was already collected
    r = await runFlow(flow, r.state, '1', ctx);
    r = await runFlow(flow, r.state, '1', ctx);
    r = await runFlow(flow, r.state, 'מעבדה 2', ctx);
    s = r.state;
    expect(s.vars.place).toBe('מעבדה 2');
    r = await runFlow(flow, s, 'תחזור לתפריט', ctx);
    expect(r.replies.at(-1)).toContain('במה נוכל לעזור?');
    expect(r.state.history).toEqual([]);
  });
});

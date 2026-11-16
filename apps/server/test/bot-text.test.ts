import { describe, expect, it } from 'vitest';
import { cleanName, dayPart, farewellReply, firstName, greetingFor, identityReply, isFarewell, renderBotText, smallTalkReply, withoutBotName } from '../src/bot-text.js';
import { isGreeting } from '../src/bot.js';
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
    expect((by.get('id_intro') as { text: string }).text).toMatch(/^\{ברכה\}, כאן \{בוט\} מיחידת הבטיחות/);
  });
});

describe('the bot says who it is when asked', () => {
  const betty = { name: 'בטי', role: 'הבוט של יחידת הבטיחות' };
  it('answers "who are you / are you a bot" by its persona name, honestly a bot, with the way to a person', () => {
    for (const q of ['מי את?', 'בטי, מי את', 'את בוט?', 'את בן אדם?', 'איך קוראים לך', 'אני מדבר עם בוט?', 'זה רובוט?', 'Are you AI? את ai', 'מי זה?']) {
      const r = identityReply(q, betty);
      expect(r, q).toContain('אני בטי, הבוט של יחידת הבטיחות');
      expect(r, q).toContain('נציג');
    }
    expect(identityReply('את בוט?', {})).toContain('אני הבוט של השירות');
  });
  it('leaves real questions to the normal flow', () => {
    for (const q of ['מי זה הממונה על לייזרים?', 'זה אמיתי שהמעבדה סגורה מחר?', 'איפה מוצאים את נוהל העבודה בגובה', 'שלום', 'את יכולה לעזור לי עם טופס פינוי פסולת כימית מהמעבדה בבניין 12?', '']) expect(identityReply(q, betty), q).toBeNull();
  });
});

describe('the bot\'s own name and small talk', () => {
  it('takes the bot\'s name out of the message, whole words only', () => {
    expect(withoutBotName('היי בטי', 'בטי')).toBe('היי');
    expect(withoutBotName('בטי, מה זה חומ"ס?', 'בטי')).toBe('מה זה חומ"ס?');
    expect(withoutBotName('תודה בטי!', 'בטי')).toBe('תודה !');
    expect(withoutBotName('שאלה על בטיחות במעבדה', 'בטי')).toBe('שאלה על בטיחות במעבדה');
    expect(withoutBotName('בטי', 'בטי')).toBe('בטי');            // only the name: kept as written
    expect(withoutBotName('היי בטי', '')).toBe('היי בטי');
    expect(isGreeting(withoutBotName('היי בטי', 'בטי'))).toBe(true);
  });
  it('answers small talk kindly; leaves real questions alone', () => {
    for (const q of ['מה שלומך', 'מה שלומך?', 'היי, מה נשמע?', 'מה קורה איתך', 'איך את?', 'מה העניינים 😊']) expect(smallTalkReply(q), q).toContain('הכול טוב אצלי');
    for (const q of ['מה שלומך עם הטופס ששלחתי?', 'מה קורה עם הפנייה שלי?', 'איך אני מזמין הדרכה', 'שלום']) expect(smallTalkReply(q), q).toBeNull();
  });
});

describe('greeting by the hour', () => {
  // Israel in November is UTC+2
  const at = (h: number) => new Date(Date.UTC(2026, 10, 16, (h - 2 + 24) % 24, 30));
  it('morning, noon, evening and night at the business time zone', () => {
    expect([6, 11, 12, 16, 17, 21, 22, 2, 4, 5].map((h) => dayPart(at(h), 'Asia/Jerusalem'))).toEqual(['morning', 'morning', 'noon', 'noon', 'evening', 'evening', 'night', 'night', 'night', 'morning']);
    expect(dayPart(at(9), 'No/Such_Zone')).toMatch(/morning|noon|evening|night/);   // a bad zone never throws
    expect(['morning', 'noon', 'evening', 'night'].map((p) => greetingFor(p as never))).toEqual(['בוקר טוב', 'צהריים טובים', 'ערב טוב', 'לילה טוב']);
    expect(greetingFor('evening', 'en')).toBe('Good evening');
  });
  it('{ברכה} is filled with the greeting of the hour, "שלום" when unknown', () => {
    expect(renderBotText('{ברכה} {שם פרטי}, טוב לראות אותך שוב!', { fullName: 'דיימונד רוביני', greeting: 'ערב טוב' })).toBe('ערב טוב דיימונד, טוב לראות אותך שוב!');
    expect(renderBotText('{ברכה} {שם פרטי}! כאן {בוט}.', { botName: 'בטי', greeting: 'בוקר טוב' })).toBe('בוקר טוב! כאן בטי.');
    expect(renderBotText('{ברכה}, כאן {בוט}', {})).toBe('שלום, כאן הבוט');
  });
  it('a goodbye ("לילה טוב", "תודה ויום טוב", "good night") is recognized and answered for the hour; a request is not a goodbye', () => {
    for (const t of ['לילה טוב', 'לילה טוב!', 'תודה ולילה טוב', 'תודה רבה, יום טוב', 'יום טוב לך', 'המשך יום נעים', 'שבת שלום', 'Good night', 'have a nice day', 'ערב נעים 🙂']) expect(isFarewell(t), t).toBe(true);
    for (const t of ['בוקר טוב', 'ערב טוב', 'שלום', 'לילה טוב, יש מפגע בחדר 3', 'יום טוב?', 'יש לי שאלה', '']) expect(isFarewell(t), t).toBe(false);
    expect(farewellReply('לילה טוב', 'night')).toBe('לילה טוב 🌙 אם יעלה משהו, אני כאן.');
    expect(farewellReply('לילה טוב', 'noon')).toBe('המשך יום נעים ☀️ אם יעלה משהו, אני כאן.');
    expect(farewellReply('יום טוב', 'evening')).toBe('ערב נעים 🌆 אם יעלה משהו, אני כאן.');
    expect(farewellReply('שבת שלום', 'morning')).toContain('שבת שלום');
  });
  it('English greetings are greetings too', () => {
    expect(isGreeting('good morning')).toBe(true);
    expect(isGreeting('Good evening everyone')).toBe(true);
    expect(smallTalkReply('good morning, how are you?')).toContain('הכול טוב');
  });
});

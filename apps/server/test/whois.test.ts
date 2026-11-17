import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/db.js';
import { TEMPLATE_TAGS } from '../src/flow/safetyTemplate.js';
import { migrate } from '../src/migrate.js';
import { cleanOfficePhone } from '../src/safety/officers.js';
import { fixOfficerTypos, officerReply, topicsIn } from '../src/safety/whoIs.js';
import { contactText, type Officer } from '../src/safety/officers.js';

describe('which topic a question names', () => {
  const topics = [...TEMPLATE_TAGS];
  it('fire, gases, lasers, chemicals, height… in the customers\' own words', () => {
    expect(topicsIn('מי הממונה על בטיחות אש?', topics)).toEqual(expect.arrayContaining(['גילוי אש', 'מתזים']));
    expect(topicsIn('מה הטלפון של ממונה הגזים', topics)).toEqual(expect.arrayContaining(['גזים דחוסים', 'גפ״ם']));
    expect(topicsIn('למי פונים בנושא לייזרים?', topics)).toEqual(['לייזרים']);
    expect(topicsIn('מי ממונה בטיחות ליזר', topics)).toEqual(['לייזרים']);          // spelled without the double yod
    expect(topicsIn('ממונה בטיחות לייזר', topics)).toEqual(['לייזרים']);
    expect(topicsIn('מי אחראי על חומרים מסוכנים', topics)).toEqual(expect.arrayContaining(['חומ״ס']));
    expect(topicsIn('מי הממונה על סולמות', topics)).toEqual(expect.arrayContaining(['סולמות']));
    expect(topicsIn('ממונה מעליות', topics)).toEqual(['מעליות/מעלונים']);
    expect(topicsIn('מי הממונה', topics)).toEqual([]);
  });
  it('typos of "ממונה" are still a question about the officer; other words one letter away are not', () => {
    expect(fixOfficerTypos('מי מומנה בטיחות אסבסט')).toBe('מי ממונה בטיחות אסבסט');
    expect(fixOfficerTypos('מי הממונא על אש')).toBe('מי הממונה על אש');
    expect(fixOfficerTypos('מי ממונה על גזים')).toBe('מי ממונה על גזים');
    for (const t of ['קיבלתי ממנה טופס', 'מונה המים', 'שמונה בערב', 'תמונה של אסבסט', 'יש לי אמונה']) expect(fixOfficerTypos(t), t).toBe(t);
  });
  it('a flow hand-off shows a personal WhatsApp only when allowed, and only the name of an officer not marked public', () => {
    const o = { name: 'דנה', phone: '972501234567', officePhone: null, email: 'd@t.io', public: true, showWhatsapp: false } as unknown as Officer;
    expect(contactText(o)).not.toContain('972501234567');                    // no office phone is no reason to give the mobile
    expect(contactText({ ...o, showWhatsapp: true })).toContain('wa.me/972501234567');
    expect(contactText({ ...o, public: false, showWhatsapp: true })).toBe('הממונה על הנושא: דנה');
  });
  it('an office phone as written, with an extension', () => {
    expect(cleanOfficePhone('04-829-3000 שלוחה 12')).toBe('04-829-3000 שלוחה 12');
    expect(cleanOfficePhone('+972 4 829 3000')).toBe('+972 4 829 3000');
    expect(cleanOfficePhone('')).toBeNull();
    expect(cleanOfficePhone('123')).toBe(false);
    expect(cleanOfficePhone('<script>')).toBe(false);
  });
});

describe('Betty answers who the officer is', () => {
  const db = createDb(process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test');
  beforeAll(async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    const add = async (name: string, topics: string[], o: { office?: string; email?: string; phone?: string; wa?: boolean; pub?: boolean; active?: boolean } = {}) => {
      const id = (await db.query('INSERT INTO officers (name, email, phone, office_phone, public, show_whatsapp, active) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [name, o.email ?? null, o.phone ?? null, o.office ?? null, o.pub ?? true, o.wa ?? false, o.active ?? true])).rows[0].id;
      for (const t of topics) await db.query('INSERT INTO officer_topics (officer_id, topic) VALUES ($1,$2)', [id, t]);
    };
    await add('יוסי אש', ['גילוי אש', 'מתזים'], { office: '04-829-1111', email: 'fire@uni.ac.il', phone: '972501111111' });
    await add('רינה גז', ['גזים דחוסים'], { office: '04-829-2222', phone: '972502222222', wa: true });
    await add('ממונה חסוי', ['לייזרים'], { office: '04-829-3333', pub: false });
    await add('לא פעיל', ['חשמל'], { office: '04-829-4444', active: false });
    await add('דנה בלי פרטים', ['אסבסט']);
    await add('ראשת יחידה לדוגמה', ['ראש יחידת הבטיחות'], { office: '04-829-5555', email: 'head@uni.ac.il' });
  });
  afterAll(async () => { await db.end(); });

  it('the head of the unit: "מי ראש יחידת הבטיחות?" / "who is the head of the safety unit?"', async () => {
    for (const q of ['מי ראש יחידת הבטיחות?', 'מיהי ראש היחידה?', 'מי מנהלת יחידת הבטיחות', 'מי מנהלת יחידה הבטיחות', 'מי ראש יחידת הבטיחות', 'מה הטלפון של ראש היחידה', 'פרטי קשר של מנהלת היחידה', 'איך פונים לראש היחידה?', 'Who is the head of the safety unit?']) {
      const r = await officerReply(db, q);
      expect(r, q).toContain('ראשת יחידה לדוגמה');
      expect(r, q).toContain('04-829-5555');
    }
    expect(await officerReply(db, 'ראש היחידה שלי הוא פרופ׳ כהן')).toBeNull();          // telling, not asking
    // found in review: a report that mentions the head of the unit is a report, not a question about them
    expect(await officerReply(db, 'ראש היחידה שלי ביקש שאדווח על מפגע, מה עושים?')).toBeNull();
    expect(await officerReply(db, 'מנהל היחידה שלנו אמר לפנות אליכם לגבי דליפת גז?')).toBeNull();
    expect(await officerReply(db, 'מי הממונה על בטיחות אש?')).not.toContain('ראשת יחידה');
    // no head of unit in the list: a clear answer, never knowledge-base suggestions
    await db.query(`UPDATE officers SET active = false WHERE name = 'ראשת יחידה לדוגמה'`);
    expect(await officerReply(db, 'מי מנהלת יחידה הבטיחות')).toContain('לא מוגדרים אצלי');
    await db.query(`UPDATE officers SET active = true WHERE name = 'ראשת יחידה לדוגמה'`);
  });

  it('name, office phone and e-mail; WhatsApp only when allowed', async () => {
    const fire = (await officerReply(db, 'מי הממונה על בטיחות אש ומה הטלפון המשרדי שלו?'))!;
    expect(fire).toContain('יוסי אש');
    expect(fire).toContain('☎️ טלפון משרדי: 04-829-1111');
    expect(fire).toContain('fire@uni.ac.il');
    expect(fire).not.toContain('972501111111');                     // a personal mobile is not given out
    const gas = (await officerReply(db, 'מה הטלפון של ממונה הגזים?'))!;
    expect(gas).toContain('רינה גז');
    expect(gas).toContain('https://wa.me/972502222222');            // this officer allowed it
    expect(await officerReply(db, 'מי אחראי על אסבסט')).toContain('דנה בלי פרטים (אפשר לכתוב כאן, ונעביר את הפנייה)');
  });
  it('hidden or inactive officers are not given; no topic: the topics there are; other messages: nothing', async () => {
    expect(await officerReply(db, 'מי הממונה על לייזרים?')).toContain('על איזה נושא');      // the laser officer is hidden from customers
    expect(await officerReply(db, 'מי הממונה על לייזרים?')).not.toContain('ממונה חסוי');
    const elec = (await officerReply(db, 'טלפון של ממונה חשמל'))!;                       // the electricity officer is inactive
    expect(elec).toContain('על איזה נושא');
    expect(elec).not.toContain('חשמל');
    const which = (await officerReply(db, 'מי הממונה?'))!;
    expect(which).toContain('על איזה נושא? יש לנו ממונים בנושאים:');
    expect(which).toContain('גילוי אש');
    expect(which).not.toContain('לייזרים');
    expect(await officerReply(db, 'מה שעות הפעילות?')).toBeNull();
    expect(await officerReply(db, 'שלום')).toBeNull();
  });
});

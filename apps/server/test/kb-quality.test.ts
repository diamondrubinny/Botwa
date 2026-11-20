import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/db.js';
import { fixQuality, kbQuality } from '../src/kb/quality.js';
import { migrate } from '../src/migrate.js';

describe('knowledge base data quality: duplicates and mistakes', () => {
  const db = createDb(process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test');
  const ids: Record<string, string> = {};
  const P = (n: number) => `פסקה מספר ${n} בנושא בטיחות בעבודה, עם מספיק מילים כדי להיחשב קטע אמיתי של תוכן.`;
  const add = async (key: string, o: { kind?: string; title: string; body?: string | null; variants?: string[]; origin?: string; ext?: string; status?: string; error?: string; uses?: number; chunks?: string[]; old?: boolean; ageDays?: number }) => {
    const id = (await db.query(
      `INSERT INTO kb_sources (kind, title, body, variants, origin, external_id, status, error, uses, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() - make_interval(days => $10), now() - make_interval(days => $10)) RETURNING id`,
      [o.kind ?? 'faq', o.title, o.body ?? null, o.variants ?? [], o.origin ?? null, o.ext ?? null, o.status ?? 'ready', o.error ?? null, o.uses ?? 0, o.ageDays ?? 0])).rows[0].id as string;
    for (const [i, b] of (o.chunks ?? []).entries()) await db.query(`INSERT INTO kb_chunks (source_id, ord, body, terms, tsv) VALUES ($1,$2,$3,'',to_tsvector('simple',$3))`, [id, i, b]);
    ids[key] = id;
    return id;
  };

  beforeAll(async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    // the same answer twice (a question and a text)
    await add('hours', { title: 'שעות פעילות', body: 'א׳–ה׳ 9:00–17:00', chunks: ['א׳–ה׳ 9:00–17:00 שעות הפעילות של היחידה'], uses: 5, ageDays: 10 });
    await add('hoursCopy', { kind: 'text', title: 'שעות (עותק)', body: 'x', chunks: ['א׳–ה׳ 9:00–17:00 שעות הפעילות של היחידה'] });
    // a law uploaded by hand and also imported: the import stays
    await add('lawUpload', { kind: 'file', title: 'פקודת הבטיחות (קובץ)', chunks: [P(1), P(2), P(3), P(4)], uses: 9, ageDays: 30 });
    await add('lawImport', { kind: 'text', title: 'פקודת הבטיחות בעבודה', origin: 'gov:wikisource', ext: 'פקודת הבטיחות בעבודה', chunks: [P(1), P(2), P(3), P(4)] });
    // a small source contained in a larger one
    await add('part', { kind: 'text', title: 'תקציר נוהל', chunks: [P(11), P(12), P(13)] });
    await add('whole', { kind: 'text', title: 'הנוהל המלא', chunks: [P(11), P(12), P(13), P(14), P(15)], ageDays: 5 });
    // the same question with two different answers
    await add('q1', { title: 'איך מזמינים הדרכה?', body: 'דרך מערכת ההדרכות באתר.', chunks: ['דרך מערכת ההדרכות באתר.'] });
    await add('q2', { title: 'איך מזמינים הדרכה', body: 'בטלפון למזכירות היחידה.', chunks: ['בטלפון למזכירות היחידה.'] });
    // a useless answer, repeated wordings, empty, stuck, in error, garbled
    await add('short', { title: 'האם מותר?', body: 'כן', chunks: ['כן'] });
    await add('variants', { title: 'פינוי פסולת כימית', body: 'ממלאים טופס פינוי.', variants: ['פינוי פסולת כימית?', 'פינוי  פסולת', 'פינוי פסולת', 'איסוף כימיקלים'], chunks: ['ממלאים טופס פינוי ושולחים ליחידה.'] });
    await add('empty', { kind: 'text', title: 'מסמך ריק', chunks: [] });
    await add('stuck', { kind: 'link', title: 'דף שלא נקרא', status: 'pending', ageDays: 3 });
    await add('broken', { kind: 'link', title: 'דף שבור', status: 'error', error: 'fetch_failed' });
    await add('garbled', { kind: 'file', title: 'סריקה פגומה', chunks: [`${'�'.repeat(30)} טקסט`] });
  });
  afterAll(async () => { await db.end(); });

  it('finds every kind of problem and says what stays', async () => {
    const { issues, checked } = await kbQuality(db);
    expect(checked).toBeGreaterThan(10);
    const by = (k: string) => issues.filter((i) => i.kind === k);
    const ofIds = (k: string) => by(k).flatMap((i) => i.items.map((x) => x.id));
    expect(by('same_content').find((i) => i.items.some((x) => x.id === ids.hoursCopy))!.keep!.id).toBe(ids.hours);    // the more used, older one stays
    expect(by('same_content').find((i) => i.items.some((x) => x.id === ids.lawUpload))!.keep!.id).toBe(ids.lawImport);  // an import stays (kept up to date)
    expect(by('contained')).toHaveLength(1);
    expect(by('contained')[0]).toMatchObject({ keep: { id: ids.whole }, items: [{ id: ids.part }] });
    expect(by('contained')[0]!.detail).toContain('3 מתוך 3');
    expect(by('same_question')[0]!.items.map((x) => x.id).sort()).toEqual([ids.q1, ids.q2].sort());
    expect(ofIds('short_answer')).toContain(ids.short);
    expect(ofIds('repeated_variants')).toEqual([ids.variants]);
    expect(ofIds('empty')).toEqual([ids.empty]);
    expect(ofIds('stuck')).toEqual([ids.stuck]);
    expect(by('broken')[0]).toMatchObject({ items: [{ id: ids.broken }], detail: 'fetch_failed' });
    expect(ofIds('garbled')).toEqual([ids.garbled]);
    // nothing healthy is reported
    for (const ok of [ids.whole, ids.lawImport, ids.hours]) expect(issues.filter((i) => i.action === 'fix').flatMap((i) => i.items.map((x) => x.id))).not.toContain(ok);
  });

  it('the correction switches duplicates off (never deletes), cleans wordings, sends stuck ones again; review items stay', async () => {
    const r = await fixQuality(db);
    expect(r.disabled).toBe(4);                                    // hoursCopy, lawUpload, part, empty
    expect(r.cleaned).toEqual([ids.variants]);
    expect(r.requeued).toEqual([ids.stuck]);
    const on = async (k: string) => (await db.query('SELECT enabled, meta FROM kb_sources WHERE id = $1', [ids[k]])).rows[0];
    for (const k of ['hoursCopy', 'lawUpload', 'part', 'empty']) expect((await on(k)).enabled, k).toBe(false);
    for (const k of ['hours', 'lawImport', 'whole', 'q1', 'q2', 'short']) expect((await on(k)).enabled, k).toBe(true);
    expect((await on('lawUpload')).meta).toMatchObject({ duplicateOf: ids.lawImport, duplicateKind: 'same_content' });
    expect((await db.query('SELECT variants FROM kb_sources WHERE id = $1', [ids.variants])).rows[0].variants).toEqual(['פינוי  פסולת', 'איסוף כימיקלים']);
    expect((await db.query('SELECT count(*)::int AS n FROM kb_sources')).rows[0].n).toBe(14);   // nothing deleted
    // a second check: the fixed problems are gone, the ones for a person are still listed
    const again = (await kbQuality(db)).issues;
    expect(again.filter((i) => i.action === 'fix' && i.kind !== 'stuck')).toEqual([]);
    expect(again.map((i) => i.kind)).toEqual(expect.arrayContaining(['same_question', 'short_answer', 'broken', 'garbled']));
  });
});

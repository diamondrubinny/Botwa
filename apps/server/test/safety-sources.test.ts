import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db.js';
import { ioshEntry, seedIosh } from '../src/kb/gov/iosh.js';
import { validTitle } from '../src/kb/gov/importer.js';
import { DEFAULT_TITLES } from '../src/kb/gov/wikisource.js';
import { migrate } from '../src/migrate.js';

describe('the safety legislation imported by default', () => {
  it('covers safety at work, labour inspection, hazardous materials, asbestos, radiation, women and young people, fire', () => {
    expect(DEFAULT_TITLES.length).toBeGreaterThanOrEqual(60);
    expect(DEFAULT_TITLES.length).toBeLessThanOrEqual(150);                // the selection limit
    expect(new Set(DEFAULT_TITLES).size).toBe(DEFAULT_TITLES.length);
    for (const t of DEFAULT_TITLES) expect(validTitle(t), t).toBe(true);
    for (const t of ['פקודת הבטיחות בעבודה', 'חוק החמרים המסוכנים', 'חוק למניעת מפגעי אסבסט ואבק מזיק', 'חוק הקרינה הבלתי מייננת',
      'תקנות הבטיחות בעבודה (בטיחות וגיהות תעסוקתית בעבודה עם גורמים מסוכנים במעבדות רפואיות, כימיות וביולוגיות)',
      'תקנות הבטיחות בעבודה (גיהות תעסוקתית ובטיחות העוסקים בקרינת לייזר)', 'תקנות עבודת נשים (עבודות אסורות, עבודות מוגבלות ועבודות מסוכנות)']) {
      expect(DEFAULT_TITLES, t).toContain(t);
    }
  });
});

describe('migration 068 and the IOSH directory', () => {
  const db = createDb(process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test');
  it('adds the new titles to a chosen selection (no duplicates), switches the import on and runs it soon', async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    await db.query(`INSERT INTO users (email, name, role, password_hash) VALUES ('a@t.io', 'a', 'admin', 'x')`);   // a running installation
    await db.query(`UPDATE gov_sources SET selection = ARRAY['פקודת הבטיחות בעבודה', 'חוק החמרים המסוכנים', 'תקנות שבחר הצוות'], enabled = false, last_run_at = now() WHERE key = 'wikisource'`);
    await db.query(`DELETE FROM schema_migrations WHERE name LIKE '068%'`);
    await migrate(db);
    const r = (await db.query(`SELECT selection, enabled, last_run_at FROM gov_sources WHERE key = 'wikisource'`)).rows[0];
    expect(r.selection.slice(0, 3)).toEqual(['פקודת הבטיחות בעבודה', 'חוק החמרים המסוכנים', 'תקנות שבחר הצוות']);   // the staff's choice first, as it was
    expect(r.selection).toContain('תקנות הבטיחות בעבודה (גיהות תעסוקתית ובטיחות העוסקים בקרינת לייזר)');
    expect(new Set(r.selection).size).toBe(r.selection.length);
    expect(r).toMatchObject({ enabled: true, last_run_at: null });
  });
  it('the IOSH directory: our own sentence and a link per topic, once per version, never their texts', async () => {
    const indexed: string[] = [];
    const kb = { indexWritten: async (id: string) => { indexed.push(id); } };
    const n = await seedIosh(db, kb);
    expect(n).toBe(16);
    expect(indexed).toHaveLength(16);
    expect(await seedIosh(db, kb)).toBe(0);
    const rows = (await db.query(`SELECT title, body, url, audience FROM kb_sources WHERE origin = 'gov:iosh' ORDER BY title`)).rows;
    expect(rows).toHaveLength(16);
    for (const r of rows) {
      expect(r.url).toMatch(/^https:\/\/www\.osh\.org\.il\/heb\//);
      expect(r.body).toContain(r.url);
      expect(r.body).toMatch(/^המוסד לבטיחות ולגיהות \(המוס״ל\) מפרסם מידע מקצועי בנושא/);
      expect(r.audience).toBe('both');
    }
    expect(ioshEntry({ key: 'x', topic: 'רעש', path: 'Prof/noise/', words: ['שמיעה'] }).variants).toEqual(['רעש', 'שמיעה']);
    await db.end();
  });
});

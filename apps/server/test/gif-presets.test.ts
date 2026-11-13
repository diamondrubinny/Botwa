import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createDb } from '../src/db.js';
import { GIF_PRESETS_VERSION, seedGifPresets } from '../src/gif-presets.js';
import { gifSize } from '../src/media/animation.js';
import { migrate } from '../src/migrate.js';

const db = createDb(process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test');
beforeAll(async () => { await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await migrate(db); });
afterAll(async () => { await db.end(); });

describe('built-in GIFs', () => {
  it('ship as valid, small, looping GIFs with a Hebrew title and keywords', async () => {
    const manifest = JSON.parse(await readFile(new URL('../src/gif-presets/manifest.json', import.meta.url), 'utf8')) as Record<string, { title: string; keywords: string }>;
    expect(Object.keys(manifest).length).toBeGreaterThanOrEqual(12);
    for (const [k, m] of Object.entries(manifest)) {
      const gif = await readFile(new URL(`../src/gif-presets/${k}.gif`, import.meta.url));
      expect(gifSize(gif), k).toEqual({ width: 320, height: 320 });
      expect(gif.length, k).toBeLessThan(200 * 1024);
      expect(gif.includes(Buffer.from('NETSCAPE2.0')), `${k} loops`).toBe(true);
      expect(m.title).toMatch(/[֐-׿]/);
      expect(m.keywords.length).toBeGreaterThan(5);
    }
  });

  it('are added to the gallery once; a deleted one does not come back, and nothing is duplicated', async () => {
    const mp4 = async () => Buffer.from('fake-mp4');
    const n = await seedGifPresets(db, mp4);
    expect(n).toBeGreaterThanOrEqual(12);
    const rows = (await db.query(`SELECT title, keywords, mp4 IS NOT NULL AS has_mp4 FROM gif_gallery`)).rows;
    expect(rows.map((r) => r.title)).toContain('תודה!');
    expect(rows.every((r) => r.has_mp4 && r.keywords.includes('מובנה'))).toBe(true);
    expect(await seedGifPresets(db, mp4)).toBe(0);
    await db.query(`DELETE FROM gif_gallery WHERE title = 'תודה!'`);
    expect(await seedGifPresets(db, mp4)).toBe(0);
    expect((await db.query(`SELECT count(*)::int AS n FROM gif_gallery WHERE title = 'תודה!'`)).rows[0].n).toBe(0);
    expect((await db.query(`SELECT value FROM settings WHERE key = 'gif_presets_version'`)).rows[0].value).toBe(GIF_PRESETS_VERSION);
  });

  it('without ffmpeg they are still added (as GIF only)', async () => {
    await db.query(`DELETE FROM gif_gallery; DELETE FROM settings WHERE key = 'gif_presets_version'`);
    expect(await seedGifPresets(db, async () => null)).toBeGreaterThanOrEqual(12);
    expect((await db.query(`SELECT count(*)::int AS n FROM gif_gallery WHERE mp4 IS NULL`)).rows[0].n).toBeGreaterThanOrEqual(12);
  });
});

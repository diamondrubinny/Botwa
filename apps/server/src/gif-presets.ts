import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';
import { gifSize } from './media/animation.js';

/** Bump when presets are added or redrawn: each version is added once, so a preset an admin deleted does not come back. */
export const GIF_PRESETS_VERSION = 1;
const MAX_GIFS = 300;

/**
 * The built-in GIFs (drawn for this system, src/gif-presets): added to the gallery once per version, with a silent MP4 when
 * the server can make one. Never replaces or duplicates a GIF already in the gallery (same file = same sha256).
 */
export async function seedGifPresets(db: Db, toMp4: (gif: Buffer) => Promise<Buffer | null>, dir = new URL('./gif-presets/', import.meta.url)): Promise<number> {
  const done = (await db.query(`SELECT value FROM settings WHERE key = 'gif_presets_version'`)).rows[0]?.value;
  if (typeof done === 'number' && done >= GIF_PRESETS_VERSION) return 0;
  const base = dir instanceof URL ? fileURLToPath(dir) : dir;
  const manifest = JSON.parse(await readFile(path.join(base, 'manifest.json'), 'utf8')) as Record<string, { title: string; keywords: string }>;
  const files = new Set(await readdir(base));
  let added = 0;
  for (const [key, meta] of Object.entries(manifest)) {
    if (!files.has(`${key}.gif`)) continue;
    if ((await db.query('SELECT count(*)::int AS n FROM gif_gallery')).rows[0].n >= MAX_GIFS) break;
    const gif = await readFile(path.join(base, `${key}.gif`));
    const size = gifSize(gif);
    if (!size) continue;
    const sha = createHash('sha256').update(gif).digest('hex');
    if ((await db.query('SELECT 1 FROM gif_gallery WHERE sha256 = $1', [sha])).rowCount) continue;
    const mp4 = await toMp4(gif).catch(() => null);
    const r = await db.query(
      `INSERT INTO gif_gallery (title, keywords, gif, mp4, width, height, size, sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (sha256) DO NOTHING`,
      [meta.title.slice(0, 80), `${meta.keywords} מובנה`.slice(0, 300), gif, mp4, size.width, size.height, gif.length, sha]);
    added += r.rowCount ?? 0;
  }
  await db.query(`INSERT INTO settings (key, value) VALUES ('gif_presets_version', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(GIF_PRESETS_VERSION)]);
  return added;
}

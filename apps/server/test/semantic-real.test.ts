import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { KnowledgeBase, isConfident } from '../src/kb/service.js';
import { MediaService } from '../src/media/store.js';
import { migrate } from '../src/migrate.js';
import { LocalEmbedder } from '../src/semantic/embedder.js';

// Runs the real multilingual model (downloads ~120MB on first run). Off by default:  TEST_REAL_EMBEDDINGS=1 npx vitest run test/semantic-real.test.ts
// Needs the optional runtime:  npm i --no-save @huggingface/transformers
const real = process.env.TEST_REAL_EMBEDDINGS === '1';
describe.skipIf(!real)('real local model on Hebrew', () => {
  const cfg = loadConfig({
    NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test', ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    APP_ORIGIN: 'https://panel.test', SEMANTIC_SEARCH: 'local', MODEL_DIR: process.env.MODEL_DIR ?? '/tmp/botwa-models',
  });
  const db = createDb(cfg.DATABASE_URL);
  let kb: KnowledgeBase;
  beforeAll(async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    kb = new KnowledgeBase(db, cfg, new MediaService(db, cfg));
    const emb = new LocalEmbedder(cfg);
    kb.setEmbedder(emb);
    for (let i = 0; i < 120 && emb.status().state === 'loading'; i++) await new Promise((r) => setTimeout(r, 1000));
    expect(emb.status(), JSON.stringify(emb.status())).toMatchObject({ state: 'ready' });
    const add = async (title: string, body: string, variants: string[] = []) => {
      const id = (await db.query(`INSERT INTO kb_sources (kind, title, variants, body) VALUES ('faq',$1,$2,$3) RETURNING id`, [title, variants, body])).rows[0].id as string;
      await kb.indexWritten(id);
    };
    await add('מהן שעות הפעילות שלכם?', 'אנחנו פעילים בימים א׳–ה׳ בין 9:00 ל-17:00.');
    await add('איך מבצעים החזרה של מוצר?', 'אפשר להחזיר מוצר תוך 14 ימים עם קבלה.');
    await add('כמה עולה משלוח?', 'משלוח עד הבית עולה 29 ש״ח.');
    await add('כמה ימי חופשה מגיעים לעובד?', 'עובד זכאי לעשרים ימי חופשה בשנה.');
    await add('מי ממונה הבטיחות בעבודה בגובה?', 'ממונה הבטיחות בגובה הוא דני כהן.');
  }, 180_000);
  afterAll(async () => { await db.end(); });

  it('answers paraphrases that share no keywords and refuses unrelated questions', async () => {
    const ask = async (q: string) => { const h = await kb.search(q, { audience: 'any', limit: 3 }); return { top: h[0], ok: isConfident(h[0], h[1], 0.6) }; };
    const positives: [string, string][] = [['עד מתי אתם עובדים ביום שישי', 'שעות'], ['באיזה שעה אתם סוגרים', 'שעות'], ['איך מחזירים סחורה', 'החזרה'], ['כמה זה עולה שיביאו לי הביתה', 'משלוח'], ['מי אחראי על עבודה על גג', 'בטיחות']];
    let answered = 0;
    for (const [q, word] of positives) { const r = await ask(q); expect(r.top?.title, q).toContain(word); if (r.ok) answered++; }
    expect(answered).toBeGreaterThanOrEqual(3);
    for (const q of ['מה מזג האוויר מחר', 'מי ניצח במשחק אתמול', 'אפשר מתכון לעוגה', 'תודה רבה', 'שלום מה נשמע']) expect((await ask(q)).ok, q).toBe(false);
  }, 120_000);
});

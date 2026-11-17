import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { retentionPolicy, retentionRuns, runRetention } from '../src/retention.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test';
const db = createDb(DB_URL);
const cfg = (over: Record<string, string> = {}) => loadConfig({ NODE_ENV: 'test', DATABASE_URL: DB_URL, ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: 'https://p.test', ...over });

describe('retention policy: one daily pass, recorded with counts only', () => {
  let tpl = '';
  const req = async (status: string, daysAgo: number, signed = false) => {
    const id = (await db.query(`INSERT INTO form_requests (template_id, template_sha256, fields, token_hash, status, expires_at, created_at, signed_at)
      VALUES ($1, 'x', '[]', $2, $3, now(), now() - make_interval(days => $4), CASE WHEN $5 THEN now() - make_interval(days => $4) END) RETURNING id`,
      [tpl, randomBytes(8).toString('hex'), status, daysAgo, signed])).rows[0].id as string;
    if (signed) await db.query(`INSERT INTO form_submissions (request_id, values_enc, signed_pdf, sha256) VALUES ($1, 'v', '\\x00', $2)`, [id, randomBytes(8).toString('hex')]);
    return id;
  };
  const exists = async (id: string) => (await db.query(`SELECT 1 FROM form_requests WHERE id = $1`, [id])).rowCount === 1;

  beforeAll(async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    tpl = (await db.query(`INSERT INTO form_templates (title, source_pdf, sha256, pages) VALUES ('טופס', '\\x00', 'h', '[]') RETURNING id`)).rows[0].id;
  });
  afterAll(async () => { await db.end(); });

  it('the policy in force comes from the configuration; 0 means kept', () => {
    const p = Object.fromEntries(retentionPolicy(cfg()).map((x) => [x.key, x.days]));
    expect(p).toMatchObject({ messages: 365, audit: 730, forms_unsigned: 180, forms_signed: 0 });
  });

  it('deletes only what is past its time, keeps signed forms by default, and records how many of each kind', async () => {
    await db.query(`INSERT INTO audit_log (action, created_at) VALUES ('old', now() - interval '800 days'), ('new', now() - interval '10 days')`);
    await db.query(`INSERT INTO kb_queries (text, via, answered, created_at) VALUES ('q', 'bot', false, now() - interval '40 days'), ('q2', 'bot', false, now())`);
    const oldUnsigned = await req('expired', 200), newUnsigned = await req('sent', 10), oldSigned = await req('signed', 900, true);
    const r = await runRetention(db, cfg());
    expect(r.error).toBeUndefined();
    expect(r.counts).toMatchObject({ audit: 1, kb_queries: 1, forms_unsigned: 1 });
    expect(r.counts.forms_signed).toBeUndefined();                                       // kept: not even tried
    expect(await exists(oldUnsigned)).toBe(false);
    expect(await exists(newUnsigned)).toBe(true);
    expect(await exists(oldSigned)).toBe(true);
    expect((await db.query(`SELECT action FROM audit_log ORDER BY action`)).rows.map((x) => x.action)).toEqual(['new']);
    const runs = await retentionRuns(db);
    expect(runs[0]).toMatchObject({ manual: false, error: null, counts: { audit: 1, kb_queries: 1, forms_unsigned: 1 } });
    expect(JSON.stringify(runs)).not.toContain('q2');                                   // counts only
    // a signed-forms period, once set, applies to them too
    const r2 = await runRetention(db, cfg({ FORM_SIGNED_RETENTION_DAYS: '365' }), undefined, true);
    expect(r2.counts.forms_signed).toBe(1);
    expect(await exists(oldSigned)).toBe(false);
    expect((await retentionRuns(db))[0]!.manual).toBe(true);
  });
});

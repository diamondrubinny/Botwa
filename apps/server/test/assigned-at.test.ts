import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';

const db = createDb(process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test');
beforeAll(async () => { await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await migrate(db); });
afterAll(async () => { await db.end(); });

describe('since when the handler handles it', () => {
  it('is set when someone takes it, moves on a hand-over, clears when unassigned, and stays put otherwise', async () => {
    const ch = (await db.query(`INSERT INTO channels (type, label) VALUES ('whatsapp', 'WA') RETURNING id`)).rows[0].id;
    const ct = (await db.query(`INSERT INTO contacts (channel_id, external_id) VALUES ($1, 'x1') RETURNING id`, [ch])).rows[0].id;
    const [u1, u2] = (await db.query(`INSERT INTO users (email, name, role, password_hash) VALUES ('a@t.io','a','agent','x'), ('b@t.io','b','agent','x') RETURNING id`)).rows.map((r) => r.id);
    const conv = (await db.query(`INSERT INTO conversations (channel_id, contact_id) VALUES ($1,$2) RETURNING id, assigned_at`, [ch, ct])).rows[0];
    expect(conv.assigned_at).toBeNull();
    const at = async () => (await db.query('SELECT assigned_at FROM conversations WHERE id = $1', [conv.id])).rows[0].assigned_at as Date | null;
    await db.query('UPDATE conversations SET assigned_to = $2 WHERE id = $1', [conv.id, u1]);
    const first = await at();
    expect(first).not.toBeNull();
    await db.query(`UPDATE conversations SET assigned_at = now() - interval '1 hour' WHERE id = $1`, [conv.id]);
    const old = await at();
    await db.query('UPDATE conversations SET assigned_to = $2, unread_count = 3 WHERE id = $1', [conv.id, u1]);   // same person: unchanged
    expect((await at())!.getTime()).toBe(old!.getTime());
    await db.query('UPDATE conversations SET assigned_to = $2 WHERE id = $1', [conv.id, u2]);                      // hand-over: now
    expect((await at())!.getTime()).toBeGreaterThan(old!.getTime());
    await db.query('UPDATE conversations SET assigned_to = NULL WHERE id = $1', [conv.id]);
    expect(await at()).toBeNull();
    const born = (await db.query(`INSERT INTO conversations (channel_id, contact_id, assigned_to) VALUES ($1, (SELECT id FROM contacts WHERE external_id = 'x1'), $2) ON CONFLICT DO NOTHING RETURNING assigned_at`, [ch, u1])).rows[0];
    if (born) expect(born.assigned_at).not.toBeNull();
  });
});

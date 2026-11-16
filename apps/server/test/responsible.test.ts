import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/db.js';
import { ingestInbound } from '../src/inbox.js';
import { migrate } from '../src/migrate.js';
import { assignResponsible, findResponsible } from '../src/safety/responsible.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/botwa_test';
const db = createDb(DB_URL);
let ch = '';
let n = 0;
const user = async (name: string, active = true) => (await db.query(`INSERT INTO users (email, name, role, password_hash, active) VALUES ($1, $2, 'agent', 'x', $3) RETURNING id`, [`u${++n}@t.io`, name, active])).rows[0].id as string;
const officer = async (name: string, userId: string | null, topics: string[]) => {
  const id = (await db.query(`INSERT INTO officers (name, user_id) VALUES ($1, $2) RETURNING id`, [name, userId])).rows[0].id;
  for (const t of topics) await db.query(`INSERT INTO officer_topics (officer_id, topic) VALUES ($1, $2)`, [id, t]);
};
const conv = async (text: string) => {
  const ext = `97250${String(++n).padStart(7, '0')}@s.whatsapp.net`;
  await ingestInbound(db, ch, { externalContactId: ext, contactName: 'לקוח', externalMessageId: `m${n}`, text, timestamp: new Date() });
  return (await db.query(`SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.external_id = $1`, [ext])).rows[0].id as string;
};
const tag = async (convId: string, name: string) => {
  const t = (await db.query(`INSERT INTO tags (name) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id`, [name])).rows[0]?.id ?? (await db.query(`SELECT id FROM tags WHERE name = $1`, [name])).rows[0].id;
  await db.query(`INSERT INTO conversation_tags (conversation_id, tag_id) VALUES ($1, $2)`, [convId, t]);
};

describe('the responsible safety officer for a handed-over conversation', () => {
  let laser = '', chem = '', area = '', def = '', backup = '';
  beforeAll(async () => {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    ch = (await db.query(`INSERT INTO channels (type, label) VALUES ('whatsapp', 'WA') RETURNING id`)).rows[0].id;
    laser = await user('רמ"ד לייזרים'); chem = await user('רוברט'); area = await user('ממונה בניין 12'); def = await user('ממונה ראשי'); backup = await user('ממונה חלופי');
    await officer('ממונה לייזרים', laser, ['לייזרים']);
    await officer('ממונה חומ"ס', chem, ['חומ״ס']);
    await officer('ממונה בלי חשבון', null, ['אסבסט']);
    await db.query(`INSERT INTO responsibility_areas (name, keywords, user_id) VALUES ('בניין 12', '{"בניין 12"}', $1)`, [area]);
  });
  afterAll(async () => { await db.end(); });

  it('topic in the message, then the conversation\'s topic tag, then the area, then the default, the backup, any officer', async () => {
    const a = await conv('יש לי שאלה על לייזר במעבדה');
    expect(await findResponsible(db, a)).toMatchObject({ userId: laser, via: 'text' });
    const b = await conv('נציג');
    await tag(b, 'חומ״ס');
    expect(await findResponsible(db, b)).toMatchObject({ userId: chem, via: 'tag', topic: 'חומ״ס' });
    const c = await conv('נציג');
    await db.query(`UPDATE conversations SET flow_state = '{"vars":{"where":"בניין 12 קומה 3"}}' WHERE id = $1`, [c]);
    expect(await findResponsible(db, c)).toMatchObject({ userId: area, via: 'area' });
    const d = await conv('נציג בבקשה');
    await tag(d, 'אסבסט');                                                            // the officer has no account: next step
    expect(await findResponsible(db, d, { defaultUserId: def, backupUserId: backup })).toMatchObject({ userId: def, via: 'default' });
    expect(await findResponsible(db, d, { defaultUserId: null, backupUserId: backup })).toMatchObject({ userId: backup, via: 'backup' });
    const inactive = await user('לא פעיל', false);
    expect(await findResponsible(db, d, { defaultUserId: inactive, backupUserId: null })).toMatchObject({ via: 'officer' });
    expect([laser, chem]).toContain((await findResponsible(db, d, {}))!.userId);    // a safety officer with an account, never a random agent
  });

  it('assigns only when nobody holds it, with a note saying why', async () => {
    const a = await conv('שאלה על לייזר');
    expect(await assignResponsible(db, a)).toMatchObject({ userId: laser });
    expect((await db.query(`SELECT assigned_to FROM conversations WHERE id = $1`, [a])).rows[0].assigned_to).toBe(laser);
    expect((await db.query(`SELECT body FROM conversation_notes WHERE conversation_id = $1`, [a])).rows[0].body).toContain('לפי הנושא שבהודעת הלקוח');
    await db.query(`UPDATE conversations SET assigned_to = $2 WHERE id = $1`, [a, chem]);
    expect(await assignResponsible(db, a)).toBeNull();
    expect((await db.query(`SELECT assigned_to FROM conversations WHERE id = $1`, [a])).rows[0].assigned_to).toBe(chem);
  });
});

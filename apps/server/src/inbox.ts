import type { Db } from './db.js';
import type { InboundMessage } from './channels/types.js';

/** Store an inbound message; one conversation per contact, reopened on new inbound. Idempotent on external id. */
export async function ingestInbound(db: Db, channelId: string, m: InboundMessage) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const contact = await client.query(
      `INSERT INTO contacts (channel_id, external_id, display_name) VALUES ($1,$2,$3)
       ON CONFLICT (channel_id, external_id) DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, contacts.display_name)
       RETURNING id`,
      [channelId, m.externalContactId, m.contactName ?? null],
    );
    const conv = await client.query(
      `INSERT INTO conversations (channel_id, contact_id) VALUES ($1,$2)
       ON CONFLICT (contact_id) DO UPDATE SET contact_id = EXCLUDED.contact_id RETURNING id`,
      [channelId, contact.rows[0].id],
    );
    const convId: string = conv.rows[0].id;
    const ins = await client.query(
      `INSERT INTO messages (conversation_id, direction, body, external_id, created_at)
       VALUES ($1,'in',$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`,
      [convId, m.text, m.externalMessageId, m.timestamp],
    );
    if (ins.rowCount) {
      await client.query(
        `UPDATE conversations SET status='open', unread_count = unread_count + 1, last_message_at = $2 WHERE id = $1`,
        [convId, m.timestamp],
      );
    }
    await client.query('COMMIT');
    return { conversationId: convId, messageId: ins.rows[0]?.id as string | undefined, duplicate: !ins.rowCount };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Data-retention: delete old messages, then empty closed conversations. Returns deleted message count. */
export async function purgeOldMessages(db: Db, retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;
  const del = await db.query(`DELETE FROM messages WHERE created_at < now() - make_interval(days => $1)`, [retentionDays]);
  await db.query(
    `DELETE FROM conversations c WHERE c.status='closed' AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)`,
  );
  return del.rowCount ?? 0;
}

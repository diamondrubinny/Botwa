import type { Db } from './db.js';
import type { InboundMessage } from './channels/types.js';
import type { MediaService } from './media/store.js';

/** Store an inbound message; one conversation per contact, reopened on new inbound. Idempotent on external id. */
export async function ingestInbound(db: Db, channelId: string, m: InboundMessage, opts: { floodLimit?: number } = {}) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const contact = await client.query(
      `INSERT INTO contacts (channel_id, external_id, display_name) VALUES ($1,$2,$3)
       ON CONFLICT (channel_id, external_id) DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, contacts.display_name)
       RETURNING id, blocked`,
      [channelId, m.externalContactId, m.contactName ?? null],
    );
    const conv = await client.query(
      `INSERT INTO conversations (channel_id, contact_id) VALUES ($1,$2)
       ON CONFLICT (contact_id) DO UPDATE SET contact_id = EXCLUDED.contact_id RETURNING id, assigned_to, status`,
      [channelId, contact.rows[0].id],
    );
    const convId: string = conv.rows[0].id;
    const needsRouting = conv.rows[0].assigned_to === null;
    const ins = await client.query(
      `INSERT INTO messages (conversation_id, direction, body, external_id, created_at)
       VALUES ($1,'in',$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`,
      [convId, m.text, m.externalMessageId, m.timestamp],
    );
    let blocked: boolean = contact.rows[0].blocked;
    let flooded = false;
    if (ins.rowCount && !blocked && opts.floodLimit) {
      // flood guard: too many messages in a couple of minutes => block the contact (kept as evidence, triggers nothing)
      const n = await client.query(`SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND direction = 'in' AND created_at > now() - interval '2 minutes'`, [convId]);
      if (n.rows[0].n >= opts.floodLimit) {
        await client.query(`UPDATE contacts SET blocked = true, blocked_at = now(), blocked_reason = 'flood' WHERE id = $1`, [contact.rows[0].id]);
        blocked = true;
        flooded = true;
      }
    }
    if (ins.rowCount) {
      if (blocked) {
        await client.query(`UPDATE conversations SET status = 'closed', unread_count = 0, bot_state = NULL, last_message_at = $2 WHERE id = $1`, [convId, m.timestamp]);
      } else {
        await client.query(
          `UPDATE conversations SET status='open', unread_count = unread_count + 1, last_message_at = $2 WHERE id = $1`,
          [convId, m.timestamp],
        );
      }
    }
    await client.query('COMMIT');
    return { conversationId: convId, messageId: ins.rows[0]?.id as string | undefined, duplicate: !ins.rowCount, needsRouting, blocked, flooded, contactId: contact.rows[0].id as string };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Data-retention: delete old messages, then empty closed conversations. Returns deleted message count. */
export async function purgeOldMessages(db: Db, retentionDays: number, media?: MediaService): Promise<number> {
  if (retentionDays <= 0) return 0;
  await media?.purgeFiles('m.created_at < now() - make_interval(days => $1)', [retentionDays]);
  const del = await db.query(`DELETE FROM messages WHERE created_at < now() - make_interval(days => $1)`, [retentionDays]);
  await db.query(
    `DELETE FROM conversations c WHERE c.status='closed' AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)`,
  );
  return del.rowCount ?? 0;
}

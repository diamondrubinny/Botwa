import type { Db } from './db.js';
import type { InboundMessage } from './channels/types.js';
import type { MediaService } from './media/store.js';
import { parseRating } from './automations.js';

/** Store an inbound message; one conversation per contact, reopened on new inbound. Idempotent on external id. */
export async function ingestInbound(db: Db, channelId: string, m: InboundMessage, opts: { floodLimit?: number } = {}) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const contact = await client.query(
      `INSERT INTO contacts (channel_id, external_id, display_name) VALUES ($1,$2,$3)
       ON CONFLICT (channel_id, external_id) DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, contacts.display_name)
       RETURNING id, blocked, opted_out`,
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
    // the answer to "how was the service? 1-5": stored on that case; the conversation stays closed and nothing else happens
    let rated: number | null = null;
    if (ins.rowCount && !blocked) {
      const fb = (await client.query(`SELECT status, feedback_case_id, feedback_asked_at FROM conversations WHERE id = $1`, [convId])).rows[0];
      if (fb?.feedback_case_id) {
        const fresh = fb.feedback_asked_at && Date.now() - new Date(fb.feedback_asked_at).getTime() < 3 * 24 * 3600_000;
        rated = fresh && fb.status === 'closed' && !m.media ? parseRating(m.text) : null;
        if (rated) await client.query('UPDATE cases SET rating = $2, rated_at = now() WHERE id = $1 AND rating IS NULL', [fb.feedback_case_id, rated]);
        await client.query('UPDATE conversations SET feedback_case_id = NULL, feedback_asked_at = NULL WHERE id = $1', [convId]);   // one answer only
      }
    }
    if (ins.rowCount && rated) {
      await client.query('UPDATE conversations SET last_message_at = $2 WHERE id = $1', [convId, m.timestamp]);
    } else if (ins.rowCount) {
      if (blocked) {
        await client.query(`UPDATE conversations SET status = 'closed', unread_count = 0, bot_state = NULL, last_message_at = $2 WHERE id = $1`, [convId, m.timestamp]);
      } else {
        await client.query(
          `UPDATE conversations SET status='open', snoozed_until = NULL, unread_count = unread_count + 1, last_message_at = $2 WHERE id = $1`,
          [convId, m.timestamp],
        );
      }
    }
    await client.query('COMMIT');
    return { conversationId: convId, messageId: ins.rows[0]?.id as string | undefined, duplicate: !ins.rowCount, needsRouting, blocked, flooded, rated, contactId: contact.rows[0].id as string, optedOut: contact.rows[0].opted_out as boolean };
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
  // the inquiry list keeps dates and ratings, but not the customer's words, beyond the same period
  await db.query(`UPDATE cases SET first_message = NULL WHERE first_message IS NOT NULL AND opened_at < now() - make_interval(days => $1)`, [retentionDays]);
  // identification details kept on a contact card (name, faculty, PI, status) go too, once the person has been inactive that long
  await db.query(
    `UPDATE contacts ct SET profile = '{}'::jsonb WHERE ct.profile <> '{}'::jsonb
        AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.contact_id = ct.id AND c.last_message_at >= now() - make_interval(days => $1))`, [retentionDays]);
  await db.query(
    `DELETE FROM conversations c WHERE c.status='closed' AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)`,
  );
  return del.rowCount ?? 0;
}

import type { PoolClient } from 'pg';

/**
 * WhatsApp usernames: a customer first seen by user id only ("<BSUID>@bsuid") later writes with the phone number as well.
 * The two contacts are the same person: the id-only contact is folded into the one with the number, inside the caller's
 * transaction. History is kept (messages, notes, tags, cases, forms, schedules), duplicates are dropped, nothing is lost silently:
 * a note on the conversation says what happened.
 */
export async function foldIdContact(client: PoolClient, fromId: string, intoId: string, userId: string): Promise<void> {
  const conv = async (contactId: string) => (await client.query(`SELECT id, status, assigned_to FROM conversations WHERE contact_id = $1`, [contactId])).rows[0] as { id: string; status: string; assigned_to: string | null } | undefined;
  const from = await conv(fromId);
  const into = await conv(intoId);
  if (from && !into) {
    await client.query('UPDATE conversations SET contact_id = $2 WHERE id = $1', [from.id, intoId]);
  } else if (from && into) {
    const [a, b] = [from.id, into.id];
    // one open inquiry at a time: the older open one (the id-only thread) is closed before it moves
    await client.query(`UPDATE cases SET closed_at = now() WHERE conversation_id = $1 AND closed_at IS NULL AND EXISTS (SELECT 1 FROM cases WHERE conversation_id = $2 AND closed_at IS NULL)`, [a, b]);
    await client.query('UPDATE cases SET conversation_id = $2 WHERE conversation_id = $1', [a, b]);
    await client.query(`UPDATE messages m SET conversation_id = $2 WHERE m.conversation_id = $1 AND (m.external_id IS NULL OR NOT EXISTS (SELECT 1 FROM messages x WHERE x.conversation_id = $2 AND x.external_id = m.external_id))`, [a, b]);
    await client.query('UPDATE conversation_notes SET conversation_id = $2 WHERE conversation_id = $1', [a, b]);
    await client.query('UPDATE scheduled_messages SET conversation_id = $2 WHERE conversation_id = $1', [a, b]);
    await client.query('UPDATE form_requests SET conversation_id = $2 WHERE conversation_id = $1', [a, b]);
    await client.query('INSERT INTO conversation_tags (conversation_id, tag_id) SELECT $2, tag_id FROM conversation_tags WHERE conversation_id = $1 ON CONFLICT DO NOTHING', [a, b]);
    await client.query('INSERT INTO conversation_stars (user_id, conversation_id) SELECT user_id, $2 FROM conversation_stars WHERE conversation_id = $1 ON CONFLICT DO NOTHING', [a, b]);
    await client.query(`UPDATE forward_log f SET conversation_id = $2 WHERE f.conversation_id = $1 AND NOT (f.trigger = 'handoff' AND EXISTS (SELECT 1 FROM forward_log x WHERE x.conversation_id = $2 AND x.rule_id = f.rule_id AND x.trigger = 'handoff'))`, [a, b]);
    // the thread: open if either was, the person who held either, unread counts added up, the latest activity
    await client.query(
      `UPDATE conversations c SET status = CASE WHEN o.status = 'open' THEN 'open' ELSE c.status END,
              assigned_to = COALESCE(c.assigned_to, o.assigned_to), unread_count = c.unread_count + o.unread_count,
              last_message_at = GREATEST(c.last_message_at, o.last_message_at)
         FROM conversations o WHERE c.id = $2 AND o.id = $1`, [a, b]);
    await client.query('DELETE FROM conversations WHERE id = $1', [a]);   // what is left are duplicates (cascade)
  }
  // the person's details: what the number contact lacks comes from the id-only one; a block or opt-out on either stays
  await client.query(
    `UPDATE contacts p SET display_name = COALESCE(p.display_name, f.display_name), profile = f.profile || p.profile,
            blocked = p.blocked OR f.blocked, blocked_at = COALESCE(p.blocked_at, f.blocked_at), blocked_reason = COALESCE(p.blocked_reason, f.blocked_reason),
            opted_out = p.opted_out OR f.opted_out, opted_out_at = COALESCE(p.opted_out_at, f.opted_out_at), person_id = COALESCE(p.person_id, f.person_id)
       FROM contacts f WHERE p.id = $2 AND f.id = $1`, [fromId, intoId]);
  await client.query('DELETE FROM contacts WHERE id = $1', [fromId]);
  await client.query('UPDATE contacts SET user_id = $2 WHERE id = $1 AND user_id IS NULL', [intoId, userId]);
  const target = (await client.query('SELECT id FROM conversations WHERE contact_id = $1', [intoId])).rows[0]?.id as string | undefined;
  if (from && target) {
    await client.query('INSERT INTO conversation_notes (conversation_id, body) VALUES ($1, $2)', [target,
      into ? 'הלקוח פנה בעבר עם שם משתמש בווצאפ בלי מספר טלפון, ועכשיו גם עם המספר: שתי השיחות אוחדו לשיחה אחת (כל ההודעות, ההערות והתגיות נשמרו).'
        : 'הלקוח פנה עד עכשיו עם שם משתמש בווצאפ בלי מספר טלפון. עכשיו המספר ידוע, והשיחה משויכת אליו.']);
  }
}

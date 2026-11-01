import type { Db } from '../db.js';

/** What an event says about a stored message. Phone numbers / platform ids are never included; the contact has an internal id and a display name. */
export async function messageEventData(db: Db, conversationId: string, messageId: string) {
  const { rows } = await db.query(
    `SELECT c.id AS cid, c.status, c.assigned_to, ch.id AS channel_id, ch.type AS channel_type, ct.id AS contact_id, ct.display_name,
            m.id AS mid, m.direction, m.body, m.auto, m.created_at, m.sender_user_id
       FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN channels ch ON ch.id = c.channel_id JOIN contacts ct ON ct.id = c.contact_id
      WHERE m.id = $1 AND c.id = $2`, [messageId, conversationId]);
  const r = rows[0];
  if (!r) return null;
  return {
    conversation: { id: r.cid, status: r.status, assignedTo: r.assigned_to, channelId: r.channel_id, channelType: r.channel_type },
    contact: { id: r.contact_id, name: r.display_name },
    message: { id: r.mid, direction: r.direction as 'in' | 'out', text: r.body as string, auto: r.auto as boolean, createdAt: r.created_at, senderUserId: r.sender_user_id },
  };
}

export async function conversationEventData(db: Db, conversationId: string) {
  const { rows } = await db.query(
    `SELECT c.id, c.status, c.assigned_to, ch.id AS channel_id, ch.type AS channel_type, ct.id AS contact_id, ct.display_name
       FROM conversations c JOIN channels ch ON ch.id = c.channel_id JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = $1`, [conversationId]);
  const r = rows[0];
  return r ? { conversation: { id: r.id, status: r.status, assignedTo: r.assigned_to, channelId: r.channel_id, channelType: r.channel_type }, contact: { id: r.contact_id, name: r.display_name } } : null;
}

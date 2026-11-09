import { PolicyRejected, SendError } from './channels/sender.js';
import type { ChannelManager } from './channels/manager.js';
import { loadSending } from './channels/sender.js';
import { sendBlock } from './access.js';
import { renderCanned } from './canned.js';
import type { Db } from './db.js';
import { loadBusinessHours } from './routes/settings.js';

const GIVE_UP_AFTER_MS = 6 * 3600_000;   // a due message that still cannot go (channel offline / rate cap) is dropped after this

/**
 * Send scheduled messages that are due. Every send re-applies the same policy as a manual reply:
 * blocked, opted-out, outside the reply window => failed with the reason; channel offline or rate-capped => retried next minute.
 */
export async function sendDueScheduled(db: Db, mgr: ChannelManager): Promise<number> {
  const client = await db.connect();
  let due: { id: string }[];
  try {
    await client.query('BEGIN');
    due = (await client.query(
      `UPDATE scheduled_messages SET attempts = attempts + 1
        WHERE id IN (SELECT id FROM scheduled_messages WHERE status = 'pending' AND send_at <= now() ORDER BY send_at LIMIT 20 FOR UPDATE SKIP LOCKED)
        RETURNING id`)).rows;
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => undefined); throw e; } finally { client.release(); }
  let sent = 0;
  const hours = await loadBusinessHours(db);
  const sending = await loadSending(db);
  for (const { id } of due) {
    const r = (await db.query(
      `SELECT s.id, s.body, s.send_at, s.created_by, u.name AS "agentName", c.id AS conv_id, c.channel_id, ct.external_id, ct.display_name, ct.blocked, ct.opted_out, ch.type AS channel_type, ch.label AS channel_label, c.assigned_to
         FROM scheduled_messages s JOIN conversations c ON c.id = s.conversation_id JOIN contacts ct ON ct.id = c.contact_id JOIN channels ch ON ch.id = c.channel_id
         LEFT JOIN users u ON u.id = s.created_by WHERE s.id = $1 AND s.status = 'pending'`, [id])).rows[0];
    if (!r) continue;
    const fail = (code: string) => db.query(`UPDATE scheduled_messages SET status = 'failed', error = $2 WHERE id = $1`, [id, code]);
    const block = await sendBlock(db, { id: r.conv_id, channel_id: r.channel_id, assigned_to: r.assigned_to, status: 'open', external_id: r.external_id, blocked: r.blocked, opted_out: r.opted_out, channel_type: r.channel_type }, sending.replyWindowHours);
    if (block) { await fail(block); continue; }
    const text = renderCanned(r.body, { customerName: r.display_name, agentName: r.agentName ?? '', hours, channelLabel: r.channel_label, now: new Date() });
    try {
      const out = await mgr.sendText(r.channel_id, r.external_id, text);
      // It has gone out: record that first, so a bookkeeping error below can never cause a second send.
      await db.query(`UPDATE scheduled_messages SET status = 'sent', sent_at = now(), error = NULL WHERE id = $1`, [id]);
      sent++;
      const m = (await db.query(
        `INSERT INTO messages (conversation_id, direction, body, external_id, sender_user_id) VALUES ($1,'out',$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`,
        [r.conv_id, text, out.externalMessageId ?? null, r.created_by])).rows[0];
      await db.query(`UPDATE conversations SET last_message_at = now() WHERE id = $1`, [r.conv_id]);
      if (m) { mgr.notifyMessage(r.channel_id, r.conv_id, m.id); mgr.hookMessage('message.sent', r.conv_id, m.id); }
    } catch (e) {
      if ((await db.query(`SELECT status FROM scheduled_messages WHERE id = $1`, [id])).rows[0]?.status === 'sent') continue;
      const code = e instanceof PolicyRejected || e instanceof SendError ? e.code : (e as Error).message === 'channel_not_connected' ? 'channel_not_connected' : 'send_failed';
      const transient = code === 'channel_not_connected' || e instanceof SendError;
      if (transient && Date.now() - new Date(r.send_at).getTime() < GIVE_UP_AFTER_MS) continue;   // try again next round
      await fail(transient ? `expired_${code}` : code);
    }
  }
  return sent;
}

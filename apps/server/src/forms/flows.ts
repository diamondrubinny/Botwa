import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { buildFlowJson, flowStartData, initialsOf, parseFlowReply } from './flowjson.js';
import { byToken, createRequest, dateHe, deliverSignedCopy, event, getTemplate, sha256, submit, type CopyOut, type CopyStore, type StoredFlow, type TemplateRow } from './service.js';

/**
 * Forms filled inside WhatsApp (WhatsApp Flows, official channel, no endpoint). One published Flow per template version and
 * channel; each request carries its own random token (flow_token) and prefilled values. The answers arrive in the chat as an
 * nfm_reply message from the same number, are checked like the web form's, and become the same locked PDF with its record page.
 */

/** What the forms module needs from a running official channel (WhatsAppCloudAdapter). */
export interface FlowApi {
  flowCreate(name: string, json: unknown): Promise<{ id: string; errors: string[] }>;
  flowGet(id: string): Promise<{ status: string; errors: string[]; previewUrl: string | null }>;
  flowPublish(id: string): Promise<void>;
  flowRetire(id: string, published: boolean): Promise<void>;
}
export interface FlowSender extends CopyOut {
  sendFlow(channelId: string, ext: string, f: { flowId: string; token: string; body: string; cta: string; data?: Record<string, string> }): Promise<{ externalMessageId?: string }>;
  sendText(channelId: string, ext: string, text: string, opts?: { background?: boolean }): Promise<{ externalMessageId?: string }>;
}

export class FlowProblem extends Error {
  constructor(readonly key: string, readonly detail?: string) { super(key); }
}

/** The Flow JSON of the template as it is now, and its version (a change of fields or short labels needs a new Flow). */
export function currentBuild(t: Pick<TemplateRow, 'title' | 'fields' | 'flowLabels'>) {
  const b = buildFlowJson(t.title, t.fields, t.flowLabels);
  return { ...b, version: sha256(JSON.stringify(b.json)).slice(0, 16) };
}

/** The template's Flow on a channel, with whether it matches the template as it is now. */
export function flowState(t: TemplateRow, channelId: string): { flow: StoredFlow | null; upToDate: boolean; ready: boolean } {
  const f = t.flows?.[channelId] ?? null;
  const upToDate = !!f && f.version === currentBuild(t).version;
  return { flow: f, upToDate, ready: upToDate && f!.status === 'PUBLISHED' };
}

async function saveFlow(db: Db, templateId: string, channelId: string, f: StoredFlow | null): Promise<void> {
  await db.query(`UPDATE form_templates SET flows = CASE WHEN $3::jsonb IS NULL THEN flows - $2 ELSE jsonb_set(flows, ARRAY[$2], $3::jsonb) END WHERE id = $1`, [templateId, channelId, f ? JSON.stringify(f) : null]);
}

/** Create and publish the template's Flow on a channel (a previous draft is removed; a previous published one keeps serving sent requests). Meta's validation errors are kept and shown. */
export async function publishFlow(db: Db, api: FlowApi, templateId: string, channelId: string): Promise<StoredFlow> {
  const t = await getTemplate(db, templateId);
  if (!t || !t.active) throw new FlowProblem('template_not_found');
  if (!t.flowEnabled) throw new FlowProblem('flow_disabled');
  const b = currentBuild(t);
  if (b.problems.length) throw new FlowProblem(b.problems[0]!);
  if (!Object.keys(b.names).length && !t.fields.some((f) => f.type === 'signature' || f.type === 'initials')) throw new FlowProblem('template_has_no_fields');
  const prev = t.flows?.[channelId];
  const created = await api.flowCreate(`${t.title} (${b.version.slice(0, 6)})`, b.json);
  const info = await api.flowGet(created.id).catch(() => ({ status: created.errors.length ? 'DRAFT' : 'PUBLISHED', errors: created.errors, previewUrl: null }));
  const f: StoredFlow = { flowId: created.id, status: info.status, version: b.version, names: b.names, errors: created.errors.length ? created.errors : info.errors, previewUrl: info.previewUrl, at: new Date().toISOString() };
  await saveFlow(db, t.id, channelId, f);
  // a published Flow stays: requests already sent with it must still open (Meta: a deprecated Flow cannot be opened);
  // each request keeps its own field names, so its answers are read right. Only a failed draft is removed.
  if (prev && prev.flowId !== f.flowId && prev.status !== 'PUBLISHED') await api.flowRetire(prev.flowId, false);
  return f;
}

/** Re-read the Flow's status from Meta (it can be blocked, throttled or deprecated there). */
export async function refreshFlow(db: Db, api: FlowApi, t: TemplateRow, channelId: string): Promise<StoredFlow | null> {
  const f = t.flows?.[channelId];
  if (!f) return null;
  const info = await api.flowGet(f.flowId);
  const next = { ...f, status: info.status, errors: info.errors, previewUrl: info.previewUrl ?? f.previewUrl };
  await saveFlow(db, t.id, channelId, next);
  return next;
}

/** Send a form to fill inside WhatsApp from a conversation on the official channel. */
export async function sendFlowRequest(db: Db, cfg: Config, out: FlowSender, a: { templateId: string; conversationId: string; userId: string; days: number; values?: Record<string, string>; note?: string }): Promise<{ id: string; number: number; messageId: string }> {
  const t = await getTemplate(db, a.templateId);
  if (!t || !t.active) throw new FlowProblem('template_not_found');
  if (!t.flowEnabled) throw new FlowProblem('flow_disabled');
  const ch = (await db.query(`SELECT c.channel_id, ch.type FROM conversations c JOIN channels ch ON ch.id = c.channel_id WHERE c.id = $1`, [a.conversationId])).rows[0] as { channel_id: string; type: string } | undefined;
  if (!ch) throw new FlowProblem('not_found');
  if (ch.type !== 'whatsapp_cloud') throw new FlowProblem('flow_needs_official_channel');
  const st = flowState(t, ch.channel_id);
  if (!st.flow) throw new FlowProblem('flow_not_published');
  if (!st.upToDate) throw new FlowProblem('flow_outdated');
  if (!st.ready) throw new FlowProblem('flow_not_published', st.flow.status);
  const r = await createRequest(db, cfg, a);
  await db.query(`UPDATE form_requests SET via = 'flow', flow_names = $2 WHERE id = $1`, [r.id, JSON.stringify(st.flow!.names)]);
  const body = flowMessage(r.conv.display_name, r.title, r.expires, a.note);
  let sent: { externalMessageId?: string };
  try {
    sent = await out.sendFlow(r.conv.channel_id, r.conv.external_id, { flowId: st.flow!.flowId, token: r.token, body, cta: 'מילוי הטופס', data: flowStartData(t.fields, st.flow!.names, r.prefill) });
  } catch (e) {
    await db.query('DELETE FROM form_requests WHERE id = $1', [r.id]);
    throw e;
  }
  const m = await db.query(`INSERT INTO messages (conversation_id, direction, body, external_id, sender_user_id) VALUES ($1,'out',$2,$3,$4) RETURNING id`, [r.conv.id, body, sent.externalMessageId ?? null, a.userId]);
  await db.query(`UPDATE conversations SET last_message_at = now(), assigned_to = COALESCE(assigned_to, $2), bot_state = 'human' WHERE id = $1`, [r.conv.id, a.userId]);
  await event(db, r.id, 'sent', `נשלח למילוי בתוך ווצאפ, בתוקף עד ${dateHe(r.expires)}`);
  out.notifyMessage(r.conv.channel_id, r.conv.id, m.rows[0].id);
  return { id: r.id, number: r.number, messageId: m.rows[0].id };
}

export function flowMessage(name: string | null, title: string, expires: Date, note?: string): string {
  const hello = name && !/^\+?\d+$/.test(name) ? `שלום ${name},` : 'שלום,';
  return [hello, `נא למלא ולחתום על "${title}" כאן בווצאפ, בלחיצה על הכפתור.`, `בתוקף עד ${dateHe(expires)}.`, note?.trim() ?? ''].filter(Boolean).join('\n');
}

/**
 * A Flow reply arrived in a conversation. Checked: the token belongs to a Flow request of the same conversation, it is still
 * open, the statement was confirmed and the name typed, and every value passes the same checks as the web form.
 */
export async function receiveFlowReply(db: Db, cfg: Config, out: FlowSender, store: CopyStore, a: { conversationId: string; channelId: string; externalContactId: string; messageId: string; responseJson: string; org: string }): Promise<'signed' | 'ignored' | 'invalid' | 'closed'> {
  const say = async (text: string) => {
    try {
      const sent = await out.sendText(a.channelId, a.externalContactId, text, { background: true });
      const m = await db.query(`INSERT INTO messages (conversation_id, direction, body, external_id, auto) VALUES ($1,'out',$2,$3,true) RETURNING id`, [a.conversationId, text, sent.externalMessageId ?? null]);
      out.notifyMessage(a.channelId, a.conversationId, m.rows[0].id);
    } catch { /* the team sees the note */ }
  };
  const note = (body: string) => db.query('INSERT INTO conversation_notes (conversation_id, body) VALUES ($1, $2)', [a.conversationId, body]).catch(() => undefined);
  const pre = parseFlowReply(a.responseJson, {});
  const r = pre?.token ? await byToken(db, pre.token) : null;
  // only a Flow request sent to this very conversation: a token from elsewhere is ignored (and noted)
  if (!r || r.via !== 'flow' || r.conversation_id !== a.conversationId || !r.flow_names) { await note('התקבלה תשובת טופס מווצאפ שאינה שייכת לבקשה פתוחה בשיחה הזו. היא לא נשמרה כחתימה.'); return 'ignored'; }
  if (r.status === 'signed') { await say(`הטופס "${r.title}" כבר נחתם. אין צורך לשלוח שוב.`); return 'closed'; }
  if (!['sent', 'opened', 'verified'].includes(r.status)) { await say(`הבקשה לחתימה על "${r.title}" כבר לא בתוקף. אפשר לבקש מאיתנו לשלוח אותה שוב.`); await event(db, r.id, 'flow_late'); return 'closed'; }
  const reply = parseFlowReply(a.responseJson, r.flow_names)!;
  const signs = r.fields.filter((f) => f.type === 'signature' || f.type === 'initials');
  if (!reply.consent || (signs.length && (!reply.signer || reply.signer.length < 2))) {
    await event(db, r.id, 'flow_invalid', 'missing consent or name');
    await say('לא התקבל אישור ההצהרה או השם המלא לחתימה. אפשר לפתוח שוב את הטופס מההודעה הקודמת ולשלוח מחדש.');
    return 'invalid';
  }
  const marks = Object.fromEntries(signs.map((f) => [f.id, { typed: f.type === 'initials' ? initialsOf(reply.signer!) : reply.signer! }]));
  const identity = `מולא ונחתם בתוך ווצאפ, מהחשבון של השיחה שאליה נשלח (הודעה ${a.messageId.slice(0, 8)})`;
  const res = await submit(db, cfg, { ...r, signer_name: reply.signer ?? r.signer_name, verified_at: new Date() }, { values: reply.values, marks, ip: null, ua: 'WhatsApp Flow', org: a.org, identity });
  if (!res.ok) {
    if (res.errors._ === 'already_signed') return 'closed';
    const bad = Object.keys(res.errors).map((id) => r.fields.find((f) => f.id === id)?.label ?? id).slice(0, 6);
    await event(db, r.id, 'flow_invalid', bad.join(', ').slice(0, 200));
    await say(`חלק מהפרטים חסרים או לא תקינים (${bad.join(', ')}). אפשר לפתוח שוב את הטופס מההודעה הקודמת, לתקן ולשלוח.`);
    return 'invalid';
  }
  await db.query(`UPDATE form_requests SET signer_name = COALESCE($2, signer_name) WHERE id = $1`, [r.id, reply.signer]);
  await deliverSignedCopy(db, out, store, r, res.pdf);
  await note(`✍️ הטופס "${r.title}" (בקשה ${r.number}) מולא ונחתם בתוך ווצאפ. אפשר להוריד אותו מ"טפסים" או מפרטי השיחה.`);
  return 'signed';
}

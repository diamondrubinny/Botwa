import { createHash, randomInt } from 'node:crypto';
import { audit } from '../audit.js';
import type { Db } from '../db.js';
import { safetyReport, safetyReportText } from '../safety/report.js';
import { inspectionsSummary } from '../safety/inspections.js';
import { permissionsOfRole } from '../routes/users.js';

/**
 * Betty for managers on WhatsApp: a linked manager asks about the inquiries (how many are open, who holds what, the topics, how
 * long they wait) and gets a short answer in the chat.
 *  - Linking: a one-time code made in the panel (signed in), sent from the manager's WhatsApp: proof of both, valid 10 minutes.
 *  - Who: users who may see every conversation and the reports (inbox.view_all + reports.view), checked again on every message;
 *    a deactivated user or a changed role loses it at once.
 *  - What: case numbers, topics, handlers and times only. Customers' names, numbers and messages never go to a personal phone.
 *  - The questions are not stored as a customer conversation and never reach the bot; each one is audited.
 */
export const NEEDED = ['inbox.view_all', 'reports.view'] as const;
const CODE = /^\s*botwa[-\s]?(\d{8})\s*$/i;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export async function mayAsk(db: Db, userId: string): Promise<boolean> {
  const u = (await db.query('SELECT role, active, must_change_password FROM users WHERE id = $1', [userId])).rows[0] as { role: string; active: boolean; must_change_password: boolean } | undefined;
  if (!u?.active || u.must_change_password) return false;   // a reset password: the account is being recovered
  const perms = await permissionsOfRole(db, u.role);
  return !!perms && NEEDED.every((p) => perms.includes(p));
}

/** A new code for the signed-in user (replaces an older one). Shown once in the panel. */
export async function newLinkCode(db: Db, userId: string): Promise<{ code: string; expiresAt: Date }> {
  const code = `BOTWA-${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;   // 8 digits, single use, 10 minutes
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  await db.query(`INSERT INTO staff_link_codes (user_id, code_hash, expires_at) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at`, [userId, sha(code.slice(6)), expiresAt]);
  return { code, expiresAt };
}

/** Wrong codes from one WhatsApp account: at most 5 an hour (the code has a million values and lives 10 minutes). */
const tries = new Map<string, { n: number; at: number }>();
/** Guessing codes: 5 tries an hour per sender, and 30 wrong codes an hour from everyone together (many numbers guessing at once). */
let wrong: number[] = [];
function tooMany(key: string): boolean {
  const now = Date.now();
  for (const [k, v] of tries) if (now - v.at > 3_600_000) tries.delete(k);   // the map never grows without bound
  wrong = wrong.filter((t) => now - t < 3_600_000);
  if (wrong.length >= 30) return true;
  const t = tries.get(key);
  if (!t) { tries.set(key, { n: 1, at: now }); return false; }
  t.n++;
  return t.n > 5;
}
const failedCode = () => { wrong.push(Date.now()); };

/** Remove a person's WhatsApp/Telegram links to Betty and any open code (sign-out everywhere, password or second-factor reset). */
export async function revokeStaffLinks(db: Db, userId: string): Promise<void> {
  await db.query('DELETE FROM staff_links WHERE user_id = $1', [userId]);
  await db.query('DELETE FROM staff_link_codes WHERE user_id = $1', [userId]);
}

/** A linked account asks at most 20 questions a minute. */
const asked = new Map<string, number[]>();
function tooManyQueries(linkId: string): boolean {
  const now = Date.now();
  const list = (asked.get(linkId) ?? []).filter((t) => now - t < 60_000);
  list.push(now);
  asked.set(linkId, list);
  return list.length > 20;
}

const ago = (from: Date) => {
  const m = Math.max(0, Math.round((Date.now() - from.getTime()) / 60_000));
  return m < 60 ? `${m} דק׳` : m < 48 * 60 ? `${Math.round(m / 60)} שע׳` : `${Math.round(m / 1440)} ימים`;
};

const OPEN = `FROM conversations c
  LEFT JOIN LATERAL (SELECT k.number, k.opened_at FROM cases k WHERE k.conversation_id = c.id AND k.closed_at IS NULL ORDER BY k.opened_at DESC LIMIT 1) k ON true
  LEFT JOIN LATERAL (SELECT m.direction FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) last ON true
  LEFT JOIN users u ON u.id = c.assigned_to
  WHERE c.status = 'open'`;
const SINCE = `COALESCE(k.opened_at, c.created_at)`;
const TOPICS = `(SELECT string_agg(t.name, ', ' ORDER BY t.name) FROM conversation_tags x JOIN tags t ON t.id = x.tag_id WHERE x.conversation_id = c.id)`;
const WHO = `COALESCE(u.name_he, u.name)`;
const STATE = `CASE WHEN c.assigned_to IS NOT NULL THEN 'assigned' WHEN c.bot_state IS DISTINCT FROM 'human' THEN 'bot' ELSE 'waiting' END`;

const HELP = `אפשר לשאול אותי:
1. מצב – סיכום הקריאות הפתוחות
2. נציגים – מה אצל כל אחד
3. נושאים – הקריאות לפי נושא
4. ותיקות – 10 הקריאות שפתוחות הכי הרבה זמן
5. דחוף – קריאות דחופות
6. שלי – הקריאות אצלך
7. בטיחות – חירום, מפגעים ולקוחות לחוצים בשבוע האחרון, וזמני המענה
8. בדיקות – בדיקות תקופתיות באיחור ובשבועיים הקרובים
"ניתוק" – הפסקת הקישור של הווצאפ הזה.`;

async function summary(db: Db): Promise<string> {
  const r = (await db.query(`SELECT count(*)::int AS open,
      count(*) FILTER (WHERE ${STATE} = 'assigned')::int AS assigned, count(*) FILTER (WHERE ${STATE} = 'waiting')::int AS waiting, count(*) FILTER (WHERE ${STATE} = 'bot')::int AS bot,
      count(*) FILTER (WHERE last.direction = 'in' AND ${STATE} <> 'bot')::int AS unanswered,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM conversation_tags x JOIN tags t ON t.id = x.tag_id WHERE x.conversation_id = c.id AND lower(t.name) = 'דחוף'))::int AS urgent,
      min(${SINCE}) AS oldest ${OPEN}`)).rows[0];
  const today = (await db.query(`SELECT count(*) FILTER (WHERE opened_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Jerusalem') AT TIME ZONE 'Asia/Jerusalem')::int AS opened,
      count(*) FILTER (WHERE closed_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Jerusalem') AT TIME ZONE 'Asia/Jerusalem')::int AS closed FROM cases`)).rows[0];
  if (!r.open) return `אין קריאות פתוחות כרגע 🎉\nהיום: ${today.opened} נפתחו, ${today.closed} נסגרו.`;
  return [`📊 ${r.open} קריאות פתוחות`,
    `• אצל נציגים: ${r.assigned}`, `• ממתינות לשיוך: ${r.waiting}`, `• בטיפול הבוט: ${r.bot}`,
    `• מחכות לתשובה מאיתנו: ${r.unanswered}`, ...(r.urgent ? [`• 🚨 דחופות: ${r.urgent}`] : []),
    `הוותיקה ביותר פתוחה ${ago(new Date(r.oldest))}.`, `היום: ${today.opened} נפתחו, ${today.closed} נסגרו.`].join('\n');
}

async function byAgent(db: Db): Promise<string> {
  const rows = (await db.query(`SELECT ${WHO} AS who, count(*)::int AS n, count(*) FILTER (WHERE last.direction = 'in')::int AS unanswered, min(${SINCE}) AS oldest
      ${OPEN} AND c.assigned_to IS NOT NULL GROUP BY 1 ORDER BY n DESC LIMIT 20`)).rows;
  const waiting = (await db.query(`SELECT count(*)::int AS n ${OPEN} AND c.assigned_to IS NULL AND c.bot_state = 'human'`)).rows[0].n;
  if (!rows.length) return `אין קריאות אצל נציגים.${waiting ? `\n${waiting} ממתינות לשיוך.` : ''}`;
  return ['👥 לפי נציג:', ...rows.map((r) => `• ${r.who}: ${r.n} פתוחות${r.unanswered ? `, ${r.unanswered} מחכות לתשובה` : ''} (הוותיקה ${ago(new Date(r.oldest))})`),
    ...(waiting ? [`• ממתינות לשיוך: ${waiting}`] : [])].join('\n');
}

async function byTopic(db: Db): Promise<string> {
  const rows = (await db.query(`SELECT t.name, count(*)::int AS n, min(${SINCE}) AS oldest ${OPEN.replace('WHERE c.status', 'JOIN conversation_tags x ON x.conversation_id = c.id JOIN tags t ON t.id = x.tag_id WHERE c.status')}
      GROUP BY t.name ORDER BY n DESC LIMIT 15`)).rows;
  const none = (await db.query(`SELECT count(*)::int AS n ${OPEN} AND NOT EXISTS (SELECT 1 FROM conversation_tags x WHERE x.conversation_id = c.id)`)).rows[0].n;
  if (!rows.length && !none) return 'אין קריאות פתוחות.';
  return ['🏷️ לפי נושא:', ...rows.map((r) => `• ${r.name}: ${r.n} (הוותיקה ${ago(new Date(r.oldest))})`), ...(none ? [`• בלי נושא: ${none}`] : [])].join('\n');
}

const STATE_HE: Record<string, string> = { assigned: '', waiting: 'ממתינה לשיוך', bot: 'בטיפול הבוט' };
async function list(db: Db, where: string, params: unknown[], title: string, empty: string): Promise<string> {
  const rows = (await db.query(`SELECT k.number, ${SINCE} AS since, ${WHO} AS who, ${STATE} AS state, ${TOPICS} AS topics, last.direction AS last ${OPEN} ${where} ORDER BY ${SINCE} LIMIT 10`, params)).rows;
  if (!rows.length) return empty;
  return [title, ...rows.map((r) => `• ${r.number ? `#${r.number}` : 'קריאה'} · ${r.topics ?? 'בלי נושא'} · ${r.who ?? STATE_HE[r.state]} · ${ago(new Date(r.since))}${r.last === 'in' && r.state !== 'bot' ? ' · מחכה לתשובה' : ''}`)].join('\n');
}

/** The answer to a manager's message. */
export async function answerManager(db: Db, userId: string, text: string): Promise<string> {
  const t = text.trim().replace(/[?!.]+$/g, '').toLowerCase();
  if (/^(עזרה|תפריט|help|\?|היי|שלום|בטי|הי)$/.test(t)) return HELP;
  if (t === '1' || /מצב|סטטוס|סיכום|כמה/.test(t)) return summary(db);
  if (t === '2' || /נציג|אצל מי|צוות|מי מטפל/.test(t)) return byAgent(db);
  if (t === '3' || /נושא/.test(t)) return byTopic(db);
  if (t === '4' || /ותיק|ישנ|רשימ|פתוחות|הכי הרבה זמן|ממתינ/.test(t)) return list(db, '', [], '⏳ הקריאות שפתוחות הכי הרבה זמן:', 'אין קריאות פתוחות.');
  if (t === '5' || /דחוף|חירום/.test(t)) return list(db, `AND EXISTS (SELECT 1 FROM conversation_tags x JOIN tags tg ON tg.id = x.tag_id WHERE x.conversation_id = c.id AND lower(tg.name) = 'דחוף')`, [], '🚨 קריאות דחופות:', 'אין קריאות דחופות פתוחות.');
  if (t === '8' || /בדיק/.test(t)) return inspectionsSummary(db);
  if (t === '7' || /בטיחות|מפגע|שבוע|לחוצ/.test(t)) return safetyReportText(await safetyReport(db, 7));
  if (t === '6' || /שלי|אצלי/.test(t)) return list(db, 'AND c.assigned_to = $1', [userId], '📋 הקריאות אצלך:', 'אין קריאות פתוחות אצלך.');
  return `${await summary(db)}\n\n${HELP}`;
}

/**
 * A WhatsApp message from a linked manager (or a linking code): returns the reply to send, or null when the message is a
 * customer's (the normal flow goes on). Never stored as a conversation.
 */
export async function staffMessage(db: Db, channelId: string, externalId: string, text: string | null, appUrl: string): Promise<string | null> {
  const link = (await db.query('SELECT id, user_id FROM staff_links WHERE channel_id = $1 AND external_id = $2', [channelId, externalId])).rows[0] as { id: string; user_id: string } | undefined;
  if (!text) return link ? 'אני עונה כאן רק על הודעות טקסט. כתבו "עזרה" לרשימת השאלות.' : null;
  const code = CODE.exec(text)?.[1];
  if (!link && !code) return null;
  if (!link && code) {
    if (tooMany(`${channelId}:${externalId}`)) return 'יותר מדי ניסיונות. נסו שוב בעוד שעה.';
    const row = (await db.query(`DELETE FROM staff_link_codes WHERE code_hash = $1 AND expires_at > now() RETURNING user_id`, [sha(code)])).rows[0] as { user_id: string } | undefined;
    if (!row) failedCode();
    if (!row) return 'הקוד שגוי או שפג תוקפו. אפשר ליצור קוד חדש בפאנל: החשבון שלי ← בטי בווצאפ.';
    if (!(await mayAsk(db, row.user_id))) return 'לחשבון הזה אין הרשאה לשאול על הקריאות (צריך גישה לכל השיחות ולדוחות).';
    await db.query(`INSERT INTO staff_links (user_id, channel_id, external_id) VALUES ($1,$2,$3) ON CONFLICT (channel_id, external_id) DO UPDATE SET user_id = EXCLUDED.user_id, created_at = now()`, [row.user_id, channelId, externalId]);
    await audit(db, { actorId: row.user_id, action: 'staff.whatsapp_link', meta: { channel: channelId } });
    return `הווצאפ הזה קושר לחשבון שלך ✅\n\n${HELP}\n\nפרטי לקוחות לא נשלחים לכאן. לפרטים מלאים: ${appUrl}`;
  }
  if (!(await mayAsk(db, link!.user_id))) {
    await db.query('DELETE FROM staff_links WHERE id = $1', [link!.id]);
    return 'אין יותר הרשאה לשאול על הקריאות, והקישור של הווצאפ הזה הוסר.';
  }
  if (/^\s*ניתוק\s*$/.test(text)) {
    await db.query('DELETE FROM staff_links WHERE id = $1', [link!.id]);
    await audit(db, { actorId: link!.user_id, action: 'staff.whatsapp_unlink', meta: { channel: channelId, by: 'whatsapp' } });
    return 'הקישור הוסר. מעכשיו הודעות מהמספר הזה יטופלו כמו פנייה רגילה.';
  }
  if (tooManyQueries(link!.id)) return 'יותר מדי שאלות בדקה האחרונה. נסו שוב בעוד רגע.';
  await db.query('UPDATE staff_links SET last_used_at = now() WHERE id = $1', [link!.id]);
  await audit(db, { actorId: link!.user_id, action: 'staff.whatsapp_query', meta: { channel: channelId, q: text.slice(0, 40) } });
  return answerManager(db, link!.user_id, text);
}

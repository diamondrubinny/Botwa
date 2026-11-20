import { randomInt } from 'node:crypto';
import type { Db } from '../db.js';

/**
 * QR stickers on lab doors. Each place (building, room, description) has a short code; scanning the sticker opens the website chat
 * (with ?place=CODE) or WhatsApp (with the code in the first message), and Betty then knows where the person is: the "exact place"
 * question is filled, and the building/room too when the person did not give them before. The code is an identifier, not a
 * secret: a forged code only changes the place field of that conversation.
 */
export const PLACE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O, 1/I: easy to read off a sticker
export const PLACE_CODE = /^[A-HJ-NP-Z2-9]{6}$/;
/** a place applies to the conversation's bot for this long after the scan */
export const PLACE_TTL_MS = 24 * 60 * 60 * 1000;

export function newPlaceCode(): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += PLACE_ALPHABET[randomInt(PLACE_ALPHABET.length)];
  return s;
}

/** "📍K7M2QX" (the WhatsApp text the sticker prefills) or "קוד מיקום: K7M2QX" typed by hand, anywhere in the message. */
const IN_TEXT = /\(?\s*(?:📍|קוד\s*מיקום\s*:?)\s*([A-HJ-NP-Z2-9]{6})\s*\)?/u;
export function extractPlaceCode(text: string | null | undefined): { code: string; rest: string } | null {
  if (!text) return null;
  const m = IN_TEXT.exec(text);
  if (!m) return null;
  return { code: m[1]!, rest: text.replace(m[0], ' ').replace(/\s+/g, ' ').trim() };
}

export interface Place { id: string; code: string; building: string; room: string; label: string; active: boolean }

/** How a place reads to people: "מעבדה לכימיה אורגנית, בניין שרמן, חדר 214". */
export function placeText(p: Pick<Place, 'building' | 'room' | 'label'>): string {
  return [p.label, p.building && `בניין ${p.building}`, p.room && `חדר ${p.room}`].filter(Boolean).join(', ');
}

/** The active place of a code, or null. */
export async function findPlace(db: Db, code: string): Promise<Place | null> {
  if (!PLACE_CODE.test(code)) return null;
  const r = (await db.query(`SELECT id, code, building, room, label, active FROM qr_places WHERE code = $1`, [code])).rows[0] as Place | undefined;
  return r?.active ? r : null;
}

/**
 * The conversation came from a sticker: remembered on it (with the time) and noted for the team once per sticker. Returns the
 * place, or null for an unknown or inactive code.
 */
export async function notePlace(db: Db, convId: string, code: string): Promise<Place | null> {
  const p = await findPlace(db, code);
  if (!p) return null;
  const prev = (await db.query(`UPDATE conversations c SET place_id = $2, place_at = now() FROM (SELECT place_id AS old FROM conversations WHERE id = $1) o WHERE c.id = $1 RETURNING o.old`, [convId, p.id])).rows[0] as { old: string | null } | undefined;
  if (prev && prev.old !== p.id) {
    await db.query(`INSERT INTO conversation_notes (conversation_id, body) VALUES ($1, $2)`, [convId, `📍 הפנייה נפתחה ממדבקת QR: ${placeText(p)} (קוד ${p.code}).`]);
  }
  return p;
}

/** The place the bot should use for this conversation: scanned within the last 24 hours, still active. */
export async function conversationPlace(db: Db, convId: string): Promise<Place | null> {
  const r = (await db.query(
    `SELECT p.id, p.code, p.building, p.room, p.label, p.active FROM conversations c JOIN qr_places p ON p.id = c.place_id
      WHERE c.id = $1 AND p.active AND c.place_at > now() - make_interval(secs => $2)`, [convId, PLACE_TTL_MS / 1000],
  )).rows[0] as Place | undefined;
  return r ?? null;
}

/** The flow variables a place fills: the exact place always, building and room when set on the sticker. */
export function placeVars(p: Place): Record<string, string> {
  return { where: placeText(p), ...(p.building ? { building: p.building } : {}), ...(p.room ? { room: p.room } : {}) };
}

import { z } from 'zod';
import type { Db } from './db.js';

/** 3-30 characters: lower-case letters, digits, dot, dash, underscore; starts and ends with a letter or digit. */
export const usernameSchema = z.string().trim().toLowerCase().transform((s) => s.replace(/^@/, '')).pipe(z.string().regex(/^[a-z0-9][a-z0-9._-]{1,28}[a-z0-9]$/));

/**
 * The active account a spreadsheet cell or a typed value means: "@dana", "dana" (username) or "dana@example.com" (e-mail).
 * Null when nobody matches.
 */
export async function resolveUserRef(db: Db, raw: string): Promise<string | null> {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  const { rows } = v.includes('@') && !v.startsWith('@')
    ? await db.query('SELECT id FROM users WHERE lower(email) = $1 AND active', [v])
    : await db.query('SELECT id FROM users WHERE lower(username) = $1 AND active', [v.replace(/^@/, '')]);
  return (rows[0]?.id as string | undefined) ?? null;
}

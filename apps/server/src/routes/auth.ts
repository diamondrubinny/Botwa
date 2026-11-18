import type { FastifyInstance } from 'fastify';
import { authenticator } from 'otplib';
import { z } from 'zod';
import { audit } from '../audit.js';
import { revokeStaffLinks } from '../staff/assistant.js';
import { BUILTIN_ROLES } from '../permissions.js';
import { needsMfaEnrollment, requireAuth, SESSION_COOKIE, startSession } from '../auth.js';
import type { Config } from '../config.js';
import { decrypt, encrypt, newToken, sha256 } from '../crypto.js';
import type { Db } from '../db.js';
import { dummyVerify, hashPassword, PASSWORD_MIN, verifyPassword } from '../password.js';

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

const loginBody = z.object({
  email: z.string().email().max(254).transform((s) => s.toLowerCase()),
  password: z.string().min(1).max(256),
  totp: z.string().regex(/^\d{6}$/).optional(),
  /** stay signed in on this device (longer, renewed while in use) */
  remember: z.boolean().optional(),
});

export function authRoutes(app: FastifyInstance, db: Db, cfg: Config) {
  // Enrolment endpoints must stay reachable for privileged users who still have to set up MFA.
  const auth = requireAuth(db, undefined, { allowEnrollment: true });
  const invalid = { error: 'invalid_credentials' };

  app.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = loginBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const { email, password, totp } = body.data;

    const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    const u = rows[0];
    if (!u || !u.active) {
      await dummyVerify(password);
      await audit(db, { action: 'login.fail', target: email, ip: req.ip });
      return reply.code(401).send(invalid);
    }
    if (u.locked_until && new Date(u.locked_until) > new Date()) {
      // Same response as a wrong password: do not reveal that the account exists or is locked.
      await dummyVerify(password);
      await audit(db, { actorId: u.id, action: 'login.locked', ip: req.ip });
      return reply.code(401).send(invalid);
    }

    let ok = await verifyPassword(u.password_hash, password);
    if (ok && u.totp_enabled) {
      if (!totp) return reply.code(401).send({ error: 'mfa_required' });
      ok = await acceptTotp(db, u.id, totp, decrypt(u.totp_secret_enc, cfg.ENCRYPTION_KEY));
    } else if (ok && (await passkeyOnlySecondFactor(db, u.id, u.role))) {
      // the role requires a second factor and this person's only one is a passkey: a password alone must not open the account
      await audit(db, { actorId: u.id, action: 'login.passkey_required', ip: req.ip });
      return reply.code(401).send({ error: 'passkey_required' });
    }
    if (!ok) {
      // Single atomic statement: concurrent guesses cannot read the same counter value.
      const upd = await db.query(
        `UPDATE users
            SET failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END,
                locked_until  = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
          WHERE id = $1 RETURNING (failed_logins = 0) AS locked`,
        [u.id, MAX_FAILS, LOCK_MINUTES],
      );
      const lock = upd.rows[0]?.locked === true;
      await audit(db, { actorId: u.id, action: lock ? 'login.lockout' : 'login.fail', ip: req.ip });
      return reply.code(401).send(invalid);
    }

    await db.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [u.id]);
    await startSession(db, cfg, req, reply, u.id, !!body.data.remember);
    await audit(db, { actorId: u.id, action: 'login.success', ip: req.ip });
    return { ok: true };
  });

  app.post('/auth/logout', { preHandler: auth }, async (req, reply) => {
    await db.query('DELETE FROM sessions WHERE id = $1', [req.user!.sessionId]);
    await audit(db, { actorId: req.user!.id, action: 'logout', ip: req.ip });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  // Sign out everywhere (e.g. a lost phone): every session of this user, this one included.
  app.post('/auth/logout-all', { preHandler: auth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const r = await db.query('DELETE FROM sessions WHERE user_id = $1', [req.user!.id]);
    await revokeStaffLinks(db, req.user!.id);   // "sign out everywhere" includes the WhatsApp link to Betty
    await audit(db, { actorId: req.user!.id, action: 'logout_all', ip: req.ip, meta: { sessions: r.rowCount } });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true, sessions: r.rowCount };
  });

  app.get('/auth/me', { preHandler: auth }, async (req) => {
    const u = req.user!;
    const av = await db.query('SELECT available, username, job_title AS "jobTitle", job_title_en AS "jobTitleEn", job_title_ar AS "jobTitleAr", job_title_ru AS "jobTitleRu", intro_phone AS "introPhone", name_he AS "nameHe", (SELECT floor(extract(epoch FROM a.updated_at))::float8 FROM user_avatars a WHERE a.user_id = users.id) AS "avatarV" FROM users WHERE id = $1', [u.id]);
    return {
      available: av.rows[0]?.available ?? true,
      username: av.rows[0]?.username as string | undefined,
      jobTitle: (av.rows[0]?.jobTitle as string | null) ?? null,
      jobTitleEn: (av.rows[0]?.jobTitleEn as string | null) ?? null,
      jobTitleAr: (av.rows[0]?.jobTitleAr as string | null) ?? null,
      jobTitleRu: (av.rows[0]?.jobTitleRu as string | null) ?? null,
      nameHe: (av.rows[0]?.nameHe as string | null) ?? null,
      introPhone: (av.rows[0]?.introPhone as string | null) ?? null,
      avatarV: av.rows[0]?.avatarV != null ? Number(av.rows[0].avatarV) : null,
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      roleName: u.roleName,
      permissions: u.permissions,
      mfaEnabled: u.totpEnabled,
      passkeys: u.passkeys,
      mfaEnrollmentRequired: cfg.REQUIRE_MFA_FOR_PRIVILEGED && needsMfaEnrollment(u),
      passwordChangeRequired: u.mustChangePassword,
    };
  });

  // What a person shows the customer when they take an inquiry ("כאן דנה, ממונת בטיחות"): their own role and an optional work phone.
  app.put('/auth/me/intro', { preHandler: requireAuth(db), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({
      nameHe: z.string().trim().max(100).nullable().optional().refine((v) => !v || (v.length >= 2 && /[א-ת]/.test(v)), 'hebrew'),   // omitted = keep
      jobTitle: z.string().trim().max(80).transform((v) => v.replace(/[\r\n]+/g, ' ') || null).nullable(),
      // the role in English / Arabic for conversations in those languages (omitted = keep, empty = none)
      jobTitleEn: z.string().trim().max(80).transform((v) => v.replace(/[\r\n]+/g, ' ') || null).nullable().optional(),
      jobTitleAr: z.string().trim().max(80).transform((v) => v.replace(/[\r\n]+/g, ' ') || null).nullable().optional(),
      jobTitleRu: z.string().trim().max(80).transform((v) => v.replace(/[\r\n]+/g, ' ') || null).nullable().optional(),
      introPhone: z.string().trim().max(20).nullable().refine((v) => !v || /^\+?[0-9][0-9 -]{5,18}[0-9]$/.test(v), 'phone').transform((v) => v || null),
    }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    const r = await db.query(`UPDATE users SET job_title = $2, intro_phone = $3, name_he = CASE WHEN $5::boolean THEN $4 ELSE name_he END,
        job_title_en = CASE WHEN $7::boolean THEN $6 ELSE job_title_en END, job_title_ar = CASE WHEN $9::boolean THEN $8 ELSE job_title_ar END,
        job_title_ru = CASE WHEN $11::boolean THEN $10 ELSE job_title_ru END, updated_at = now()
      WHERE id = $1 RETURNING name_he, job_title_en, job_title_ar, job_title_ru`,
      [req.user!.id, b.data.jobTitle, b.data.introPhone, b.data.nameHe || null, b.data.nameHe !== undefined, b.data.jobTitleEn ?? null, b.data.jobTitleEn !== undefined, b.data.jobTitleAr ?? null, b.data.jobTitleAr !== undefined, b.data.jobTitleRu ?? null, b.data.jobTitleRu !== undefined]);
    return { nameHe: r.rows[0]?.name_he ?? null, jobTitle: b.data.jobTitle, jobTitleEn: r.rows[0]?.job_title_en ?? null, jobTitleAr: r.rows[0]?.job_title_ar ?? null, jobTitleRu: r.rows[0]?.job_title_ru ?? null, introPhone: b.data.introPhone };
  });

  // Agents mark themselves on/off duty (affects automatic routing only).
  app.post('/auth/availability', { preHandler: requireAuth(db) }, async (req, reply) => {
    const b = z.object({ available: z.boolean() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    await db.query('UPDATE users SET available = $2 WHERE id = $1', [req.user!.id, b.data.available]);
    return { available: b.data.available };
  });

  app.post('/auth/password', { preHandler: auth, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = z.object({ current: z.string().max(256), next: z.string().min(PASSWORD_MIN).max(256) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user!.id]);
    if (!(await verifyPassword(rows[0].password_hash, body.data.current))) return reply.code(401).send(invalid);
    if (body.data.next === body.data.current) return reply.code(400).send({ error: 'password_unchanged' });
    await db.query('UPDATE users SET password_hash = $2, must_change_password = false, updated_at = now() WHERE id = $1', [
      req.user!.id,
      await hashPassword(body.data.next),
    ]);
    await db.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [req.user!.id, req.user!.sessionId]);
    await revokeStaffLinks(db, req.user!.id);
    await audit(db, { actorId: req.user!.id, action: 'password.change', ip: req.ip });
    return { ok: true };
  });

  app.post('/auth/mfa/setup', { preHandler: auth }, async (req, reply) => {
    if (req.user!.totpEnabled) return reply.code(409).send({ error: 'mfa_already_enabled' });
    const secret = authenticator.generateSecret();
    await db.query('UPDATE users SET totp_secret_enc = $2 WHERE id = $1', [req.user!.id, encrypt(secret, cfg.ENCRYPTION_KEY)]);
    return { secret, otpauthUrl: authenticator.keyuri(req.user!.email, 'Botwa', secret) };
  });

  app.post('/auth/mfa/enable', { preHandler: auth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = z.object({ code: z.string().regex(/^\d{6}$/) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const { rows } = await db.query('SELECT totp_secret_enc FROM users WHERE id = $1', [req.user!.id]);
    const enc = rows[0]?.totp_secret_enc;
    if (!enc || !(await acceptTotp(db, req.user!.id, body.data.code, decrypt(enc, cfg.ENCRYPTION_KEY)))) {
      return reply.code(400).send({ error: 'invalid_code' });
    }
    await db.query('UPDATE users SET totp_enabled = true WHERE id = $1', [req.user!.id]);
    await db.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [req.user!.id, req.user!.sessionId]);
    await audit(db, { actorId: req.user!.id, action: 'mfa.enable', ip: req.ip });
    return { ok: true };
  });
}

/**
 * A TOTP code accepted once only: the code's time step must be newer than the last accepted one (stops replaying a code that
 * was seen, within its validity window). The step is stored atomically, so two simultaneous uses of one code cannot both pass.
 */
export async function acceptTotp(db: Db, userId: string, code: string, secret: string): Promise<boolean> {
  const delta = authenticator.checkDelta(code, secret);
  if (delta === null) return false;
  const step = Math.floor(Date.now() / 1000 / (authenticator.allOptions().step ?? 30)) + delta;
  const r = await db.query('UPDATE users SET totp_last_step = $2 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2) RETURNING id', [userId, step]);
  return (r.rowCount ?? 0) > 0;
}

/** The role requires a second factor and the person has passkeys but no authenticator app: sign in with the passkey. */
async function passkeyOnlySecondFactor(db: Db, userId: string, role: string): Promise<boolean> {
  const r = (await db.query(
    `SELECT r.builtin, r.mfa_required, (SELECT count(*)::int FROM passkeys p WHERE p.user_id = $1) AS passkeys FROM roles r WHERE r.key = $2`, [userId, role])).rows[0];
  if (!r || r.passkeys === 0) return false;
  const builtin = BUILTIN_ROLES[role];
  return r.builtin && builtin ? builtin.mfaRequired : !!r.mfa_required;
}

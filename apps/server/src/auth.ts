import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { newToken, sha256 } from './crypto.js';
import { BUILTIN_ROLES, can, cleanPermissions, type Permission } from './permissions.js';

export const SESSION_COOKIE = 'botwa_sid';
export type Role = string; // role key: built-in 'admin' | 'supervisor' | 'agent' or a custom role

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  roleName: string;
  permissions: Permission[];
  /** the role demands a second factor (TOTP or passkey) */
  mfaRequired: boolean;
  totpEnabled: boolean;
  passkeys: number;
  /** an administrator reset the password: until the person sets their own, nothing else is allowed */
  mustChangePassword: boolean;
  sessionId: string;
  sessionExpires: Date;
  sessionCreated: Date;
  sessionRemember: boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** REQUIRE_MFA_FOR_PRIVILEGED: admins/supervisors without TOTP are blocked from everything except enrolment. */
    mfaEnforced: boolean;
    /** session lengths, for renewing a session that is in use */
    sessionCfg: Config;
  }
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export async function loadSession(db: Db, token: string): Promise<AuthUser | null> {
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.name, u.role, u.totp_enabled, u.must_change_password, s.id AS session_id, s.expires_at, s.created_at AS session_created, s.remember,
            r.name AS role_name, r.permissions, r.builtin, r.mfa_required,
            (SELECT count(*)::int FROM passkeys p WHERE p.user_id = u.id) AS passkeys
       FROM sessions s JOIN users u ON u.id = s.user_id JOIN roles r ON r.key = u.role
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`,
    [sha256(token)],
  );
  const r = rows[0];
  if (!r) return null;
  const builtin = BUILTIN_ROLES[r.role];
  const permissions = r.builtin && builtin ? builtin.permissions : cleanPermissions(r.permissions);
  return {
    id: r.id, email: r.email, name: r.name, role: r.role, roleName: builtin?.name ?? r.role_name, permissions,
    mfaRequired: r.builtin && builtin ? builtin.mfaRequired : r.mfa_required, totpEnabled: r.totp_enabled, passkeys: r.passkeys, mustChangePassword: r.must_change_password, sessionId: r.session_id, sessionExpires: new Date(r.expires_at), sessionCreated: new Date(r.session_created), sessionRemember: !!r.remember,
  };
}

/** preHandler factory: authenticates via session cookie and optionally restricts roles. */
/** preHandler: authenticated + (optionally) holds the permission. Roles are just named sets of permissions. */
export function requireAuth(db: Db, perm?: Permission, opts?: { allowEnrollment?: boolean }) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies[SESSION_COOKIE];
    const user = token ? await loadSession(db, token) : null;
    if (!user) return reply.code(401).send({ error: 'unauthenticated' });
    if (!opts?.allowEnrollment && req.server.mfaEnforced && needsMfaEnrollment(user)) {
      return reply.code(403).send({ error: 'mfa_enrollment_required' });
    }
    await renewSession(db, req.server.sessionCfg, reply, token!, user).catch(() => undefined);
    if (!opts?.allowEnrollment && user.mustChangePassword) return reply.code(403).send({ error: 'password_change_required' });
    if (perm && !can(user, perm)) return reply.code(403).send({ error: 'forbidden' });
    req.user = user;
  };
}

/** Create a server-side session for the user and set the cookie (used by password and passkey login). */
export const sessionHours = (cfg: Pick<Config, 'SESSION_TTL_HOURS' | 'SESSION_REMEMBER_DAYS'>, remember: boolean): number => (remember ? cfg.SESSION_REMEMBER_DAYS * 24 : cfg.SESSION_TTL_HOURS);

export async function startSession(db: Db, cfg: Config, req: FastifyRequest, reply: FastifyReply, userId: string, remember = false): Promise<void> {
  const token = newToken();
  const hours = sessionHours(cfg, remember);
  await db.query(
    `INSERT INTO sessions (user_id, token_hash, ip, user_agent, expires_at, remember) VALUES ($1,$2,$3,$4, now() + make_interval(hours => $5), $6)`,
    [userId, sha256(token), req.ip, (req.headers['user-agent'] ?? '').slice(0, 300), hours, remember],
  );
  reply.setCookie(SESSION_COOKIE, token, { ...cookieOptions(cfg), maxAge: hours * 3600 });
}

/**
 * A sign-in that is in use does not run out: once half of its time has passed, the session and the cookie are renewed for the full
 * time again (so a panel that is open, or used every day, stays signed in). It never goes past the absolute cap counted from the sign-in,
 * and an unused session still ends after its normal time.
 */
export async function renewSession(db: Db, cfg: Config, reply: FastifyReply, token: string, u: AuthUser): Promise<void> {
  const ttl = sessionHours(cfg, u.sessionRemember) * 3_600_000;
  const now = Date.now();
  if (u.sessionExpires.getTime() - now > ttl / 2) return;
  const next = Math.min(now + ttl, u.sessionCreated.getTime() + cfg.SESSION_MAX_DAYS * 86_400_000);
  if (next <= u.sessionExpires.getTime() + 60_000) return;
  await db.query('UPDATE sessions SET expires_at = $2 WHERE id = $1', [u.sessionId, new Date(next)]);
  reply.setCookie(SESSION_COOKIE, token, { ...cookieOptions(cfg), maxAge: Math.floor((next - now) / 1000) });
}

export function cookieOptions(cfg: Config) {
  return {
    httpOnly: true,
    secure: cfg.COOKIE_SECURE,
    sameSite: 'strict' as const,
    path: '/',
    maxAge: cfg.SESSION_TTL_HOURS * 3600,
  };
}

/** A role that requires a second factor but the user has neither TOTP nor a passkey yet. */
export const needsMfaEnrollment = (u: Pick<AuthUser, 'mfaRequired' | 'totpEnabled' | 'passkeys'>) => u.mfaRequired && !u.totpEnabled && u.passkeys === 0;

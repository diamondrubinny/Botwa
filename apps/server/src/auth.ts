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
}

declare module 'fastify' {
  interface FastifyInstance {
    /** REQUIRE_MFA_FOR_PRIVILEGED: admins/supervisors without TOTP are blocked from everything except enrolment. */
    mfaEnforced: boolean;
  }
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export async function loadSession(db: Db, token: string): Promise<AuthUser | null> {
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.name, u.role, u.totp_enabled, u.must_change_password, s.id AS session_id,
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
    mfaRequired: r.builtin && builtin ? builtin.mfaRequired : r.mfa_required, totpEnabled: r.totp_enabled, passkeys: r.passkeys, mustChangePassword: r.must_change_password, sessionId: r.session_id,
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
    if (!opts?.allowEnrollment && user.mustChangePassword) return reply.code(403).send({ error: 'password_change_required' });
    if (perm && !can(user, perm)) return reply.code(403).send({ error: 'forbidden' });
    req.user = user;
  };
}

/** Create a server-side session for the user and set the cookie (used by password and passkey login). */
export async function startSession(db: Db, cfg: Config, req: FastifyRequest, reply: FastifyReply, userId: string): Promise<void> {
  const token = newToken();
  await db.query(
    `INSERT INTO sessions (user_id, token_hash, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4, now() + make_interval(hours => $5))`,
    [userId, sha256(token), req.ip, (req.headers['user-agent'] ?? '').slice(0, 300), cfg.SESSION_TTL_HOURS],
  );
  reply.setCookie(SESSION_COOKIE, token, cookieOptions(cfg));
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

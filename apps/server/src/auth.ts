import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { sha256 } from './crypto.js';

export const SESSION_COOKIE = 'botwa_sid';
export type Role = 'admin' | 'supervisor' | 'agent';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  totpEnabled: boolean;
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export async function loadSession(db: Db, token: string): Promise<AuthUser | null> {
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.name, u.role, u.totp_enabled, s.id AS session_id
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`,
    [sha256(token)],
  );
  const r = rows[0];
  if (!r) return null;
  return { id: r.id, email: r.email, name: r.name, role: r.role, totpEnabled: r.totp_enabled, sessionId: r.session_id };
}

/** preHandler factory: authenticates via session cookie and optionally restricts roles. */
export function requireAuth(db: Db, roles?: Role[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies[SESSION_COOKIE];
    const user = token ? await loadSession(db, token) : null;
    if (!user) return reply.code(401).send({ error: 'unauthenticated' });
    if (roles && !roles.includes(user.role)) return reply.code(403).send({ error: 'forbidden' });
    req.user = user;
  };
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

export const isPrivileged = (role: Role) => role === 'admin' || role === 'supervisor';

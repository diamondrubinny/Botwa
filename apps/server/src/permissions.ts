/** Fine-grained permissions. Roles are named sets of these; the three built-in roles reproduce the original admin/supervisor/agent behaviour. */
export const PERMISSIONS = [
  'inbox.view_all',            // see every conversation (without it: only own + unassigned)
  'conversations.assign_others', // assign conversations to other people
  'contacts.block',            // block / unblock customers, restore opt-in
  'tags.manage',
  'canned.manage',
  'reports.view',
  'channels.view',             // channel list, health, emergency pause
  'channels.manage',           // create / link (QR) / stop / delete channels
  'users.view',
  'users.manage',              // create / edit / deactivate users, reset MFA
  'roles.manage',
  'bot.view',
  'bot.manage',
  'settings.view',
  'settings.manage',           // business hours, routing, sending limits
  'audit.view',
  'privacy.manage',            // export / erase a customer's data
  'backups.manage',
  'api.manage',                // API keys and outgoing webhooks (integrations)
  'safety.view',               // SafetyBoard: search the standards by topic, and see standard suggestions inside conversations
  'kb.manage',                 // knowledge base: add/edit documents, links and FAQ, synonyms, search tests
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const known = new Set<string>(PERMISSIONS);
export const isPermission = (p: string): p is Permission => known.has(p);
export const cleanPermissions = (list: unknown): Permission[] => (Array.isArray(list) ? list.filter((p): p is Permission => typeof p === 'string' && known.has(p)) : []);

export const BUILTIN_ROLES: Record<string, { name: string; permissions: Permission[]; mfaRequired: boolean }> = {
  admin: { name: 'מנהל', permissions: [...PERMISSIONS], mfaRequired: true },
  supervisor: {
    name: 'מפקח',
    permissions: ['inbox.view_all', 'conversations.assign_others', 'contacts.block', 'tags.manage', 'canned.manage', 'reports.view', 'channels.view', 'users.view', 'bot.view', 'settings.view', 'kb.manage', 'safety.view'],
    mfaRequired: true,
  },
  agent: { name: 'נציג', permissions: [], mfaRequired: false },
};

export const can = (u: { permissions: readonly string[] }, p: Permission): boolean => u.permissions.includes(p);
/** A user may grant only what they hold themselves (no privilege escalation through role management). */
export const isSubset = (perms: readonly string[], of: readonly string[]): boolean => perms.every((p) => of.includes(p));

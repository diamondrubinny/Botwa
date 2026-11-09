export class ApiError extends Error {
  constructor(public status: number, public code: string, public problems?: string[], public detail?: string) {
    super(code);
  }
}

export async function api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, res.status === 429 ? 'rate_limited' : ((data as { error?: string }).error ?? 'error'), (data as { problems?: string[] }).problems, typeof (data as { detail?: unknown }).detail === 'string' ? (data as { detail: string }).detail : undefined);
  return data as T;
}

export type Role = string; // role key: admin | supervisor | agent | custom (r_xxxx)
export interface Me {
  available?: boolean; id: string; email: string; username?: string; avatarV?: number | null; name: string; role: Role; roleName: string; permissions: string[]; passkeys: number;
  mfaEnabled: boolean; mfaEnrollmentRequired: boolean; passwordChangeRequired?: boolean;
}
export const can = (me: Pick<Me, 'permissions'>, p: string) => me.permissions.includes(p);
export interface RoleRow { key: string; name: string; permissions: string[]; builtin: boolean; mfaRequired: boolean; userCount: number }
export interface PasskeyRow { id: string; name: string; deviceType: string | null; backedUp: boolean; createdAt: string; lastUsedAt: string | null }
export interface UserRow { available?: boolean; id: string; email: string; username?: string; avatarV?: number | null; name: string; role: Role; active: boolean; mfaEnabled: boolean }
export interface Channel { id: string; type: 'whatsapp' | 'whatsapp_cloud' | 'telegram' | 'webchat'; label: string; status: string }
export interface Conversation {
  id: string; channelId: string; status: 'open' | 'closed'; assignedTo: string | null; assignedName: string | null;
  unreadCount: number; lastMessageAt: string; contactName: string | null; contactId: string; contactRowId: string;
  channelLabel: string; channelType: string; lastMessage: string | null; waitingSince: string | null; botState: 'menu' | 'human' | null; blocked?: boolean; optedOut?: boolean; blockedReason?: string | null; tags: Tag[]; snoozedUntil?: string | null; starred?: boolean;
}
export interface Attachment { id: string; kind: string; mime: string | null; size: number | null; fileName: string | null; status: 'pending' | 'clean' | 'infected' | 'blocked'; detail: string | null }
export interface Tag { id: string; name: string }
export interface AuditRow { id: string; actorName: string | null; action: string; target: string | null; ip: string | null; createdAt: string }
export interface BusinessHours { enabled: boolean; timezone: string; days: ({ open: string; close: string } | null)[]; awayMessage: string }
export interface Message { id: string; auto?: boolean; direction: 'in' | 'out'; body: string; senderName: string | null; createdAt: string; attachment?: Attachment | null }

export async function upload(url: string, file: File, caption: string): Promise<void> {
  const fd = new FormData();
  if (caption.trim()) fd.append('caption', caption.trim());
  fd.append('file', file);
  const res = await fetch(url, { method: 'POST', credentials: 'same-origin', body: fd });
  if (!res.ok) throw new ApiError(res.status, ((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'error');
}
export interface Note { id: string; body: string; authorName: string | null; createdAt: string }
export interface Canned { id: string; title: string; body: string; folder: string }
export interface CannedVar { name: string; meaning: string }
export interface RelatedConv { id: string; status: string; lastMessageAt: string; channelLabel: string; channelType: string; contactName: string | null; assignedName: string | null; lastMessage: string | null }
export interface BackupFile { name: string; size: number; createdAt: string }
export interface ChannelHealth {
  id: string; label: string; type: string; status: string; sentLast24h: number; sentLastMinute: number; dailyCap: number; ageDays: number;
  warnings: string[]; events: { kind: string; at: string }[];
  inboundLast24h: number; paused: boolean; autoPausedUntil: string | null; risk: { level: 'low' | 'medium' | 'high'; reasons: string[] };
}
export interface SendingCfg { minDelayMs: number; maxDelayMs: number; perMinute: number; perDay: number; warmup: boolean; typing: boolean; replyWindowHours: number; failuresBeforePause: number; pauseMinutes: number; readReceipts: boolean }

/** "Dana Levi (@dana.levi)" for people pickers */
export const personLabel = (u: { name: string; username?: string | null }) => (u.username ? `${u.name} (@${u.username})` : u.name);

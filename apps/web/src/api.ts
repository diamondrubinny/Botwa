export class ApiError extends Error {
  constructor(public status: number, public code: string) {
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
  if (!res.ok) throw new ApiError(res.status, res.status === 429 ? 'rate_limited' : ((data as { error?: string }).error ?? 'error'));
  return data as T;
}

export type Role = 'admin' | 'supervisor' | 'agent';
export interface Me { available?: boolean; id: string; email: string; name: string; role: Role; mfaEnabled: boolean; mfaEnrollmentRequired: boolean }
export interface UserRow { available?: boolean; id: string; email: string; name: string; role: Role; active: boolean; mfaEnabled: boolean }
export interface Channel { id: string; type: 'whatsapp' | 'telegram'; label: string; status: string }
export interface Conversation {
  id: string; channelId: string; status: 'open' | 'closed'; assignedTo: string | null; assignedName: string | null;
  unreadCount: number; lastMessageAt: string; contactName: string | null; contactId: string; contactRowId: string;
  channelLabel: string; channelType: string; lastMessage: string | null; waitingSince: string | null; botState: 'menu' | 'human' | null; tags: Tag[];
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
export interface Canned { id: string; title: string; body: string }
export interface RelatedConv { id: string; status: string; lastMessageAt: string; channelLabel: string; channelType: string; contactName: string | null; assignedName: string | null; lastMessage: string | null }
export interface BackupFile { name: string; size: number; createdAt: string }

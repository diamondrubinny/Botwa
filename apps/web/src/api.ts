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
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? 'error');
  return data as T;
}

export type Role = 'admin' | 'supervisor' | 'agent';
export interface Me { id: string; email: string; name: string; role: Role; mfaEnabled: boolean; mfaEnrollmentRequired: boolean }
export interface UserRow { id: string; email: string; name: string; role: Role; active: boolean; mfaEnabled: boolean }
export interface Channel { id: string; type: 'whatsapp' | 'telegram'; label: string; status: string }
export interface Conversation {
  id: string; channelId: string; status: 'open' | 'closed'; assignedTo: string | null; assignedName: string | null;
  unreadCount: number; lastMessageAt: string; contactName: string | null; contactId: string;
  channelLabel: string; channelType: string; lastMessage: string | null;
}
export interface Message { id: string; direction: 'in' | 'out'; body: string; senderName: string | null; createdAt: string }
export interface Note { id: string; body: string; authorName: string | null; createdAt: string }
export interface Canned { id: string; title: string; body: string }

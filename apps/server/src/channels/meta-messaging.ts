import { timingSafeEqual } from 'node:crypto';
import type { MenuOption } from './cloud-messages.js';
import { PolicyRejected } from './sender.js';
import type { AdapterContext, ChannelAdapter, InboundMessage, OutboundMedia } from './types.js';
import { isGraphMediaUrl, metaCheckError, verifySignature } from './whatsapp-cloud.js';

/**
 * Facebook Messenger (a Page) and Instagram business messaging through Meta's Messenger Platform (Graph API).
 * Messages arrive by webhook (signed with the app secret) and go out through POST /{page-id}/messages with the Page access token.
 * Field names, permissions (pages_messaging, instagram_manage_messages, pages_manage_metadata), the 24-hour window and limits
 * follow Meta's documentation as known at the time of writing: all require verification against the official reference.
 */
export type MetaPlatform = 'messenger' | 'instagram';
export interface MetaCreds {
  pageId: string;
  pageAccessToken: string;
  appSecret: string;
  verifyToken: string;
  /** Instagram only: the Instagram professional account id linked to the Page (the webhook entry id) */
  igAccountId?: string;
  /** also take in comments on the Page's / account's posts (needs more permissions at Meta) */
  comments?: boolean;
}
/** A conversation that is a public comment thread rather than private messages (its contact id says so). */
export const isCommentContact = (externalContactId: string) => /@(fb|ig)comment$/.test(externalContactId);
export type CommentReplyMode = 'public' | 'private';
export const META_CREDS_KEY = 'meta';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
const GRAPH = 'https://graph.facebook.com';
/** Instagram's CDN in addition to Facebook's (attachment URLs come inside the signed webhook; still checked before download) */
const IG_MEDIA = /(^|\.)(cdninstagram\.com|fbcdn\.net|fbsbx\.com)$/;
const MAX_DOWNLOAD = 25 * 1024 * 1024;
/** Text limits per message (Messenger 2000, Instagram 1000 characters, per Meta's docs; verify) */
const TEXT_LIMIT: Record<MetaPlatform, number> = { messenger: 2000, instagram: 1000 };
/** "outside the messaging window" / "user cannot receive": a policy outcome, not a platform failure (codes per Meta's docs; verify) */
const POLICY_SUBCODES = new Set([2018278, 2018108, 2534022, 2018001]);
const POLICY_CODES = new Set([10, 551]);

interface MetaAttachment { type?: string; payload?: { url?: string; title?: string } }
interface MetaMessaging {
  sender?: { id?: string }; recipient?: { id?: string }; timestamp?: number;
  message?: { mid?: string; text?: string; is_echo?: boolean; is_deleted?: boolean; quick_reply?: { payload?: string }; attachments?: MetaAttachment[]; reply_to?: unknown };
  postback?: { mid?: string; title?: string; payload?: string };
  reaction?: { mid?: string; action?: 'react' | 'unreact'; emoji?: string; reaction?: string };
}
interface MetaChange {
  field?: string;
  value?: {
    item?: string; verb?: string; comment_id?: string; post_id?: string; parent_id?: string; message?: string; created_time?: number;
    from?: { id?: string; name?: string; username?: string }; post?: { permalink_url?: string };
    id?: string; text?: string; media?: { id?: string };   // Instagram comment
  };
}
export interface MetaWebhook { object?: string; entry?: { id?: string; time?: number; messaging?: MetaMessaging[]; changes?: MetaChange[] }[] }

export const isMetaMediaUrl = (raw: string): boolean => {
  if (isGraphMediaUrl(raw)) return true;
  try { const u = new URL(raw); return u.protocol === 'https:' && !u.username && !u.password && !u.port && IG_MEDIA.test(u.hostname); } catch { return false; }
};

/** Split a long text at paragraph, line or word boundaries so each part fits the platform's limit. */
export function splitText(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const cut = Math.max(rest.lastIndexOf('\n\n', max), rest.lastIndexOf('\n', max), rest.lastIndexOf(' ', max));
    const at = cut > max * 0.5 ? cut : max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export class MetaMessagingAdapter implements ChannelAdapter {
  private creds?: MetaCreds;
  private active = false;
  private names = new Map<string, string | null>();
  lastError: string | null = null;

  constructor(private readonly ctx: AdapterContext, readonly platform: MetaPlatform, private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i), private readonly version = 'v25.0') {}

  private url = (path: string) => `${GRAPH}/${this.version}/${path}`;
  private auth = () => ({ authorization: `Bearer ${this.creds!.pageAccessToken}` });
  private suffix = () => `@${this.platform}`;
  /** The id Meta puts in the webhook entry for this channel (the Page, or the Instagram account) */
  private entryId = () => (this.platform === 'instagram' ? this.creds?.igAccountId : this.creds?.pageId);

  async start(): Promise<void> {
    const { store, events } = this.ctx;
    const raw = await store.get(META_CREDS_KEY);
    if (!raw) { events.onStatus('logged_out'); return; }
    this.creds = JSON.parse(raw) as MetaCreds;
    events.onStatus('connecting');
    this.lastError = null;
    try {
      const target = this.platform === 'instagram' ? `${this.creds.igAccountId}?fields=username` : `${this.creds.pageId}?fields=name`;
      const res = await this.fetchImpl(this.url(target), { headers: this.auth(), signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: { code?: number } };
        const why = metaCheckError(res.status, j.error?.code);
        this.lastError = why === 'meta_phone_not_found' ? 'meta_page_not_found' : why;
        events.onStatus('error'); return;
      }
    } catch { this.lastError = 'meta_unreachable'; events.onStatus('error'); return; }
    this.active = true;
    events.onStatus('connected');
  }

  async stop(): Promise<void> { this.active = false; this.ctx.events.onStatus('stopped'); }
  async logout(): Promise<void> { this.active = false; await this.ctx.store.clear(); this.ctx.events.onStatus('logged_out'); }
  isActive(): boolean { return this.active; }
  checkSignature(raw: Buffer, header: string | undefined): boolean { return !!this.creds && verifySignature(this.creds.appSecret, raw, header); }

  verifyHandshake(mode: string | undefined, token: string | undefined, challenge: string | undefined): string | null {
    if (!this.creds || mode !== 'subscribe' || !token || !challenge || !/^[\w-]{1,100}$/.test(challenge)) return null;
    const a = Buffer.from(token), b = Buffer.from(this.creds.verifyToken);
    return a.length === b.length && timingSafeEqual(a, b) ? challenge : null;
  }

  /** Subscribe the Page to this app's webhooks (POST /{page-id}/subscribed_apps). Without it Meta delivers nothing. */
  async subscribeApp(): Promise<string> {
    if (!this.creds) return 'not_configured';
    const fields = `messages,messaging_postbacks,message_reactions${this.creds.comments && this.platform === 'messenger' ? ',feed' : ''}`;
    try {
      const res = await this.fetchImpl(this.url(`${this.creds.pageId}/subscribed_apps?subscribed_fields=${fields}`), { method: 'POST', headers: this.auth(), signal: AbortSignal.timeout(10_000) });
      const j = (await res.json().catch(() => ({}))) as { success?: boolean; error?: { code?: number } };
      if (res.ok && j.success !== false) return 'ok';
      const why = metaCheckError(res.status, j.error?.code);
      return why === 'meta_phone_not_found' ? 'meta_page_not_found' : why;
    } catch { return 'meta_unreachable'; }
  }

  async subscribedApps(): Promise<boolean | null> {
    if (!this.creds) return null;
    try {
      const res = await this.fetchImpl(this.url(`${this.creds.pageId}/subscribed_apps`), { headers: this.auth(), signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return null;
      const j = (await res.json().catch(() => ({}))) as { data?: unknown[] };
      return Array.isArray(j.data) ? j.data.length > 0 : null;
    } catch { return null; }
  }

  /** Signed webhook -> inbound messages. Our own sends (echoes), deletions and other objects are ignored. */
  async handleWebhook(payload: MetaWebhook): Promise<number> {
    const wantObject = this.platform === 'instagram' ? 'instagram' : 'page';
    if (payload.object !== wantObject) return 0;
    let n = 0;
    for (const entry of payload.entry ?? []) {
      if (entry.id && this.entryId() && entry.id !== this.entryId()) continue;   // another Page/account subscribed to the same app
      for (const ev of entry.messaging ?? []) {
        const from = ev.sender?.id;
        if (!from || !/^\d{5,40}$/.test(from) || from === this.entryId() || from === this.creds?.pageId) continue;
        const contact = `${from}${this.suffix()}`;
        if (ev.reaction) {
          if (ev.reaction.mid) this.ctx.events.onReaction?.({ externalContactId: contact, targetMessageId: ev.reaction.mid, emoji: ev.reaction.action === 'unreact' ? '' : (ev.reaction.emoji ?? '') });
          continue;
        }
        const msg = this.toInbound(ev, contact);
        if (!msg) continue;
        msg.contactName = await this.profileName(from);
        await this.ctx.events.onMessage(msg);
        n++;
      }
      if (this.creds?.comments) for (const ch of entry.changes ?? []) if (await this.handleComment(ch)) n++;
    }
    return n;
  }

  /** A new comment on one of our posts becomes a message in that commenter's comment thread. Our own replies, edits and removals are skipped. */
  private async handleComment(ch: MetaChange): Promise<boolean> {
    const v = ch.value;
    if (!v) return false;
    const fb = this.platform === 'messenger';
    if (fb ? (ch.field !== 'feed' || v.item !== 'comment' || v.verb !== 'add') : ch.field !== 'comments') return false;
    const commentId = fb ? v.comment_id : v.id;
    const from = v.from?.id;
    const text = (fb ? v.message : v.text) ?? '';
    if (!commentId || !/^[\d_]{3,80}$/.test(commentId) || !from || !/^\d{3,40}$/.test(from) || from === this.creds?.pageId || from === this.creds?.igAccountId) return false;
    const link = fb && v.post?.permalink_url && /^https:\/\/(www\.)?facebook\.com\//.test(v.post.permalink_url) ? v.post.permalink_url : null;
    await this.ctx.events.onMessage({
      externalContactId: `${from}@${fb ? 'fbcomment' : 'igcomment'}`,
      contactName: (v.from?.name ?? v.from?.username)?.slice(0, 100),
      externalMessageId: commentId,
      text: `${text.slice(0, 8000)}\n\n(תגובה ציבורית על פוסט${link ? `: ${link}` : fb ? '' : ' באינסטגרם'})`,
      timestamp: v.created_time ? new Date(v.created_time * 1000) : new Date(),
    });
    return true;
  }

  /**
   * Answer a comment. public: a reply under the comment that everyone sees; private: one private message to its author
   * (Meta allows one, within a few days of the comment). Endpoints per Meta's Graph API docs; verify against the current reference.
   */
  async replyComment(commentId: string, text: string, mode: CommentReplyMode): Promise<{ externalMessageId?: string }> {
    if (!this.creds || !this.active) throw new Error('channel_not_connected');
    if (mode === 'private') {
      const out = await this.send({ recipient: { comment_id: commentId }, message: { text: text.slice(0, TEXT_LIMIT[this.platform]) } });
      return { externalMessageId: out.message_id };
    }
    const path = this.platform === 'instagram' ? `${commentId}/replies` : `${commentId}/comments`;
    const res = await this.fetchImpl(this.url(path), { method: 'POST', headers: { ...this.auth(), 'content-type': 'application/json' }, body: JSON.stringify({ message: text.slice(0, 8000) }), signal: AbortSignal.timeout(15_000) });
    const j = (await res.json().catch(() => ({}))) as { id?: string; error?: { code?: number } };
    if (!res.ok) throw new Error(`meta_send_failed_${j.error?.code ?? res.status}`);
    return { externalMessageId: j.id };
  }

  /** Hide a comment from the public (it stays visible to its author and friends, per Meta). */
  async hideComment(commentId: string): Promise<void> {
    if (!this.creds || !this.active) throw new Error('channel_not_connected');
    const body = this.platform === 'instagram' ? { hide: true } : { is_hidden: true };
    const res = await this.fetchImpl(this.url(commentId), { method: 'POST', headers: { ...this.auth(), 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`meta_hide_failed_${res.status}`);
  }

  private toInbound(ev: MetaMessaging, contact: string): InboundMessage | null {
    const at = new Date(ev.timestamp && ev.timestamp > 1e11 ? ev.timestamp : Date.now());
    if (ev.postback) {
      // a tapped button: the option number we put in its payload, so the bot reads it like a typed number
      const id = ev.postback.mid ?? `pb_${contact}_${ev.timestamp ?? Date.now()}`;
      const p = ev.postback.payload ?? '';
      return { externalContactId: contact, externalMessageId: id, text: /^\d{1,2}$/.test(p) ? p : (ev.postback.title ?? p), timestamp: at };
    }
    const m = ev.message;
    if (!m?.mid || m.is_echo || m.is_deleted) return null;
    const qr = m.quick_reply?.payload;
    const att = (m.attachments ?? []).find((a) => a.payload?.url && ['image', 'video', 'audio', 'file'].includes(a.type ?? ''));
    const text = (qr && /^\d{1,2}$/.test(qr) ? qr : m.text) ?? (att ? '' : (m.attachments?.length ? '[unsupported message type]' : ''));
    const url = att?.payload?.url;
    return {
      externalContactId: contact, externalMessageId: m.mid, text, timestamp: at,
      media: url ? { fileName: att?.payload?.title, download: () => this.download(url) } : undefined,
    };
  }

  /** The person's display name (best effort; needs the profile permission, cached per server run). */
  private async profileName(id: string): Promise<string | undefined> {
    if (this.names.has(id)) return this.names.get(id) ?? undefined;
    let name: string | null = null;
    try {
      const fields = this.platform === 'instagram' ? 'name,username' : 'first_name,last_name';
      const res = await this.fetchImpl(this.url(`${id}?fields=${fields}`), { headers: this.auth(), signal: AbortSignal.timeout(5_000) });
      if (res.ok) {
        const j = (await res.json()) as { name?: string; username?: string; first_name?: string; last_name?: string };
        name = (j.name || [j.first_name, j.last_name].filter(Boolean).join(' ') || j.username || '').slice(0, 100) || null;
      }
    } catch { /* unknown name: shown as an id */ }
    if (this.names.size > 5000) this.names.clear();
    this.names.set(id, name);
    return name ?? undefined;
  }

  private async download(url: string): Promise<Buffer> {
    // Meta's attachment links may redirect to its CDN: follow at most 3 hops, each one checked against the allowed hosts
    let res: Response | null = null;
    for (let hop = 0; hop < 4; hop++) {
      if (!isMetaMediaUrl(url)) throw new Error('media_host_not_allowed');
      res = await this.fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
      const next = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!next) break;
      url = new URL(next, url).toString();
      res = null;
    }
    if (!res || !res.ok) throw new Error('media_download_failed');
    if (Number(res.headers.get('content-length') ?? 0) > MAX_DOWNLOAD) throw new Error('media_too_large');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_DOWNLOAD) throw new Error('media_too_large');
    return buf;
  }

  private async send(body: Record<string, unknown>, form?: FormData): Promise<{ message_id?: string }> {
    if (!this.creds || !this.active) throw new Error('channel_not_connected');
    const init: RequestInit = form
      ? { method: 'POST', headers: this.auth(), body: form, signal: AbortSignal.timeout(60_000) }
      : { method: 'POST', headers: { ...this.auth(), 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) };
    const res = await this.fetchImpl(this.url(`${this.creds.pageId}/messages`), init);
    const j = (await res.json().catch(() => ({}))) as { message_id?: string; error?: { code?: number; error_subcode?: number } };
    if (!res.ok) {
      const { code, error_subcode: sub } = j.error ?? {};
      if ((sub !== undefined && POLICY_SUBCODES.has(sub)) || (code !== undefined && POLICY_CODES.has(code))) throw new PolicyRejected('outside_reply_window');
      if (code === 190) { this.active = false; this.ctx.events.onStatus('error'); }
      throw new Error(`meta_send_failed_${code ?? res.status}`);
    }
    return j;
  }

  private recipient = (contact: string) => ({ id: contact.split('@')[0] });

  async sendText(externalContactId: string, text: string): Promise<{ externalMessageId?: string }> {
    if (isCommentContact(externalContactId)) throw new Error('comment_reply_mode_required');   // a person chooses public or private
    let last: { message_id?: string } = {};
    for (const part of splitText(text, TEXT_LIMIT[this.platform])) {
      last = await this.send({ recipient: this.recipient(externalContactId), messaging_type: 'RESPONSE', message: { text: part } });
    }
    return { externalMessageId: last.message_id };
  }

  /** A menu as quick replies (up to 13, titles up to 20 characters). Throws when it does not fit: the caller sends the numbered text. */
  async sendInteractive(externalContactId: string, body: string, options: MenuOption[]): Promise<{ externalMessageId?: string }> {
    if (options.length < 1 || options.length > 13 || body.length > TEXT_LIMIT[this.platform]) throw new Error('menu_not_supported');
    const quick_replies = options.map((o, i) => ({ content_type: 'text', title: o.title.length > 20 ? `${o.title.slice(0, 19)}…` : o.title, payload: String(i + 1) }));
    const out = await this.send({ recipient: this.recipient(externalContactId), messaging_type: 'RESPONSE', message: { text: body, quick_replies } });
    return { externalMessageId: out.message_id };
  }

  async sendMedia(externalContactId: string, media: OutboundMedia): Promise<{ externalMessageId?: string }> {
    if (isCommentContact(externalContactId)) throw new Error('media_unsupported');
    const type = media.mime.startsWith('image/') ? 'image' : media.mime.startsWith('video/') ? 'video' : media.mime.startsWith('audio/') ? 'audio' : 'file';
    if (this.platform === 'instagram' && type === 'file') throw new Error('media_unsupported');   // Instagram DMs take pictures, video and audio only (verify)
    const form = new FormData();
    form.append('recipient', JSON.stringify(this.recipient(externalContactId)));
    form.append('messaging_type', 'RESPONSE');
    form.append('message', JSON.stringify({ attachment: { type, payload: { is_reusable: false } } }));
    form.append('filedata', new Blob([new Uint8Array(media.buffer)], { type: media.mime }), media.fileName);
    const out = await this.send({}, form);
    if (media.caption) await this.sendText(externalContactId, media.caption);
    return { externalMessageId: out.message_id };
  }

  async typing(externalContactId: string, ms: number): Promise<void> {
    await this.send({ recipient: this.recipient(externalContactId), sender_action: 'typing_on' }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, ms));
  }

  async markRead(externalContactId: string): Promise<void> {
    await this.send({ recipient: this.recipient(externalContactId), sender_action: 'mark_seen' }).catch(() => undefined);
  }
}

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { buildInteractive, buildTemplate, buildTemplateCreate, summarizeTemplate, type CloudTemplate, type MenuOption, type TemplateSend } from './cloud-messages.js';
import { PolicyRejected } from './sender.js';
import type { AdapterContext, ChannelAdapter, InboundMessage, OutboundMedia } from './types.js';

/**
 * Official WhatsApp Business Platform (Cloud API). No QR and no ban-evasion concerns: a verified business number, an access token
 * and a webhook. Messages arrive by webhook (signed with the app secret) and go out through the Graph API.
 * Platform rules (24h customer-service window, templates, versions, error codes) must be verified against Meta's current docs.
 */
export interface CloudCreds { phoneNumberId: string; accessToken: string; appSecret: string; verifyToken: string; /** WhatsApp Business Account id: needed to read and create message templates */ wabaId?: string }
export const CLOUD_CREDS_KEY = 'cloud';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
const GRAPH = 'https://graph.facebook.com';
/** Hosts Meta serves media from; the download URL comes from an API response, so it is still validated before we send the token to it. */
const MEDIA_HOSTS = [/(^|\.)fbsbx\.com$/, /(^|\.)whatsapp\.net$/, /(^|\.)facebook\.com$/, /(^|\.)fbcdn\.net$/];
const MAX_DOWNLOAD = 30 * 1024 * 1024;
/** Error codes meaning "outside the allowed messaging window / not deliverable": a policy outcome, not a platform failure. */
const POLICY_CODES = new Set([131047, 131026, 131049, 131048, 130429]);

export const newVerifyToken = () => randomBytes(24).toString('base64url');

export function isGraphMediaUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && MEDIA_HOSTS.some((r) => r.test(u.hostname));
  } catch { return false; }
}

/**
 * The reason a credentials check failed, from the Graph API error code. Meta's codes as documented for the Graph API
 * (190 = access token invalid or expired, 100 = object not found or not accessible, 10/200-299 = permission,
 * 4/17/32/613/80007 = rate limits); requires verification against Meta's official documentation, which changes.
 */
export function metaCheckError(httpStatus: number, code: number | undefined): string {
  if (code === 190 || httpStatus === 401) return 'meta_auth_failed';
  if (code === 10 || (code !== undefined && code >= 200 && code <= 299)) return 'meta_permission_denied';
  if (code === 100 || code === 803 || httpStatus === 404) return 'meta_phone_not_found';
  if (code !== undefined && [4, 17, 32, 613, 80007].includes(code)) return 'meta_rate_limited';
  if (httpStatus === 403) return 'meta_permission_denied';
  return 'meta_check_failed';
}

export function verifySignature(appSecret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const want = createHmac('sha256', appSecret).update(rawBody).digest();
  let got: Buffer;
  try { got = Buffer.from(header.slice(7), 'hex'); } catch { return false; }
  return got.length === want.length && timingSafeEqual(got, want);
}

interface WaMessage {
  id?: string; from?: string; timestamp?: string; type?: string;
  text?: { body?: string };
  image?: { id?: string; caption?: string }; document?: { id?: string; caption?: string; filename?: string };
  audio?: { id?: string }; video?: { id?: string; caption?: string }; sticker?: { id?: string };
  button?: { text?: string }; reaction?: { message_id?: string; emoji?: string }; interactive?: { button_reply?: { id?: string; title?: string }; list_reply?: { id?: string; title?: string } };
}
interface WaValue { messages?: WaMessage[]; contacts?: { wa_id?: string; profile?: { name?: string } }[] }
export interface WaWebhook { object?: string; entry?: { changes?: { field?: string; value?: WaValue }[] }[] }

export class WhatsAppCloudAdapter implements ChannelAdapter {
  private creds?: CloudCreds;
  private active = false;

  constructor(private readonly ctx: AdapterContext, private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i), private readonly version = 'v21.0') {}

  private url = (path: string) => `${GRAPH}/${this.version}/${path}`;
  private auth = () => ({ authorization: `Bearer ${this.creds!.accessToken}` });

  /** Why the last check against Meta failed (a code the panel explains), or null. */
  lastError: string | null = null;

  async start(): Promise<void> {
    const { store, events } = this.ctx;
    const raw = await store.get(CLOUD_CREDS_KEY);
    if (!raw) { events.onStatus('logged_out'); return; } // not configured yet
    this.creds = JSON.parse(raw) as CloudCreds;
    events.onStatus('connecting');
    this.lastError = null;
    try {
      const res = await this.fetchImpl(this.url(`${this.creds.phoneNumberId}?fields=display_phone_number,verified_name`), { headers: this.auth(), signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: { code?: number } };
        this.lastError = metaCheckError(res.status, j.error?.code);
        events.onStatus('error'); return;
      }
    } catch { this.lastError = 'meta_unreachable'; events.onStatus('error'); return; }
    this.active = true;
    events.onStatus('connected');
  }

  async stop(): Promise<void> { this.active = false; this.ctx.events.onStatus('stopped'); }

  async logout(): Promise<void> {
    this.active = false;
    await this.ctx.store.clear();
    this.ctx.events.onStatus('logged_out');
  }

  /** Webhook GET handshake: returns the challenge only when the verify token matches. */
  verifyHandshake(mode: string | undefined, token: string | undefined, challenge: string | undefined): string | null {
    if (!this.creds || mode !== 'subscribe' || !token || !challenge || !/^[\w-]{1,100}$/.test(challenge)) return null;
    const a = Buffer.from(token), b = Buffer.from(this.creds.verifyToken);
    return a.length === b.length && timingSafeEqual(a, b) ? challenge : null;
  }

  isActive(): boolean { return this.active; }
  checkSignature(raw: Buffer, header: string | undefined): boolean { return !!this.creds && verifySignature(this.creds.appSecret, raw, header); }

  /** Turn a (signature-verified) webhook payload into inbound messages. Status callbacks and other events are ignored. */
  /**
   * Link the WhatsApp Business Account to this app (POST /{waba-id}/subscribed_apps). Without it Meta sends no webhooks even when the
   * app's webhook fields are set. Returns 'ok', 'no_waba' (no account id saved) or the reason it failed. Per Meta's Graph API
   * documentation; requires verification against the official reference, which changes.
   */
  async subscribeApp(): Promise<string> {
    if (!this.creds) return 'not_configured';
    if (!this.creds.wabaId) return 'no_waba';
    try {
      const res = await this.fetchImpl(this.url(`${this.creds.wabaId}/subscribed_apps`), { method: 'POST', headers: this.auth(), signal: AbortSignal.timeout(10_000) });
      const j = (await res.json().catch(() => ({}))) as { success?: boolean; error?: { code?: number } };
      if (res.ok && j.success !== false) return 'ok';
      return metaCheckError(res.status, j.error?.code);
    } catch { return 'meta_unreachable'; }
  }

  /** Is any app subscribed to the business account? null when it cannot be told (no account id, or Meta did not answer). */
  async subscribedApps(): Promise<boolean | null> {
    if (!this.creds?.wabaId) return null;
    try {
      const res = await this.fetchImpl(this.url(`${this.creds.wabaId}/subscribed_apps`), { headers: this.auth(), signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return null;
      const j = (await res.json().catch(() => ({}))) as { data?: unknown[] };
      return Array.isArray(j.data) ? j.data.length > 0 : null;
    } catch { return null; }
  }

  async handleWebhook(payload: WaWebhook): Promise<number> {
    let n = 0;
    for (const entry of payload.entry ?? []) {
      for (const ch of entry.changes ?? []) {
        if (ch.field !== 'messages' || !ch.value) continue;
        const names = new Map((ch.value.contacts ?? []).map((c) => [c.wa_id ?? '', c.profile?.name]));
        for (const m of ch.value.messages ?? []) {
          if (!m.id || !m.from || !/^\d{5,20}$/.test(m.from)) continue;
          // a reaction on one of our messages is feedback, not a message (shape per Meta's webhook docs; verify against the official reference)
          if (m.type === 'reaction') { if (m.reaction?.message_id) this.ctx.events.onReaction?.({ externalContactId: `${m.from}@s.whatsapp.net`, targetMessageId: m.reaction.message_id, emoji: m.reaction.emoji ?? '' }); continue; }
          await this.ctx.events.onMessage(this.toInbound(m, names.get(m.from)));
          n++;
        }
      }
    }
    return n;
  }

  private toInbound(m: WaMessage, name?: string): InboundMessage {
    const media = m.image ?? m.document ?? m.audio ?? m.video ?? m.sticker;
    const caption = m.image?.caption ?? m.document?.caption ?? m.video?.caption;
    // a tap on a menu button or list row arrives as the option number we put in its id (titles are shortened), so the bot reads it like a typed number
    const picked = m.interactive?.button_reply ?? m.interactive?.list_reply;
    const pickedText = picked ? (/^\d{1,2}$/.test(picked.id ?? '') ? picked.id : picked.title) : undefined;
    const text = m.text?.body ?? m.button?.text ?? pickedText ?? caption ?? (media ? '' : '[unsupported message type]');
    return {
      externalContactId: `${m.from}@s.whatsapp.net`,
      contactName: name,
      externalMessageId: m.id!,
      text,
      timestamp: new Date((Number(m.timestamp) || Math.floor(Date.now() / 1000)) * 1000),
      media: media?.id ? { fileName: m.document?.filename, download: () => this.downloadMedia(media.id!) } : undefined,
    };
  }

  private async downloadMedia(mediaId: string): Promise<Buffer> {
    if (!this.creds) throw new Error('not_configured');
    const meta = await this.fetchImpl(this.url(encodeURIComponent(mediaId)), { headers: this.auth(), signal: AbortSignal.timeout(10_000) });
    if (!meta.ok) throw new Error('media_lookup_failed');
    const { url } = (await meta.json()) as { url?: string };
    if (!url || !isGraphMediaUrl(url)) throw new Error('media_host_not_allowed');
    const res = await this.fetchImpl(url, { headers: this.auth(), signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error('media_download_failed');
    if (Number(res.headers.get('content-length') ?? 0) > MAX_DOWNLOAD) throw new Error('media_too_large');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_DOWNLOAD) throw new Error('media_too_large');
    return buf;
  }

  private async post(path: string, body: unknown): Promise<{ messages?: { id?: string }[] }> {
    if (!this.creds || !this.active) throw new Error('channel_not_connected');
    const res = await this.fetchImpl(this.url(path), { method: 'POST', headers: { ...this.auth(), 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    const json = (await res.json().catch(() => ({}))) as { error?: { code?: number } } & { messages?: { id?: string }[] };
    if (!res.ok) {
      const code = json.error?.code;
      if (code !== undefined && POLICY_CODES.has(code)) throw new PolicyRejected('outside_reply_window');
      if (code === 190) { this.active = false; this.ctx.events.onStatus('error'); } // token invalid or expired: needs a person
      throw new Error(`cloud_send_failed_${code ?? res.status}`);
    }
    return json;
  }

  async sendText(externalContactId: string, text: string): Promise<{ externalMessageId?: string }> {
    const out = await this.post(`${this.creds?.phoneNumberId}/messages`, { messaging_product: 'whatsapp', recipient_type: 'individual', to: externalContactId.split('@')[0], type: 'text', text: { body: text, preview_url: false } });
    return { externalMessageId: out.messages?.[0]?.id };
  }

  /** A menu as reply buttons (up to 3) or a list (up to 10 rows). Throws 'menu_not_supported' when it does not fit, so the caller sends the numbered text. */
  async sendInteractive(externalContactId: string, body: string, options: MenuOption[]): Promise<{ externalMessageId?: string }> {
    const payload = buildInteractive(externalContactId.split('@')[0]!, body, options);
    if (!payload) throw new Error('menu_not_supported');
    const out = await this.post(`${this.creds?.phoneNumberId}/messages`, payload);
    return { externalMessageId: out.messages?.[0]?.id };
  }

  /** A pre-approved template message: allowed outside the 24-hour window. */
  async sendTemplate(externalContactId: string, t: TemplateSend): Promise<{ externalMessageId?: string }> {
    const out = await this.post(`${this.creds?.phoneNumberId}/messages`, buildTemplate(externalContactId.split('@')[0]!, t));
    return { externalMessageId: out.messages?.[0]?.id };
  }

  private waba(): string {
    if (!this.creds || !this.active) throw new Error('channel_not_connected');
    if (!this.creds.wabaId) throw new Error('waba_not_configured');
    return this.creds.wabaId;
  }

  /** The templates of the business account, with their approval status. */
  async listTemplates(): Promise<CloudTemplate[]> {
    const waba = this.waba();
    const res = await this.fetchImpl(this.url(`${waba}/message_templates?fields=name,language,status,category,rejected_reason,components&limit=200`), { headers: this.auth(), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`templates_failed_${res.status}`);
    const json = (await res.json().catch(() => ({}))) as { data?: Parameters<typeof summarizeTemplate>[0][] };
    return (json.data ?? []).map(summarizeTemplate).filter((t): t is CloudTemplate => !!t);
  }

  /** Submit a new template for Meta's approval. */
  async createTemplate(t: Parameters<typeof buildTemplateCreate>[0]): Promise<{ id?: string; status?: string }> {
    const waba = this.waba();
    const res = await this.fetchImpl(this.url(`${waba}/message_templates`), { method: 'POST', headers: { ...this.auth(), 'content-type': 'application/json' }, body: JSON.stringify(buildTemplateCreate(t)), signal: AbortSignal.timeout(15_000) });
    const json = (await res.json().catch(() => ({}))) as { id?: string; status?: string; error?: { message?: string; error_user_msg?: string } };
    if (!res.ok) throw new Error(`template_rejected:${(json.error?.error_user_msg ?? json.error?.message ?? String(res.status)).slice(0, 200)}`);
    return { id: json.id, status: json.status };
  }

  async sendMedia(externalContactId: string, media: OutboundMedia): Promise<{ externalMessageId?: string }> {
    if (!this.creds || !this.active) throw new Error('channel_not_connected');
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', media.mime);
    form.append('file', new Blob([new Uint8Array(media.buffer)], { type: media.mime }), media.fileName);
    const up = await this.fetchImpl(this.url(`${this.creds.phoneNumberId}/media`), { method: 'POST', headers: this.auth(), body: form, signal: AbortSignal.timeout(60_000) });
    const upj = (await up.json().catch(() => ({}))) as { id?: string };
    if (!up.ok || !upj.id) throw new Error('cloud_upload_failed');
    const kind = media.mime.startsWith('image/') ? 'image' : media.mime.startsWith('audio/') ? 'audio' : media.mime.startsWith('video/') ? 'video' : 'document';
    const body = kind === 'document' ? { id: upj.id, filename: media.fileName, caption: media.caption } : kind === 'audio' ? { id: upj.id } : { id: upj.id, caption: media.caption };
    const out = await this.post(`${this.creds.phoneNumberId}/messages`, { messaging_product: 'whatsapp', recipient_type: 'individual', to: externalContactId.split('@')[0], type: kind, [kind]: body });
    return { externalMessageId: out.messages?.[0]?.id };
  }

  /** Reaction to a customer message (inside the 24-hour window). An empty emoji removes ours. Parameters: docs verification needed against the current Cloud API reference. */
  async react(externalContactId: string, externalMessageId: string, emoji: string): Promise<void> {
    await this.post(`${this.creds?.phoneNumberId}/messages`, { messaging_product: 'whatsapp', recipient_type: 'individual', to: externalContactId.split('@')[0], type: 'reaction', reaction: emoji ? { message_id: externalMessageId, emoji } : { message_id: externalMessageId } });
  }

  async markRead(_externalContactId: string, externalMessageIds: string[]): Promise<void> {
    const last = externalMessageIds[externalMessageIds.length - 1];
    if (last) await this.post(`${this.creds?.phoneNumberId}/messages`, { messaging_product: 'whatsapp', status: 'read', message_id: last }).catch(() => undefined);
  }
}

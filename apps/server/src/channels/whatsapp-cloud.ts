import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { PolicyRejected } from './sender.js';
import type { AdapterContext, ChannelAdapter, InboundMessage, OutboundMedia } from './types.js';

/**
 * Official WhatsApp Business Platform (Cloud API). No QR and no ban-evasion concerns: a verified business number, an access token
 * and a webhook. Messages arrive by webhook (signed with the app secret) and go out through the Graph API.
 * Platform rules (24h customer-service window, templates, versions, error codes) must be verified against Meta's current docs.
 */
export interface CloudCreds { phoneNumberId: string; accessToken: string; appSecret: string; verifyToken: string }
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
  button?: { text?: string }; interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
}
interface WaValue { messages?: WaMessage[]; contacts?: { wa_id?: string; profile?: { name?: string } }[] }
export interface WaWebhook { object?: string; entry?: { changes?: { field?: string; value?: WaValue }[] }[] }

export class WhatsAppCloudAdapter implements ChannelAdapter {
  private creds?: CloudCreds;
  private active = false;

  constructor(private readonly ctx: AdapterContext, private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i), private readonly version = 'v21.0') {}

  private url = (path: string) => `${GRAPH}/${this.version}/${path}`;
  private auth = () => ({ authorization: `Bearer ${this.creds!.accessToken}` });

  async start(): Promise<void> {
    const { store, events } = this.ctx;
    const raw = await store.get(CLOUD_CREDS_KEY);
    if (!raw) { events.onStatus('logged_out'); return; } // not configured yet
    this.creds = JSON.parse(raw) as CloudCreds;
    events.onStatus('connecting');
    try {
      const res = await this.fetchImpl(this.url(`${this.creds.phoneNumberId}?fields=display_phone_number,verified_name`), { headers: this.auth(), signal: AbortSignal.timeout(10_000) });
      if (!res.ok) { events.onStatus('error'); return; }
    } catch { events.onStatus('error'); return; }
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
  async handleWebhook(payload: WaWebhook): Promise<number> {
    let n = 0;
    for (const entry of payload.entry ?? []) {
      for (const ch of entry.changes ?? []) {
        if (ch.field !== 'messages' || !ch.value) continue;
        const names = new Map((ch.value.contacts ?? []).map((c) => [c.wa_id ?? '', c.profile?.name]));
        for (const m of ch.value.messages ?? []) {
          if (!m.id || !m.from || !/^\d{5,20}$/.test(m.from)) continue;
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
    const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? caption ?? (media ? '' : '[unsupported message type]');
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

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
  id?: string; from?: string; from_user_id?: string; timestamp?: string; type?: string;
  text?: { body?: string };
  image?: { id?: string; caption?: string }; document?: { id?: string; caption?: string; filename?: string };
  audio?: { id?: string }; video?: { id?: string; caption?: string }; sticker?: { id?: string };
  button?: { text?: string }; reaction?: { message_id?: string; emoji?: string }; interactive?: { type?: string; button_reply?: { id?: string; title?: string }; list_reply?: { id?: string; title?: string }; nfm_reply?: { name?: string; body?: string; response_json?: string } };
}
interface WaContact { wa_id?: string; user_id?: string; profile?: { name?: string; username?: string } }
interface WaValue { messages?: WaMessage[]; contacts?: WaContact[]; username?: string; status?: string; context?: string; display_phone_number?: string }
export interface WaWebhook { object?: string; entry?: { changes?: { field?: string; value?: WaValue }[] }[] }

/**
 * A business-scoped user id (BSUID): a two-letter country code, a period and up to 128 letters/digits ("US.1349…"); a parent
 * id has "ENT." after the country code. Format per Meta's business-scoped user ids page (verify against the official reference).
 */
export const BSUID = /^[A-Z]{2}\.(?:ENT\.)?[A-Za-z0-9]{1,128}$/;
/** Our contact id for a customer who arrived by user id only (their phone number hidden behind a WhatsApp username). */
export const bsuidContact = (id: string) => `${id}@bsuid`;
/** The recipient field of a Cloud API message: the phone number as "to", or the BSUID as "recipient" (Meta: supported from July 2026). */
export function recipientOf(externalContactId: string): { to: string } | { recipient: string } {
  const [id, kind] = externalContactId.split('@');
  return kind === 'bsuid' && BSUID.test(id ?? '') ? { recipient: id! } : { to: id! };
}

/** A message body built for "to", addressed to the contact instead (phone number or user id). */
function addressed(payload: Record<string, unknown>, externalContactId: string): Record<string, unknown> {
  const { to: _to, ...rest } = payload;
  return { ...rest, ...recipientOf(externalContactId) };
}

/**
 * Business username rules (Meta, business-scoped user ids page): 3–35 characters, English letters, digits, "." and "_" only, at
 * least one letter, no leading/trailing period or "..", not starting with "www." and not ending with a domain suffix. Case is
 * ignored by Meta, so we keep it lower-case. Returns an error key, or null when the name is acceptable.
 */
const DOMAIN_END = /\.(com|org|net|int|edu|gov|mil|arpa|html|htm|txt|xml)$/i;
export function usernameProblem(raw: string): string | null {
  const u = raw.trim().toLowerCase();
  if (u.length < 3 || u.length > 35) return 'username_length';
  if (!/^[a-z0-9._]+$/.test(u)) return 'username_chars';
  if (!/[a-z]/.test(u)) return 'username_no_letter';
  if (u.startsWith('.') || u.endsWith('.') || u.includes('..')) return 'username_periods';
  if (u.startsWith('www.') || DOMAIN_END.test(u)) return 'username_domain';
  return null;
}

/** Meta's Username API error codes → our keys (codes from the same page; verify against the official reference, it changes). */
const USERNAME_ERRORS: Record<number, string> = {
  10: 'username_permission', 33: 'username_invalid_number', 100: 'username_format', 190: 'meta_auth_failed',
  147001: 'username_taken', 147002: 'username_not_eligible', 147003: 'username_fb_link', 147004: 'username_ig_link',
  147005: 'username_transfer_required', 147006: 'username_business_app', 147007: 'username_reserved_other',
  130429: 'username_limit', 133010: 'username_not_registered',
};
export class UsernameError extends Error {
  constructor(readonly key: string, readonly detail?: string) { super(key); }
}
export class FlowError extends Error {
  constructor(readonly key: string, readonly detail?: string) { super(key); }
}
export interface BusinessUsername { username: string | null; status: 'approved' | 'reserved' | 'none' }

export class WhatsAppCloudAdapter implements ChannelAdapter {
  private creds?: CloudCreds;
  /** The business phone number id (the key of the monthly usage count), once the credentials are loaded. */
  get numberId(): string | null { return this.creds?.phoneNumberId ?? null; }
  private active = false;

  constructor(private readonly ctx: AdapterContext, private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i), private readonly version = 'v25.0') {}

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

  /**
   * Where Meta actually delivers this number's webhooks: the app's callback URL, and alternate callback URLs set on the business
   * account or on the number itself, which override the app's (GET /{phone-number-id}?fields=webhook_configuration, per Meta's
   * "webhook overrides" docs; verify against the official reference). null when Meta does not say.
   */
  async webhookTargets(): Promise<{ application?: string; whatsapp_business_account?: string; phone_number?: string } | null> {
    if (!this.creds) return null;
    try {
      const res = await this.fetchImpl(this.url(`${this.creds.phoneNumberId}?fields=webhook_configuration`), { headers: this.auth(), signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return null;
      const j = (await res.json().catch(() => ({}))) as { webhook_configuration?: Record<string, unknown> };
      const w = j.webhook_configuration;
      if (!w || typeof w !== 'object') return null;
      const pick = (k: string) => (typeof w[k] === 'string' && /^https?:\/\//.test(w[k] as string) ? (w[k] as string).slice(0, 500) : undefined);
      return { application: pick('application'), whatsapp_business_account: pick('whatsapp_business_account'), phone_number: pick('phone_number') };
    } catch { return null; }
  }

  /**
   * Point this number's webhooks at `url` (an alternate callback URL on the number, which wins over any other setting).
   * Meta verifies it at once with the GET handshake, so the verify token must be ours. Per Meta's "webhook overrides" docs; verify.
   */
  async routeWebhooksTo(url: string): Promise<string> {
    if (!this.creds || !this.active) return 'channel_not_connected';
    try {
      const res = await this.fetchImpl(this.url(this.creds.phoneNumberId), {
        method: 'POST', headers: { ...this.auth(), 'content-type': 'application/json' },
        body: JSON.stringify({ webhook_configuration: { override_callback_uri: url, verify_token: this.creds.verifyToken } }), signal: AbortSignal.timeout(20_000),
      });
      const j = (await res.json().catch(() => ({}))) as { success?: boolean; error?: { code?: number } };
      if (res.ok && j.success !== false) return 'ok';
      return metaCheckError(res.status, j.error?.code);
    } catch { return 'meta_unreachable'; }
  }

  /**
   * The app-level webhook subscription (which fields Meta sends at all, and to which URL): GET /{app-id}/subscriptions with the
   * app access token "{app-id}|{app-secret}". The app id comes from GET /app with the saved access token. Per Meta's Graph API
   * "App Subscriptions" reference; verify against the official docs. null when Meta does not answer.
   */
  private async appToken(): Promise<{ appId: string; token: string } | null> {
    if (!this.creds) return null;
    const res = await this.fetchImpl(this.url('app?fields=id'), { headers: this.auth(), signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if (!res?.ok) return null;
    const j = (await res.json().catch(() => ({}))) as { id?: string };
    return j.id && /^\d{5,32}$/.test(j.id) ? { appId: j.id, token: `${j.id}|${this.creds.appSecret}` } : null;
  }

  async appSubscription(): Promise<{ appId: string; callbackUrl: string | null; fields: string[]; active: boolean } | null> {
    const t = await this.appToken();
    if (!t) return null;
    const res = await this.fetchImpl(this.url(`${t.appId}/subscriptions`), { headers: { authorization: `Bearer ${t.token}` }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if (!res?.ok) return null;
    const j = (await res.json().catch(() => ({}))) as { data?: { object?: string; callback_url?: string; active?: boolean; fields?: { name?: string }[] }[] };
    const wa = (j.data ?? []).find((d) => d.object === 'whatsapp_business_account');
    return { appId: t.appId, callbackUrl: wa?.callback_url ?? null, fields: (wa?.fields ?? []).map((f) => f.name ?? '').filter(Boolean), active: wa?.active !== false && !!wa };
  }

  /** Subscribe the app to the WhatsApp "messages" field at `url` (Meta verifies it with the handshake first). */
  async subscribeAppFields(url: string): Promise<string> {
    const t = await this.appToken();
    if (!t || !this.creds) return 'meta_app_unknown';
    const body = new URLSearchParams({ object: 'whatsapp_business_account', callback_url: url, fields: 'messages', verify_token: this.creds.verifyToken, include_values: 'true' });
    const res = await this.fetchImpl(this.url(`${t.appId}/subscriptions`), { method: 'POST', headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(), signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (!res) return 'meta_unreachable';
    const j = (await res.json().catch(() => ({}))) as { success?: boolean; error?: { code?: number } };
    if (res.ok && j.success !== false) return 'ok';
    return metaCheckError(res.status, j.error?.code);
  }

  /**
   * The business profile picture: the image goes up through Meta's Resumable Upload API (POST /{app-id}/uploads, then the bytes
   * to the upload session, which returns a handle), and the handle is set on the number's business profile
   * (POST /{phone-number-id}/whatsapp_business_profile). Per Meta's docs; verify against the official reference.
   */
  /** For the admin: at which step the last profile-picture change failed and what Meta said (no tokens, short). */
  lastPhotoDetail: string | null = null;

  async setProfilePhoto(image: Buffer, mime: 'image/png' | 'image/jpeg'): Promise<string> {
    this.lastPhotoDetail = null;
    if (!this.creds || !this.active) return 'channel_not_connected';
    const t = await this.appToken();
    if (!t) return 'meta_app_unknown';
    type MetaErr = { error?: { code?: number; error_subcode?: number; message?: string; error_user_msg?: string } };
    const fail = (step: string, status: number, j: MetaErr): string => {
      const e = j.error ?? {};
      const said = String(e.error_user_msg ?? e.message ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 300);
      this.lastPhotoDetail = `${step} (HTTP ${status}${e.code !== undefined ? `, code ${e.code}` : ''}${e.error_subcode ? `/${e.error_subcode}` : ''})${said ? `: ${said}` : ''}`;
      return metaCheckError(status, e.code);
    };
    try {
      const q = new URLSearchParams({ file_name: mime === 'image/png' ? 'profile.png' : 'profile.jpg', file_length: String(image.length), file_type: mime });
      const s1 = await this.fetchImpl(this.url(`${t.appId}/uploads?${q}`), { method: 'POST', headers: this.auth(), signal: AbortSignal.timeout(15_000) });
      const j1 = (await s1.json().catch(() => ({}))) as { id?: string } & MetaErr;
      // the session id looks like "upload:<base64>?sig=<signature>": it becomes part of the next URL, so only those characters pass
      if (!s1.ok || !j1.id) return fail('פתיחת העלאה', s1.status, j1);
      if (!/^upload:[A-Za-z0-9_\-=+/:?&%.]{4,1500}$/.test(j1.id) || j1.id.includes('..')) { this.lastPhotoDetail = 'פתיחת העלאה: מזהה העלאה בפורמט לא צפוי'; return 'meta_check_failed'; }
      const s2 = await this.fetchImpl(this.url(j1.id), { method: 'POST', headers: { authorization: `OAuth ${this.creds.accessToken}`, file_offset: '0', 'content-type': mime }, body: new Uint8Array(image), signal: AbortSignal.timeout(60_000) });
      const j2 = (await s2.json().catch(() => ({}))) as { h?: string } & MetaErr;
      if (!s2.ok || !j2.h) return fail('שליחת הקובץ', s2.status, j2);
      const s3 = await this.fetchImpl(this.url(`${this.creds.phoneNumberId}/whatsapp_business_profile`), {
        method: 'POST', headers: { ...this.auth(), 'content-type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', profile_picture_handle: j2.h }), signal: AbortSignal.timeout(20_000),
      });
      const j3 = (await s3.json().catch(() => ({}))) as { success?: boolean } & MetaErr;
      return s3.ok && j3.success !== false ? 'ok' : fail('שמירה בפרופיל העסקי', s3.status, j3);
    } catch { this.lastPhotoDetail = 'אין חיבור ל-Meta'; return 'meta_unreachable'; }
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

  // ---- business username (Meta's Username API on the phone number; per the business-scoped user ids page, verify against the reference) ----

  /** One Username API call: the JSON on success, a UsernameError with our key (and Meta's short message) otherwise. */
  private async usernameCall<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    if (!this.creds || !this.active) throw new UsernameError('channel_not_connected');
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(`${this.creds.phoneNumberId}/${path}`), {
        method, headers: body ? { ...this.auth(), 'content-type': 'application/json' } : this.auth(), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000),
      });
    } catch { throw new UsernameError('meta_unreachable'); }
    const j = (await res.json().catch(() => ({}))) as T & { error?: { code?: number; message?: string; error_user_msg?: string; error_data?: { details?: string } } };
    if (!res.ok || j.error) {
      const e = j.error ?? {};
      const said = String(e.error_data?.details ?? e.error_user_msg ?? e.message ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 200);
      throw new UsernameError((e.code !== undefined && USERNAME_ERRORS[e.code]) || metaCheckError(res.status, e.code), said || undefined);
    }
    return j;
  }

  /** The number's current username and its status ("none" when it has none). */
  async getUsername(): Promise<BusinessUsername> {
    const j = await this.usernameCall<{ username?: string; status?: string }>('GET', 'username');
    const status = j.status === 'approved' || j.status === 'reserved' ? j.status : 'none';
    return { username: j.username && status !== 'none' ? j.username : null, status };
  }

  /** Adopt or change the username. transfer: move it from another number of the same business portfolio (counts as a change). */
  async setUsername(username: string, transfer = false): Promise<BusinessUsername> {
    const u = username.trim().toLowerCase();
    const bad = usernameProblem(u);
    if (bad) throw new UsernameError(bad);
    const j = await this.usernameCall<{ status?: string }>('POST', 'username', { username: u, transfer_action: transfer ? 'force_transfer' : 'none' });
    return { username: u, status: j.status === 'reserved' ? 'reserved' : 'approved' };
  }

  async deleteUsername(): Promise<boolean> {
    const j = await this.usernameCall<{ success?: boolean }>('DELETE', 'username');
    return j.success === true;
  }

  /** Usernames Meta reserved for the business portfolio (higher chance of approval). */
  async usernameSuggestions(): Promise<string[]> {
    const j = await this.usernameCall<{ data?: { username_suggestions?: unknown[] }[] }>('GET', 'username_suggestions');
    const all = (j.data ?? []).flatMap((d) => (Array.isArray(d.username_suggestions) ? d.username_suggestions : []));
    return [...new Set(all.filter((x): x is string => typeof x === 'string' && usernameProblem(x) === null).map((x) => x.toLowerCase()))].slice(0, 20);
  }

  // ---- WhatsApp Flows (forms filled inside WhatsApp; no endpoint). Flows API per Meta's documentation; verify against the reference. ----

  private async graphJson<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    if (!this.creds || !this.active) throw new FlowError('channel_not_connected');
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path), { method, headers: body ? { ...this.auth(), 'content-type': 'application/json' } : this.auth(), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
    } catch { throw new FlowError('meta_unreachable'); }
    const j = (await res.json().catch(() => ({}))) as T & { error?: { code?: number; message?: string; error_user_msg?: string } };
    if (!res.ok || j.error) {
      const e = j.error ?? {};
      throw new FlowError(metaCheckError(res.status, e.code), String(e.error_user_msg ?? e.message ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 300) || undefined);
    }
    return j;
  }

  /** Create a Flow from its JSON and publish it in the same request; Meta answers with validation errors if any (then it stays a draft). */
  async flowCreate(name: string, json: unknown): Promise<{ id: string; errors: string[] }> {
    const waba = this.waba();
    const j = await this.graphJson<{ id?: string; validation_errors?: { message?: string; pointers?: { path?: string }[] }[] }>('POST', `${waba}/flows`, { name: name.slice(0, 200), categories: ['OTHER'], flow_json: JSON.stringify(json), publish: true });
    if (!j.id) throw new FlowError('flow_create_failed');
    return { id: j.id, errors: (j.validation_errors ?? []).map((v) => `${v.message ?? ''}${v.pointers?.[0]?.path ? ` (${v.pointers[0].path})` : ''}`.slice(0, 300)).slice(0, 20) };
  }

  async flowGet(id: string): Promise<{ status: string; errors: string[]; previewUrl: string | null }> {
    if (!/^\d{5,30}$/.test(id)) throw new FlowError('flow_not_found');
    const j = await this.graphJson<{ status?: string; validation_errors?: { message?: string }[]; preview?: { preview_url?: string } }>('GET', `${id}?fields=status,validation_errors,preview.invalidate(false)`);
    const preview = j.preview?.preview_url && /^https:\/\/business\.facebook\.com\//.test(j.preview.preview_url) ? j.preview.preview_url : null;
    return { status: String(j.status ?? 'UNKNOWN'), errors: (j.validation_errors ?? []).map((v) => String(v.message ?? '').slice(0, 300)).slice(0, 20), previewUrl: preview };
  }

  async flowPublish(id: string): Promise<void> { if (!/^\d{5,30}$/.test(id)) throw new FlowError('flow_not_found'); await this.graphJson('POST', `${id}/publish`); }
  /** A published Flow cannot be changed or deleted: it is retired. A draft is deleted. */
  async flowRetire(id: string, published: boolean): Promise<void> {
    if (!/^\d{5,30}$/.test(id)) return;
    await this.graphJson(published ? 'POST' : 'DELETE', published ? `${id}/deprecate` : id).catch(() => undefined);
  }

  /** A message with a button that opens the Flow (inside the 24-hour window). The token identifies the form request in the reply. */
  async sendFlow(externalContactId: string, f: { flowId: string; token: string; body: string; cta: string; data?: Record<string, string> }): Promise<{ externalMessageId?: string }> {
    const parameters: Record<string, unknown> = { flow_message_version: '3', flow_id: f.flowId, flow_token: f.token, flow_cta: f.cta.slice(0, 30), flow_action: 'navigate', flow_action_payload: { screen: 'S1', ...(f.data && Object.keys(f.data).length ? { data: f.data } : {}) } };
    const out = await this.post(`${this.creds?.phoneNumberId}/messages`, { messaging_product: 'whatsapp', recipient_type: 'individual', ...recipientOf(externalContactId), type: 'interactive', interactive: { type: 'flow', body: { text: f.body.slice(0, 1024) }, action: { name: 'flow', parameters } } });
    return { externalMessageId: out.messages?.[0]?.id };
  }

  async handleWebhook(payload: WaWebhook): Promise<number> {
    let n = 0;
    for (const entry of payload.entry ?? []) {
      for (const ch of entry.changes ?? []) {
        if (ch.field === 'business_username_updates' && ch.value) { this.onUsernameUpdate?.(ch.value); continue; }
        if (ch.field !== 'messages' || !ch.value) continue;
        const contacts = ch.value.contacts ?? [];
        for (const m of ch.value.messages ?? []) {
          if (!m.id) continue;
          // the phone number when the message has it; otherwise (a customer with a WhatsApp username) the business-scoped user id
          const phone = m.from && /^\d{5,20}$/.test(m.from) ? m.from : undefined;
          const contact = contacts.find((c) => (phone && c.wa_id === phone) || (!!m.from_user_id && c.user_id === m.from_user_id)) ?? (contacts.length === 1 ? contacts[0] : undefined);
          const userId = [m.from_user_id, contact?.user_id].find((v): v is string => !!v && BSUID.test(v));
          if (!phone && !userId) continue;
          const ext = phone ? `${phone}@s.whatsapp.net` : bsuidContact(userId!);
          const name = contact?.profile?.name || (contact?.profile?.username ? `@${contact.profile.username}` : undefined);
          // a reaction on one of our messages is feedback, not a message (shape per Meta's webhook docs; verify against the official reference)
          if (m.type === 'reaction') { if (m.reaction?.message_id) this.ctx.events.onReaction?.({ externalContactId: ext, targetMessageId: m.reaction.message_id, emoji: m.reaction.emoji ?? '' }); continue; }
          await this.ctx.events.onMessage({ ...this.toInbound(m, ext, name), userId });
          n++;
        }
      }
    }
    return n;
  }

  /** Set by the channel manager: Meta reported a change of the number's business username (webhook field business_username_updates). */
  onUsernameUpdate?: (v: { username?: string; status?: string; context?: string }) => void;

  private toInbound(m: WaMessage, ext: string, name?: string): InboundMessage {
    const media = m.image ?? m.document ?? m.audio ?? m.video ?? m.sticker;
    const caption = m.image?.caption ?? m.document?.caption ?? m.video?.caption;
    // a tap on a menu button or list row arrives as the option number we put in its id (titles are shortened), so the bot reads it like a typed number
    const picked = m.interactive?.button_reply ?? m.interactive?.list_reply;
    const pickedText = picked ? (/^\d{1,2}$/.test(picked.id ?? '') ? picked.id : picked.title) : undefined;
    // a form filled in WhatsApp (Flows): the answers travel as JSON; the chat shows a short line, never the answers themselves
    const nfm = m.interactive?.type === 'nfm_reply' && typeof m.interactive.nfm_reply?.response_json === 'string' ? m.interactive.nfm_reply.response_json : undefined;
    if (nfm !== undefined) return { externalContactId: ext, contactName: name, externalMessageId: m.id!, text: '📝 הטופס מולא ונשלח בווצאפ.', timestamp: new Date((Number(m.timestamp) || Math.floor(Date.now() / 1000)) * 1000), flowReply: { responseJson: nfm.slice(0, 200_000) } };
    const text = m.text?.body ?? m.button?.text ?? pickedText ?? caption ?? (media ? '' : '[unsupported message type]');
    return {
      externalContactId: ext,
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
    const out = await this.post(`${this.creds?.phoneNumberId}/messages`, { messaging_product: 'whatsapp', recipient_type: 'individual', ...recipientOf(externalContactId), type: 'text', text: { body: text, preview_url: false } });
    return { externalMessageId: out.messages?.[0]?.id };
  }

  /** A menu as reply buttons (up to 3) or a list (up to 10 rows). Throws 'menu_not_supported' when it does not fit, so the caller sends the numbered text. */
  async sendInteractive(externalContactId: string, body: string, options: MenuOption[]): Promise<{ externalMessageId?: string }> {
    const payload = buildInteractive('', body, options);
    if (!payload) throw new Error('menu_not_supported');
    const out = await this.post(`${this.creds?.phoneNumberId}/messages`, addressed(payload, externalContactId));
    return { externalMessageId: out.messages?.[0]?.id };
  }

  /** A pre-approved template message: allowed outside the 24-hour window. */
  async sendTemplate(externalContactId: string, t: TemplateSend): Promise<{ externalMessageId?: string }> {
    const out = await this.post(`${this.creds?.phoneNumberId}/messages`, addressed(buildTemplate('', t), externalContactId));
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
    // The Cloud API's image type takes JPEG/PNG only (verify against the current reference): a GIF goes as its MP4 video.
    if (media.mime === 'image/gif') {
      if (!media.animation) throw new Error('gif_unsupported');
      media = { buffer: media.animation, mime: 'video/mp4', fileName: media.fileName.replace(/\.gif$/i, '') + '.mp4', caption: media.caption };
    }
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', media.mime);
    form.append('file', new Blob([new Uint8Array(media.buffer)], { type: media.mime }), media.fileName);
    const up = await this.fetchImpl(this.url(`${this.creds.phoneNumberId}/media`), { method: 'POST', headers: this.auth(), body: form, signal: AbortSignal.timeout(60_000) });
    const upj = (await up.json().catch(() => ({}))) as { id?: string };
    if (!up.ok || !upj.id) throw new Error('cloud_upload_failed');
    const kind = media.mime.startsWith('image/') ? 'image' : media.mime.startsWith('audio/') ? 'audio' : media.mime.startsWith('video/') ? 'video' : 'document';
    const body = kind === 'document' ? { id: upj.id, filename: media.fileName, caption: media.caption } : kind === 'audio' ? { id: upj.id } : { id: upj.id, caption: media.caption };
    const out = await this.post(`${this.creds.phoneNumberId}/messages`, { messaging_product: 'whatsapp', recipient_type: 'individual', ...recipientOf(externalContactId), type: kind, [kind]: body });
    return { externalMessageId: out.messages?.[0]?.id };
  }

  /** Reaction to a customer message (inside the 24-hour window). An empty emoji removes ours. Parameters: docs verification needed against the current Cloud API reference. */
  async react(externalContactId: string, externalMessageId: string, emoji: string): Promise<void> {
    await this.post(`${this.creds?.phoneNumberId}/messages`, { messaging_product: 'whatsapp', recipient_type: 'individual', ...recipientOf(externalContactId), type: 'reaction', reaction: emoji ? { message_id: externalMessageId, emoji } : { message_id: externalMessageId } });
  }

  async markRead(_externalContactId: string, externalMessageIds: string[]): Promise<void> {
    const last = externalMessageIds[externalMessageIds.length - 1];
    if (last) await this.post(`${this.creds?.phoneNumberId}/messages`, { messaging_product: 'whatsapp', status: 'read', message_id: last }).catch(() => undefined);
  }
}

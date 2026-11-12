import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const level = z.enum(['off', 'optional', 'required']);
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const designSchema = z.object({
  title: z.string().trim().min(1).max(40).default('צ׳אט עם הצוות'),
  subtitle: z.string().trim().max(80).default('בדרך כלל עונים תוך דקות'),
  welcome: z.string().trim().max(300).default('שלום! איך אפשר לעזור?'),
  color: hex.default('#6a3de8'),
  position: z.enum(['left', 'right']).default('left'),
  launcherLabel: z.string().trim().max(20).default(''),
  launcherIcon: z.enum(['chat', 'help', 'message']).default('chat'),
  language: z.enum(['he', 'en']).default('he'),
}).strict();

/** "Continue on…" buttons in the widget: plain links to the networks' own deep links. Handles are validated so only safe URLs are built. */
export const SOCIAL_NETWORKS = ['whatsapp', 'messenger', 'instagram', 'telegram', 'email', 'phone'] as const;
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];
const HANDLE: Record<SocialNetwork, RegExp> = {
  whatsapp: /^\d{8,15}$/,                                  // international number, digits only (wa.me format)
  messenger: /^[A-Za-z0-9.]{5,50}$/,                        // Facebook page username
  instagram: /^[A-Za-z0-9._]{1,30}$/,
  telegram: /^[A-Za-z][A-Za-z0-9_]{4,31}$/,
  email: /^[^@\s<>"']{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,}$/,
  phone: /^\+?\d{7,15}$/,
};
export const socialLinkSchema = z.object({
  network: z.enum(SOCIAL_NETWORKS),
  handle: z.string().trim().max(200).transform((v) => v.replace(/^@/, '').replace(/[\s-]/g, '')),
}).strict().refine((l) => HANDLE[l.network].test(l.handle), { message: 'bad_handle', path: ['handle'] });
export type SocialLink = z.infer<typeof socialLinkSchema>;

/** The URL a social button opens (deep links per the networks' public formats; verify ig.me against Instagram's documentation). */
export function socialUrl(l: SocialLink): string {
  switch (l.network) {
    case 'whatsapp': return `https://wa.me/${l.handle}`;
    case 'messenger': return `https://m.me/${encodeURIComponent(l.handle)}`;
    case 'instagram': return `https://ig.me/m/${encodeURIComponent(l.handle)}`;
    case 'telegram': return `https://t.me/${encodeURIComponent(l.handle)}`;
    case 'email': return `mailto:${l.handle}`;
    case 'phone': return `tel:${l.handle}`;
  }
}

export const behaviorSchema = z.object({
  askName: level.default('optional'),
  askEmail: level.default('off'),
  askPhone: level.default('off'),
  popupText: z.string().trim().max(100).default(''),
  popupDelaySec: z.number().int().min(0).max(120).default(5),
  autoOpenSec: z.number().int().min(0).max(300).default(0),
  showAgentName: z.boolean().default(true),
  consentText: z.string().trim().max(300).default(''),
  consentLink: z.string().trim().max(300).refine((v) => v === '' || /^https:\/\/[^\s]+$/.test(v), 'https only').default(''),
  offlineMessage: z.string().trim().max(300).default('אנחנו לא זמינים כרגע. אפשר להשאיר הודעה ונחזור אליכם.'),
  maxLength: z.number().int().min(100).max(4000).default(2000),
  /** while the visitor types, offer matching questions from the knowledge base with an instant answer */
  suggestions: z.boolean().default(true),
  /** "continue on WhatsApp / Messenger / …" buttons shown in the widget's welcome area */
  socialLinks: z.array(socialLinkSchema).max(6).default([]),
}).strict();

export type Design = z.infer<typeof designSchema>;
export type Behavior = z.infer<typeof behaviorSchema>;

const lum = (hexColor: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hexColor.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a: string, b: string): number => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };

/** Text colour for the brand colour (white or near-black, whichever reads better); null when neither reaches WCAG AA (4.5:1). */
export function textOn(color: string): '#ffffff' | '#111111' | null {
  const best = contrast(color, '#ffffff') >= contrast(color, '#111111') ? '#ffffff' : '#111111';
  return contrast(color, best) >= 4.5 ? best : null;
}

/** One allowed site: https://example.com, https://*.example.com, http://localhost[:port]. Exact origin only (no path). */
const ORIGIN = /^(https:\/\/(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}(:\d{1,5})?|http:\/\/localhost(:\d{1,5})?|http:\/\/127\.0\.0\.1(:\d{1,5})?)$/;
export const normalizeOrigin = (s: string): string | null => { const v = s.trim().toLowerCase().replace(/\/$/, ''); return ORIGIN.test(v) ? v : null; };

export function originAllowed(list: string[], origin: string): boolean {
  const o = origin.toLowerCase();
  return list.some((p) => {
    if (p === o) return true;
    const m = /^(https:\/\/)\*\.(.+)$/.exec(p);
    return !!m && o.startsWith('https://') && o.slice(8).endsWith(`.${m[2]}`) && /^[a-z0-9.-]+(:\d+)?$/.test(o.slice(8));
  });
}

export const newPublicKey = () => `wc_${randomBytes(18).toString('base64url')}`;
export const newIdentitySecret = () => randomBytes(32).toString('base64url');

/** HMAC the host site's backend computes for a signed-in customer:  hex(HMAC-SHA256(secret, id)). */
export const identitySignature = (secret: string, id: string): string => createHmac('sha256', secret).update(id).digest('hex');
export function verifyIdentity(secret: string, id: string, signature: string): boolean {
  if (!/^[\w.-]{1,64}$/.test(id) || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const want = Buffer.from(identitySignature(secret, id), 'hex'), got = Buffer.from(signature, 'hex');
  return want.length === got.length && timingSafeEqual(want, got);
}

/** The snippet to give to the website owner. */
export function embedCode(origin: string, key: string): string {
  return `<!-- Chat widget -->\n<script src="${origin}/widget.js" data-key="${key}" async></script>`;
}

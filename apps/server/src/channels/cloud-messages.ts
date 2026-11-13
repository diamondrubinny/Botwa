/**
 * Message shapes of the official WhatsApp Business Platform (Cloud API) for interactive messages and message templates, kept apart
 * from the network code so they can be tested. The shapes and limits below are written from knowledge of Meta's documentation and
 * were NOT checked against the live reference from this environment: verify them against Meta's current docs before relying on them.
 * Limits used: reply buttons - up to 3, title up to 20 characters; list - up to 10 rows, row title up to 24, row description up to 72,
 * list button text up to 20; body up to 1024 characters.
 */
export interface MenuOption { id: string; title: string }

const clip = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
export const MAX_BUTTONS = 3, MAX_LIST_ROWS = 10;

/** Reply buttons when there are at most three short options, a list when there are up to ten, otherwise null (use the numbered text). */
export function buildInteractive(to: string, body: string, options: MenuOption[], listButton = 'בחירה'): Record<string, unknown> | null {
  if (options.length === 0 || options.length > MAX_LIST_ROWS || body.trim() === '') return null;
  const common = { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive' };
  const text = clip(body, 1024);
  if (options.length <= MAX_BUTTONS && options.every((o) => o.title.trim().length <= 20)) {
    return { ...common, interactive: { type: 'button', body: { text }, action: { buttons: options.map((o) => ({ type: 'reply', reply: { id: o.id, title: o.title.trim() } })) } } };
  }
  return {
    ...common,
    interactive: {
      type: 'list', body: { text }, action: {
        button: clip(listButton, 20),
        sections: [{ title: clip('אפשרויות', 24), rows: options.map((o) => ({ id: o.id, title: clip(o.title, 24), ...(o.title.trim().length > 24 ? { description: clip(o.title, 72) } : {}) })) }],
      },
    },
  };
}

export interface TemplateSend { name: string; language: string; /** values for {{1}}, {{2}}... of the body, in order */ params: string[] }

/** A template message (the only kind that may be sent outside the 24-hour window). */
export function buildTemplate(to: string, t: TemplateSend): Record<string, unknown> {
  return {
    messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template',
    template: { name: t.name, language: { code: t.language }, ...(t.params.length ? { components: [{ type: 'body', parameters: t.params.map((p) => ({ type: 'text', text: p })) }] } : {}) },
  };
}

export interface CloudTemplate { name: string; language: string; status: string; category: string; body: string; params: number; rejectedReason: string | null }

/** Reduce an API template to what the panel needs: the body text and how many {{n}} values it takes. */
export function summarizeTemplate(t: { name?: string; language?: string; status?: string; category?: string; rejected_reason?: string; components?: { type?: string; text?: string }[] }): CloudTemplate | null {
  if (!t.name || !t.language) return null;
  const body = t.components?.find((c) => c.type === 'BODY')?.text ?? '';
  const nums = [...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  return { name: t.name, language: t.language, status: t.status ?? 'UNKNOWN', category: t.category ?? '', body, params: nums.length ? Math.max(...nums) : 0, rejectedReason: t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null };
}

export const renderTemplateBody = (body: string, params: string[]): string => body.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => params[Number(n) - 1] ?? '');

export const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
export const TEMPLATE_LANGS = ['he', 'en', 'en_US', 'ar', 'ru'] as const;
export const TEMPLATE_CATEGORIES = ['UTILITY', 'MARKETING', 'AUTHENTICATION'] as const;

/** Body of a request that submits a new template for Meta's approval (body text only, with an example value for each placeholder). */
export function buildTemplateCreate(t: { name: string; language: string; category: (typeof TEMPLATE_CATEGORIES)[number]; body: string; examples: string[] }): Record<string, unknown> {
  const n = (t.body.match(/\{\{\d+\}\}/g) ?? []).length;
  return { name: t.name, language: t.language, category: t.category, components: [{ type: 'BODY', text: t.body, ...(n ? { example: { body_text: [t.examples.slice(0, n)] } } : {}) }] };
}

/**
 * A numbered text menu ("intro\n\n1. a\n2. b\n0. person") back into its intro and options, so the same menu can be sent as buttons or a list.
 * The numbers must be 1..n in order, optionally followed by 0 (the "person" option); anything else is not treated as a menu.
 */
export function parseNumberedMenu(text: string): { body: string; options: MenuOption[] } | null {
  const lines = text.split('\n');
  const opts: MenuOption[] = [];
  let i = lines.length - 1;
  for (; i >= 0; i--) {
    const m = /^\s*(\d{1,2})\.\s+(\S.*)$/.exec(lines[i]!);
    if (!m) break;
    opts.unshift({ id: m[1]!, title: m[2]!.trim() });
  }
  const body = lines.slice(0, i + 1).join('\n').trim();
  if (opts.length < 2 || body === '') return null;
  const ids = opts.map((o) => Number(o.id));
  const main = ids[ids.length - 1] === 0 ? ids.slice(0, -1) : ids;
  if (!main.every((n, k) => n === k + 1) || main.length === 0) return null;
  return { body, options: opts };
}

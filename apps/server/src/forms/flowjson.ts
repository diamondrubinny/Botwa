import type { Field } from './schema.js';

/**
 * A form template as a WhatsApp Flow (Flow JSON, no endpoint): the signer fills the fields in WhatsApp's own screens and the
 * answers come back in the chat as an "nfm_reply" message (see whatsapp-cloud.ts). Rules from Meta's Flows documentation
 * (Components, Flow JSON, versioning, read 2026-11-13; verify against the official reference, it changes):
 *  - Flow JSON 7.3 (recommended); values on other screens are read with ${screen.<ID>.form.<name>} (global references)
 *  - TextInput / TextArea / DatePicker labels: up to 20 characters; helper text up to 80; OptIn label up to 120, at most 5 per screen
 *  - no drawn-signature component: signing = an explicit OptIn statement and the full name typed
 *  - "SUCCESS" is a reserved screen id; DatePicker values are "YYYY-MM-DD" (Flow JSON 5.0+)
 */
export const FLOW_JSON_VERSION = '7.3';
export const LABEL_MAX = 20;
const HELPER_MAX = 80;
const OPTIN_MAX = 120;
const PER_SCREEN = 8;
const OPTINS_PER_SCREEN = 5;
/** Beyond this a form is too long to fill comfortably in WhatsApp: the link stays the way to fill it. */
export const MAX_FLOW_FIELDS = 60;

export const SIGN_STATEMENT = 'אני מאשר/ת שהפרטים נכונים, ומסכים/ה שהשם המלא שהקלדתי ישמש כחתימה אלקטרונית שלי על המסמך.';
export const SIGN_NAME_LABEL = 'שם מלא (חתימה)';
const CONSENT = 'consent';
const SIGNER = 'signer_name';

/** A label of at most 20 characters: whole words where possible, otherwise cut. */
export function shortLabel(label: string, max = LABEL_MAX): string {
  const s = label.replace(/\s+/g, ' ').replace(/[:*]+\s*$/, '').trim();
  if (s.length <= max) return s;
  const words = s.split(' ');
  let out = '';
  for (const w of words) { if ((out ? out.length + 1 : 0) + w.length > max) break; out = out ? `${out} ${w}` : w; }
  return out.length >= 3 ? out : s.slice(0, max).trim();
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

export interface FlowBuild {
  json: Record<string, unknown>;
  /** component name -> template field id (Meta names are kept simple: f0, f1…) */
  names: Record<string, string>;
  problems: string[];
}

/** Fields filled in WhatsApp: not signatures (signed at the end), not locked system values (the server keeps those). */
const asked = (fields: Field[]) => fields.filter((f) => f.type !== 'signature' && f.type !== 'initials' && !(f.locked && f.prefill));
export const hasSignature = (fields: Field[]) => fields.some((f) => f.type === 'signature' || f.type === 'initials');

/**
 * The Flow JSON for a template. Prefilled values are sent with each request (flow_action_payload.data) and appear as initial
 * values, so one published Flow serves every request of the template. labels: short labels chosen in the editor.
 */
export function buildFlowJson(title: string, fields: Field[], labels: Record<string, string> = {}): FlowBuild {
  const problems: string[] = [];
  const inputs = asked(fields);
  if (inputs.length + 2 > MAX_FLOW_FIELDS) problems.push('too_many_fields');
  const names: Record<string, string> = {};
  /** a system prefill (contact name, today…) becomes the initial value; the first screen reads its own data, the others the first screen's */
  const component = (f: Field, name: string, first: boolean): Record<string, unknown> => {
    const label = shortLabel(labels[f.id] || f.label);
    const helper = f.hint ? clip(f.hint, HELPER_MAX) : (label !== f.label.trim() ? clip(f.label, HELPER_MAX) : undefined);
    const init = f.prefill ? { 'init-value': first ? `\${data.p_${name}}` : `\${screen.S1.data.p_${name}}` } : {};
    const base = { name, label, required: f.required, ...(helper ? { 'helper-text': helper } : {}) };
    switch (f.type) {
      case 'textarea': return { type: 'TextArea', ...base, ...init };
      case 'date': return { type: 'DatePicker', ...base, ...init };
      case 'checkbox': return { type: 'OptIn', name, label: clip(f.label, OPTIN_MAX), required: f.required };
      case 'number': return { type: 'TextInput', 'input-type': 'number', ...base, ...init };
      case 'email': return { type: 'TextInput', 'input-type': 'email', ...base, ...init };
      case 'phone': return { type: 'TextInput', 'input-type': 'phone', ...base, ...init };
      // text with a pattern (Flow JSON 6.2+), so leading zeros stay
      case 'id_number': return { type: 'TextInput', 'input-type': 'text', pattern: '^[0-9]{5,9}$', ...base, ...init };
      default: return { type: 'TextInput', 'input-type': 'text', ...base, ...init };
    }
  };
  // screens: up to 8 inputs (and 5 opt-ins) each; the last screen is the signature
  const screens: { id: string; items: Record<string, unknown>[] }[] = [];
  let cur: Record<string, unknown>[] = [];
  let optins = 0;
  inputs.forEach((f, i) => {
    const name = `f${i}`;
    names[name] = f.id;
    const isOpt = f.type === 'checkbox';
    if (cur.length >= PER_SCREEN || (isOpt && optins >= OPTINS_PER_SCREEN)) { screens.push({ id: `S${screens.length + 1}`, items: cur }); cur = []; optins = 0; }
    cur.push(component(f, name, screens.length === 0));
    if (isOpt) optins++;
  });
  if (cur.length) screens.push({ id: `S${screens.length + 1}`, items: cur });
  const signId = `S${screens.length + 1}`;
  const all = [...screens.map((s) => s.id), signId];
  const ref = (name: string) => {
    const s = screens.find((x) => x.items.some((c) => c.name === name));
    return `\${screen.${s!.id}.form.${name}}`;
  };
  const sign = hasSignature(fields);
  const payload: Record<string, string> = Object.fromEntries(Object.keys(names).map((n) => [n, ref(n)]));
  payload[CONSENT] = `\${form.${CONSENT}}`;
  if (sign) payload[SIGNER] = `\${form.${SIGNER}}`;
  // the initial values of the first screen's data, declared with examples (Meta validates the data model)
  const prefillData = Object.fromEntries(Object.keys(names).filter((n) => { const f = inputs[Number(n.slice(1))]!; return !!f.prefill && f.type !== 'checkbox'; }).map((n) => [`p_${n}`, { type: 'string', __example__: '' }]));
  const out = all.map((id, idx) => {
    const last = idx === all.length - 1;
    const children: Record<string, unknown>[] = [];
    if (idx === 0) children.push({ type: 'TextSubheading', text: clip(title, 80) });
    if (!last) {
      children.push(...screens[idx]!.items);
      children.push({ type: 'Footer', label: 'המשך', 'on-click-action': { name: 'navigate', next: { type: 'screen', name: all[idx + 1] }, payload: {} } });
    } else {
      children.push({ type: 'TextBody', text: sign ? 'כדי לחתום: אשרו את ההצהרה והקלידו את שמכם המלא.' : 'אשרו שהפרטים נכונים ושלחו.' });
      children.push({ type: 'OptIn', name: CONSENT, label: clip(sign ? SIGN_STATEMENT : 'אני מאשר/ת שהפרטים שמילאתי נכונים.', OPTIN_MAX), required: true });
      if (sign) children.push({ type: 'TextInput', 'input-type': 'text', name: SIGNER, label: SIGN_NAME_LABEL, required: true, 'min-chars': 2, 'max-chars': 80 });
      children.push({ type: 'Footer', label: sign ? 'חתימה ושליחה' : 'שליחה', 'on-click-action': { name: 'complete', payload } });
    }
    return {
      id, title: clip(last ? (sign ? 'חתימה' : 'אישור ושליחה') : title, 30),
      ...(idx === 0 && Object.keys(prefillData).length ? { data: prefillData } : { data: {} }),
      ...(last ? { terminal: true, success: true } : {}),
      layout: { type: 'SingleColumnLayout', children },
    };
  });
  return { json: { version: FLOW_JSON_VERSION, screens: out }, names, problems };
}

/** The first-screen data of one request: its prefilled values (Meta: "must be a non-empty object" when given). */
export function flowStartData(fields: Field[], names: Record<string, string>, prefill: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [n, id] of Object.entries(names)) {
    const f = fields.find((x) => x.id === id);
    if (!f || f.type === 'checkbox' || !f.prefill) continue;
    out[`p_${n}`] = String(prefill[id] ?? '').slice(0, 2000);
  }
  return out;
}

/** The answers in a Flow reply, mapped back to the template's field ids. Unknown keys are ignored. */
export function parseFlowReply(responseJson: string, names: Record<string, string>): { token: string | null; values: Record<string, unknown>; consent: boolean; signer: string | null } | null {
  let j: unknown;
  try { j = JSON.parse(responseJson); } catch { return null; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const o = j as Record<string, unknown>;
  const values: Record<string, unknown> = {};
  for (const [n, id] of Object.entries(names)) if (n in o) values[id] = o[n];
  const signer = typeof o[SIGNER] === 'string' ? (o[SIGNER] as string).replace(/\s+/g, ' ').trim().slice(0, 80) : null;
  return { token: typeof o.flow_token === 'string' ? o.flow_token : null, values, consent: o[CONSENT] === true || o[CONSENT] === 'true', signer: signer || null };
}

/** Initials of a typed name ("דנה לוי" -> "ד.ל."). */
export const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 3).map((w) => `${[...w][0]}.`).join('');

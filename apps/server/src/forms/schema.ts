import { z } from 'zod';

/** What a field holds. "signature" and "initials" are drawn (or typed) by the signer; the others are text or a tick. */
export const FIELD_TYPES = ['text', 'textarea', 'date', 'id_number', 'phone', 'email', 'number', 'checkbox', 'signature', 'initials'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
/** Filled in by the system when the form is sent (the signer may still change them unless locked). */
export const PREFILLS = ['contact_name', 'contact_phone', 'today', 'agent_name', 'case_number'] as const;

export const fieldSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,40}$/i),
  type: z.enum(FIELD_TYPES),
  label: z.string().trim().min(1).max(80),
  page: z.number().int().min(0).max(199),
  // box in PDF points, origin at the bottom-left of the page (as pdf-lib draws)
  x: z.number().min(0).max(5000), y: z.number().min(0).max(5000), w: z.number().min(6).max(5000), h: z.number().min(6).max(2000),
  required: z.boolean().default(true),
  prefill: z.enum(PREFILLS).nullable().default(null),
  locked: z.boolean().default(false),          // a prefilled value the signer cannot change
  hint: z.string().trim().max(160).default(''),
});
export type Field = z.infer<typeof fieldSchema>;
export const fieldsSchema = z.array(fieldSchema).max(200).refine((a) => new Set(a.map((f) => f.id)).size === a.length, 'duplicate field id');

export const AUDIENCES = ['employee', 'contractor', 'student', 'guest', 'customer'] as const;

/** A value as the signer may send it; checked against the field type before anything is drawn. */
export function checkValue(f: Field, v: unknown): { ok: true; value: string | boolean | null } | { ok: false; reason: string } {
  if (f.type === 'checkbox') return v === true || v === false || v == null ? { ok: true, value: v === true } : { ok: false, reason: 'checkbox' };
  if (f.type === 'signature' || f.type === 'initials') return { ok: true, value: null };   // drawn separately
  if (v == null || v === '') return f.required ? { ok: false, reason: 'required' } : { ok: true, value: null };
  if (typeof v !== 'string') return { ok: false, reason: 'type' };
  const s = v.replace(/[\u0000-\u0008\u000B-\u001F\u007F‎‏‪-‮⁦-⁩]/g, '').trim();   // no control or direction-override characters
  if (!s) return f.required ? { ok: false, reason: 'required' } : { ok: true, value: null };
  const max = f.type === 'textarea' ? 2000 : 300;
  if (s.length > max) return { ok: false, reason: 'too_long' };
  if (f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(s)) return { ok: false, reason: 'date' };
  if (f.type === 'id_number' && !validIsraeliId(s)) return { ok: false, reason: 'id_number' };
  if (f.type === 'phone' && !/^\+?[0-9][0-9 -]{6,18}[0-9]$/.test(s)) return { ok: false, reason: 'phone' };
  if (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return { ok: false, reason: 'email' };
  if (f.type === 'number' && !/^-?\d+(\.\d+)?$/.test(s)) return { ok: false, reason: 'number' };
  return { ok: true, value: s };
}

/** Israeli ID number with its check digit (up to 9 digits, padded with zeros). */
export function validIsraeliId(raw: string): boolean {
  const d = raw.replace(/\D/g, '');
  if (!d || d.length > 9 || d !== raw.replace(/[\s-]/g, '')) return false;
  const s = d.padStart(9, '0');
  let sum = 0;
  for (let i = 0; i < 9; i++) { let n = Number(s[i]) * ((i % 2) + 1); if (n > 9) n -= 9; sum += n; }
  return sum % 10 === 0 && Number(s) > 0;
}

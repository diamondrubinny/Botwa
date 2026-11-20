/** Phone and e-mail as typed by a customer, normalised for matching only (never shown as verified). */

/** Digits only, international form without '+'. A local number starting with 0 gets the default country code (Israel: 972). */
export function normalizePhone(raw: string | null | undefined, countryCode = '972'): string | null {
  if (!raw) return null;
  let d = raw.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = countryCode + d.slice(1);
  d = d.replace(/\D/g, '');
  return /^\d{8,15}$/.test(d) ? d : null;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim().toLowerCase();
  return /^[^\s@<>"']{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$/.test(v) ? v : null;
}

/** SQL: the e-mail a contact row is known by: an e-mail channel's sender address, else what the customer typed (lower case). */
export const EMAIL_OF = (t: string) => `COALESCE(lower(${t}.claimed_email), CASE WHEN ${t}.external_id ~ '^[^@\\s]+@[^@\\s]+\\.[A-Za-z]{2,}$' AND ${t}.external_id NOT LIKE '%@s.whatsapp.net' THEN lower(${t}.external_id) END)`;

/** SQL: the phone a contact row is known by: the WhatsApp number in its id (verified), else what the customer typed. */
export const PHONE_OF = (t: string) => `CASE WHEN ${t}.external_id LIKE '%@s.whatsapp.net' THEN split_part(${t}.external_id, '@', 1) ELSE ${t}.claimed_phone END`;

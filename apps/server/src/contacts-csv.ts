/** Contact CSV import helpers: tolerant parsing, strict phone normalisation. Pure, so they are unit-tested without a database. */

export const MAX_IMPORT_BYTES = 1_000_000;
export const MAX_IMPORT_ROWS = 5000;

/** RFC-4180-ish parser; auto-detects , ; or tab; strips a BOM; handles quotes and embedded newlines. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const first = src.split(/\r?\n/, 1)[0] ?? '';
  const delim = [',', ';', '\t'].map((d) => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (q) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
    } else if (ch === '"' && cell === '') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

const PHONE_HEADERS = ['phone', 'mobile', 'number', 'external_id', 'טלפון', 'נייד', 'מספר', 'פלאפון'];
const NAME_HEADERS = ['name', 'display_name', 'full_name', 'שם', 'שם מלא'];

/** Returns the column indexes of phone and name, or null when there is no recognisable phone column. */
export function findColumns(header: string[]): { phone: number; name: number } | null {
  const h = header.map((c) => c.trim().toLowerCase());
  const phone = h.findIndex((c) => PHONE_HEADERS.includes(c));
  if (phone < 0) return null;
  return { phone, name: h.findIndex((c) => NAME_HEADERS.includes(c)) };
}

/** International digits for a phone as typed; null when it cannot be a mobile/landline number. Local 0-prefixed numbers get the default country code. */
export function normalizePhone(raw: string, defaultCountry = '972'): string | null {
  let s = raw.trim().replace(/[\s\-().]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  else if (s.startsWith('00')) s = s.slice(2);
  else if (s.startsWith('0')) s = defaultCountry + s.slice(1);
  if (!/^[1-9]\d{7,14}$/.test(s)) return null;
  return s;
}

// eslint-disable-next-line no-control-regex
export const cleanName = (raw: string): string => raw.replace(/[\u0000-\u001f\u007f‎‏‪-‮]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);

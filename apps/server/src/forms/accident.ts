import fontkit from '@pdf-lib/fontkit';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PDFDocument, rgb } from 'pdf-lib';
import type { Db } from '../db.js';
import { forPdf } from './bidi.js';
import { fieldsSchema, type Field } from './schema.js';

/**
 * The built-in "accident / near-miss report" form: a one-page PDF drawn here (Hebrew labels, a box for each answer) with its fields
 * already placed, so it can be sent from the flow at once (inside WhatsApp, or as a link to sign). The unit can edit it like any form.
 */
const FONT = readFileSync(new URL('./fonts/Heebo-Regular.ttf', import.meta.url));
export const ACCIDENT_SOURCE = 'botwa:accident';
export const ACCIDENT_TITLE = 'דיווח תאונה / אירוע "כמעט ונפגע"';

const W = 595.28, H = 841.89, R = 545, BOX_X = 50, BOX_W = 330;
type Row = { id: string; label: string; type: Field['type']; h: number; required: boolean; prefill?: Field['prefill']; hint?: string };
const ROWS: Row[] = [
  { id: 'reporter', label: 'שם המדווח/ת', type: 'text', h: 22, required: true, prefill: 'contact_name' },
  { id: 'phone', label: 'טלפון', type: 'phone', h: 22, required: false, prefill: 'contact_phone' },
  { id: 'date', label: 'תאריך האירוע', type: 'date', h: 22, required: true, prefill: 'today' },
  { id: 'time', label: 'שעה (בערך)', type: 'text', h: 22, required: true },
  { id: 'place', label: 'מיקום מדויק (בניין, קומה, חדר)', type: 'text', h: 22, required: true },
  { id: 'kind', label: 'סוג: תאונה / כמעט ונפגע', type: 'text', h: 22, required: true },
  { id: 'what', label: 'מה קרה', type: 'textarea', h: 90, required: true, hint: 'תארו בקצרה את האירוע ואת הנסיבות' },
  { id: 'injured', label: 'היו נפגעים', type: 'checkbox', h: 16, required: false },
  { id: 'injury', label: 'פרטי הפגיעה והטיפול שניתן', type: 'textarea', h: 60, required: false },
  { id: 'witnesses', label: 'עדים (שמות)', type: 'text', h: 22, required: false },
  { id: 'actions', label: 'מה נעשה מיד אחרי האירוע', type: 'textarea', h: 60, required: false },
  { id: 'signature', label: 'חתימה', type: 'signature', h: 50, required: true },
];

export async function buildAccidentForm(): Promise<{ pdf: Buffer; fields: Field[]; pages: { w: number; h: number }[] }> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(FONT, { subset: true });
  const page = doc.addPage([W, H]);
  const text = (s: string, x: number, y: number, size: number, color = rgb(0, 0, 0)) => { const v = forPdf(s); page.drawText(v, { x: x - font.widthOfTextAtSize(v, size), y, size, font, color }); };
  text(ACCIDENT_TITLE, R, H - 70, 18, rgb(0.08, 0.12, 0.35));
  text('יש למלא בהקדם, ובכל מקרה חירום להתקשר מיד לגורמי החירום (מד"א 101, כבאות והצלה 102).', R, H - 92, 9.5, rgb(0.35, 0.35, 0.4));
  let y = H - 130;
  const fields: Field[] = [];
  for (const r of ROWS) {
    const boxW = r.type === 'checkbox' ? 16 : BOX_W;
    const boxX = r.type === 'checkbox' ? BOX_X + BOX_W - 16 : BOX_X;
    text(r.label + (r.required ? ' *' : ''), R, y - 14, 10.5);
    page.drawRectangle({ x: boxX, y: y - r.h, width: boxW, height: r.h, borderColor: rgb(0.6, 0.62, 0.7), borderWidth: 0.8 });
    fields.push({ id: r.id, type: r.type, label: r.label, page: 0, x: boxX, y: y - r.h, w: boxW, h: r.h, required: r.required, prefill: r.prefill ?? null, locked: false, hint: r.hint ?? '' });
    y -= r.h + 16;
  }
  doc.setTitle(ACCIDENT_TITLE); doc.setProducer('Botwa'); doc.setCreator('Botwa');
  return { pdf: Buffer.from(await doc.save({ useObjectStreams: true })), fields: fieldsSchema.parse(fields), pages: [{ w: W, h: H }] };
}

/** The accident form template: the existing one (built here before, still active), else a new one. */
export async function ensureAccidentTemplate(db: Db, userId: string): Promise<{ id: string; created: boolean }> {
  const cur = (await db.query(`SELECT id FROM form_templates WHERE source_name = $1 AND active ORDER BY created_at DESC LIMIT 1`, [ACCIDENT_SOURCE])).rows[0];
  if (cur) return { id: cur.id, created: false };
  const f = await buildAccidentForm();
  const r = await db.query(
    `INSERT INTO form_templates (title, description, audience, source_pdf, source_name, sha256, pages, fields, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [ACCIDENT_TITLE, 'טופס מובנה של המערכת: דיווח על תאונה או אירוע "כמעט ונפגע". אפשר לערוך את השדות כמו בכל טופס.', ['employee', 'student', 'contractor', 'guest'],
      f.pdf, ACCIDENT_SOURCE, createHash('sha256').update(f.pdf).digest('hex'), JSON.stringify(f.pages), JSON.stringify(f.fields), userId]);
  return { id: r.rows[0].id, created: true };
}

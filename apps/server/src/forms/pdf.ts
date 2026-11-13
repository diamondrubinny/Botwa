import { readFileSync } from 'node:fs';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { forPdf as visualOrder, hasRtl } from './bidi.js';
import type { Field } from './schema.js';

const FONT = readFileSync(new URL('./fonts/Heebo-Regular.ttf', import.meta.url));
const INK = rgb(0.06, 0.12, 0.42);   // dark blue: what was filled in stands apart from the printed form

export interface SignatureMark { png?: Buffer; typed?: string }
export interface SigningRecord {
  formTitle: string; requestNumber: number; signerName: string | null; signerPhone: string | null;
  verifiedAt: Date; signedAt: Date; ip: string | null; userAgent: string | null; templateSha256: string; valuesSha256: string; org: string;
  /** how the signer's identity was established, when not by the one-time code (e.g. filled inside WhatsApp) */
  identity?: string;
}

const fmtDate = (iso: string) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
const when = (d: Date) => d.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', dateStyle: 'short', timeStyle: 'medium' });

/** Fits one line of text into a box: right-aligned for Hebrew, left-aligned otherwise, shrinking the size down to 6pt. */
function drawLine(page: PDFPage, font: PDFFont, text: string, box: { x: number; y: number; w: number; h: number }, maxSize = 11) {
  const vis = visualOrder(text);
  let size = Math.min(maxSize, Math.max(6, box.h - 3));
  while (size > 6 && font.widthOfTextAtSize(vis, size) > box.w - 2) size -= 0.5;
  let s = vis;
  while (s.length > 1 && font.widthOfTextAtSize(s, size) > box.w - 2) s = hasRtl(text) ? s.slice(1) : s.slice(0, -1);   // cut what does not fit (the end of the text)
  const width = font.widthOfTextAtSize(s, size);
  const x = hasRtl(text) ? box.x + box.w - width - 1 : box.x + 1;
  page.drawText(s, { x, y: box.y + Math.max(1, (box.h - size) / 2 + size * 0.15), size, font, color: INK });
}

function drawWrapped(page: PDFPage, font: PDFFont, text: string, box: { x: number; y: number; w: number; h: number }) {
  const size = 9; const lh = size * 1.3;
  const words = text.split(/\s+/); const lines: string[] = []; let cur = '';
  for (const w of words) { const t = cur ? `${cur} ${w}` : w; if (font.widthOfTextAtSize(visualOrder(t), size) > box.w - 2 && cur) { lines.push(cur); cur = w; } else cur = t; }
  if (cur) lines.push(cur);
  const max = Math.max(1, Math.floor(box.h / lh));
  lines.slice(0, max).forEach((l, i) => drawLine(page, font, l, { x: box.x, y: box.y + box.h - lh * (i + 1), w: box.w, h: lh }, size));
}

/**
 * The signed document: the template's pages with every value drawn in its place (no form fields remain to edit), followed by a
 * signature record page (who, when, how they were verified, from where, and fingerprints of the template and the values).
 */
export async function buildSignedPdf(source: Buffer, fields: Field[], values: Record<string, string | boolean | null>, marks: Record<string, SignatureMark>, rec: SigningRecord): Promise<Buffer> {
  const doc = await PDFDocument.load(source, { ignoreEncryption: false, updateMetadata: false });
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(FONT, { subset: true });
  try { doc.getForm().flatten(); } catch { /* no form in the template */ }
  const pages = doc.getPages();
  for (const f of fields) {
    const page = pages[f.page];
    if (!page) continue;
    const box = { x: f.x, y: f.y, w: f.w, h: f.h };
    if (f.type === 'signature' || f.type === 'initials') {
      const m = marks[f.id];
      if (m?.png) {
        const img = await doc.embedPng(m.png);
        const scale = Math.min(box.w / img.width, box.h / img.height);
        const w = img.width * scale, h = img.height * scale;
        page.drawImage(img, { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, width: w, height: h });
      } else if (m?.typed) drawLine(page, font, m.typed, box, 14);
      continue;
    }
    const v = values[f.id];
    if (f.type === 'checkbox') {
      if (v === true) {
        const s = Math.min(box.w, box.h) * 0.8, cx = box.x + box.w / 2, cy = box.y + box.h / 2;
        page.drawLine({ start: { x: cx - s / 2, y: cy }, end: { x: cx - s / 8, y: cy - s / 2.5 }, thickness: 1.6, color: INK });
        page.drawLine({ start: { x: cx - s / 8, y: cy - s / 2.5 }, end: { x: cx + s / 2, y: cy + s / 2 }, thickness: 1.6, color: INK });
      }
      continue;
    }
    if (typeof v !== 'string' || !v) continue;
    const text = f.type === 'date' ? fmtDate(v) : v;
    if (f.type === 'textarea') drawWrapped(page, font, text, box); else drawLine(page, font, text, box);
  }

  // the signature record page
  const first = pages[0]!;
  const { width, height } = first.getSize();
  const p = doc.addPage([width, height]);
  const right = width - 50; let y = height - 70;
  const line = (label: string, value: string, size = 11) => {
    const l = visualOrder(label);
    p.drawText(l, { x: right - font.widthOfTextAtSize(l, size), y, size, font, color: rgb(0.2, 0.2, 0.25) });
    const v = visualOrder(value || '—');
    const vx = right - 170 - font.widthOfTextAtSize(v, size);
    p.drawText(v, { x: Math.max(50, vx), y, size, font, color: rgb(0, 0, 0) });
    y -= size * 2;
  };
  const head = visualOrder('תיעוד חתימה אלקטרונית');
  p.drawText(head, { x: right - font.widthOfTextAtSize(head, 18), y, size: 18, font }); y -= 40;
  line('מסמך', rec.formTitle);
  line('מספר בקשה', String(rec.requestNumber));
  line('שם החותם', rec.signerName ?? '');
  line('טלפון / ערוץ', rec.signerPhone ?? '');
  line('אימות זהות', rec.identity ?? `קוד חד-פעמי לאותה שיחה, ${when(rec.verifiedAt)}`);
  line('נחתם', when(rec.signedAt));
  line('כתובת IP', rec.ip ?? '');
  line('דפדפן', (rec.userAgent ?? '').slice(0, 70));
  line('טביעת התבנית (SHA-256)', rec.templateSha256.slice(0, 32), 9);
  line('', rec.templateSha256.slice(32), 9);
  line('טביעת הערכים (SHA-256)', rec.valuesSha256.slice(0, 32), 9);
  line('', rec.valuesSha256.slice(32), 9);
  y -= 10;
  for (const t of [
    'החותם אישר שקרא את המסמך ושהפרטים שמילא נכונים, וחתם עליו באופן אלקטרוני.',
    `המסמך נוצר ונשמר במערכת ${rec.org}. כל שינוי בקובץ ישנה את הטביעה שלו,`,
    'ואפשר לבדוק עותק מול המערכת ("בדיקת קובץ חתום").',
  ]) { const v = visualOrder(t); p.drawText(v, { x: right - font.widthOfTextAtSize(v, 10), y, size: 10, font }); y -= 16; }

  doc.setTitle(rec.formTitle); doc.setProducer('Botwa'); doc.setCreator('Botwa'); doc.setModificationDate(rec.signedAt);
  return Buffer.from(await doc.save({ useObjectStreams: true }));
}

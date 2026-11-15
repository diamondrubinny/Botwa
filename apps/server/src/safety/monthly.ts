import fontkit from '@pdf-lib/fontkit';
import { readFileSync } from 'node:fs';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { Db } from '../db.js';
import { forPdf as visualOrder } from '../forms/bidi.js';   // fontkit reverses Hebrew runs itself: hand it the reverse of the visual order
import { hazardsByBuildingRange, safetyReportRange, type SafetyKind } from './report.js';

/**
 * Reports > the monthly safety report (PDF, Hebrew, for the management): urgency and hazards, hazards by building, periodic
 * inspections, inquiries and response times for one calendar month. Counts and times only, no customer names or message text.
 */
const FONT = readFileSync(new URL('../forms/fonts/Heebo-Regular.ttf', import.meta.url));
const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const KIND: Record<SafetyKind, string> = { emergency: 'מצבי חירום', hazard: 'דיווחי מפגע', worried: 'לקוחות לחוצים', upset: 'לקוחות מתוסכלים' };

export interface MonthlyData {
  month: string; title: string;
  cases: { opened: number; closed: number; medianFirstMinutes: number | null };
  safety: Awaited<ReturnType<typeof safetyReportRange>>;
  buildings: Awaited<ReturnType<typeof hazardsByBuildingRange>>;
  inspections: { done: number; overdue: number; upcoming: { title: string; place: string; due: string; who: string | null }[] };
}

/** Jerusalem calendar month "YYYY-MM": its start and end. */
export function monthRange(month: string): { from: Date; to: Date } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const at = (yy: number, mm: number) => new Date(`${yy}-${String(mm).padStart(2, '0')}-01T00:00:00+02:00`);   // Israel winter offset; within an hour either way
  return { from: at(y, m), to: m === 12 ? at(y + 1, 1) : at(y, m + 1) };
}

export async function monthlyData(db: Db, month: string): Promise<MonthlyData> {
  const { from, to } = monthRange(month);
  const [y, m] = month.split('-').map(Number) as [number, number];
  const cases = (await db.query(
    `SELECT count(*) FILTER (WHERE k.opened_at >= $1 AND k.opened_at < $2)::int AS opened, count(*) FILTER (WHERE k.closed_at >= $1 AND k.closed_at < $2)::int AS closed,
            round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM r.reply - k.opened_at)) FILTER (WHERE r.reply IS NOT NULL AND k.opened_at >= $1 AND k.opened_at < $2) / 60)::numeric, 1)::float AS "medianFirstMinutes"
       FROM cases k LEFT JOIN LATERAL (SELECT min(m.created_at) AS reply FROM messages m WHERE m.conversation_id = k.conversation_id AND m.direction = 'out' AND NOT m.auto AND m.created_at > k.opened_at) r ON true
      WHERE (k.opened_at >= $1 AND k.opened_at < $2) OR (k.closed_at >= $1 AND k.closed_at < $2)`, [from, to])).rows[0];
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000);
  const done = (await db.query('SELECT count(*)::int AS n FROM inspection_log WHERE done_at >= $1 AND done_at < $2', [from, to])).rows[0].n as number;
  const overdue = (await db.query(`SELECT count(*)::int AS n FROM inspections WHERE active AND next_due < (now() AT TIME ZONE 'Asia/Jerusalem')::date`)).rows[0].n as number;
  const upcoming = (await db.query(`SELECT i.title, i.place, to_char(i.next_due, 'DD/MM/YYYY') AS due, COALESCE(u.name_he, u.name) AS who FROM inspections i LEFT JOIN users u ON u.id = i.assignee
      WHERE i.active AND i.next_due <= (now() AT TIME ZONE 'Asia/Jerusalem')::date + 30 ORDER BY i.next_due LIMIT 15`)).rows;
  return {
    month, title: `דוח בטיחות חודשי – ${MONTHS[m - 1]} ${y}`,
    cases: { opened: cases?.opened ?? 0, closed: cases?.closed ?? 0, medianFirstMinutes: cases?.medianFirstMinutes ?? null },
    safety: await safetyReportRange(db, from, to, days),
    buildings: (await hazardsByBuildingRange(db, from, to)).slice(0, 15),
    inspections: { done, overdue, upcoming },
  };
}

class Writer {
  page!: PDFPage; y = 0;
  readonly W = 595.28; readonly H = 841.89; readonly R = 595.28 - 50; readonly L = 50;
  constructor(readonly doc: PDFDocument, readonly font: PDFFont) { this.newPage(); }
  newPage() { this.page = this.doc.addPage([this.W, this.H]); this.y = this.H - 60; }
  need(h: number) { if (this.y - h < 60) this.newPage(); }
  /** right-aligned Hebrew text (visual order for pdf-lib), cut to fit */
  text(s: string, x: number, size = 10, color = rgb(0, 0, 0)) {
    let v = visualOrder(s);
    while (v.length > 1 && this.font.widthOfTextAtSize(v, size) > x - this.L + 1) v = v.slice(1);
    this.page.drawText(v, { x: x - this.font.widthOfTextAtSize(v, size), y: this.y, size, font: this.font, color });
  }
  heading(s: string) { this.need(40); this.y -= 8; this.text(s, this.R, 14, rgb(0.1, 0.15, 0.4)); this.y -= 6; this.page.drawLine({ start: { x: this.L, y: this.y }, end: { x: this.R, y: this.y }, thickness: 0.6, color: rgb(0.7, 0.72, 0.8) }); this.y -= 18; }
  line(label: string, value: string) { this.need(16); this.text(label, this.R, 10.5, rgb(0.25, 0.25, 0.3)); this.text(value, this.R - 230, 10.5); this.y -= 16; }
  /** a table: columns from the right; widths in points */
  table(cols: { title: string; w: number }[], rows: string[][]) {
    const draw = (cells: string[], size: number, color = rgb(0, 0, 0)) => { let x = this.R; cells.forEach((c, i) => { this.text(c, x, size, color); x -= cols[i]!.w; }); };
    this.need(20); draw(cols.map((c) => c.title), 9.5, rgb(0.3, 0.3, 0.35)); this.y -= 14;
    for (const r of rows) { this.need(14); draw(r, 9.5); this.y -= 14; }
    this.y -= 6;
  }
  note(s: string) { this.need(14); this.text(s, this.R, 9, rgb(0.35, 0.35, 0.4)); this.y -= 14; }
}

const num = (v: number | null, unit: string) => (v === null ? '—' : `${v} ${unit}`);

export async function monthlyPdf(d: MonthlyData, org: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(FONT, { subset: true });
  const w = new Writer(doc, font);
  w.text(d.title, w.R, 20, rgb(0.08, 0.12, 0.35)); w.y -= 22;
  w.note(`${org} · הופק ב-${new Date().toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' })} · נתונים מצטברים בלבד, ללא פרטי פונים`);
  w.y -= 6;

  w.heading('פניות');
  w.line('פניות שנפתחו', String(d.cases.opened));
  w.line('פניות שנסגרו', String(d.cases.closed));
  w.line('זמן מענה אנושי ראשון (חציון)', num(d.cases.medianFirstMinutes, 'דקות'));

  w.heading('בטיחות ודחיפות');
  const rows = d.safety.rows.filter((r) => r.events);
  if (!rows.length) w.note('לא היו בחודש זה מצבי חירום, דיווחי מפגע או לקוחות לחוצים.');
  else w.table([{ title: 'סוג', w: 140 }, { title: 'כמה', w: 60 }, { title: 'נענו תוך 15 דק׳', w: 110 }, { title: 'מענה (חציון)', w: 100 }, { title: 'בלי מענה אנושי', w: 80 }],
    rows.map((r) => [KIND[r.kind], String(r.events), `${r.within15} מתוך ${r.events}`, num(r.medianMinutes, 'דק׳'), String(r.unanswered)]));
  if (d.safety.topics.length) w.note(`נושאים: ${d.safety.topics.map((t) => `${t.name} (${t.n})`).join(', ')}`);

  w.heading('מפגעים לפי בניין');
  if (!d.buildings.length) w.note('לא היו דיווחי מפגע או חירום בחודש זה.');
  else w.table([{ title: 'בניין', w: 150 }, { title: 'דיווחים', w: 60 }, { title: 'פתוחים', w: 60 }, { title: 'מענה (חציון)', w: 90 }, { title: 'סגירה (חציון)', w: 90 }],
    d.buildings.map((b) => [b.building || 'לא צוין', String(b.reports), String(b.open), num(b.medianReplyMinutes, 'דק׳'), num(b.medianCloseHours, 'שע׳')]));

  w.heading('בדיקות תקופתיות');
  w.line('בדיקות שבוצעו בחודש', String(d.inspections.done));
  w.line('בדיקות באיחור (נכון להיום)', String(d.inspections.overdue));
  if (d.inspections.upcoming.length) {
    w.note('באיחור או ב-30 הימים הקרובים:');
    w.table([{ title: 'בדיקה', w: 170 }, { title: 'מיקום', w: 120 }, { title: 'מועד', w: 80 }, { title: 'אחראי', w: 120 }],
      d.inspections.upcoming.map((i) => [i.title, i.place || '—', i.due, i.who ?? '—']));
  }
  doc.setTitle(d.title); doc.setProducer('Botwa'); doc.setCreator('Botwa');
  return Buffer.from(await doc.save({ useObjectStreams: true }));
}

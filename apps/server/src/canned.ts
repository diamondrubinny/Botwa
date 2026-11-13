import { isOpen, type BusinessHours } from './business-hours.js';

/** The variables a canned reply may contain. Anything else in curly braces is left as typed so the agent sees it. */
export const CANNED_VARIABLES = [
  ['{שם}', 'שם הלקוח'], ['{נציג}', 'שם הנציג ששולח'], ['{תפקיד}', 'התפקיד של הנציג'], ['{טלפון נציג}', 'הטלפון שהנציג בחר להציג'], ['{שעות}', 'שעות הפעילות'], ['{תאריך}', 'התאריך היום'], ['{ערוץ}', 'שם הערוץ'],
] as const;

const DAYS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];

/** "א׳–ה׳ 09:00–17:00, ו׳ 09:00–13:00" from the business hours; "לא הוגדרו שעות פעילות" when none are set. */
export function hoursSummary(h: BusinessHours): string {
  const groups: { from: number; to: number; text: string }[] = [];
  h.days.forEach((d, i) => {
    if (!d) return;
    const text = `${d.open}–${d.close}`;
    const last = groups[groups.length - 1];
    if (last && last.text === text && last.to === i - 1) last.to = i; else groups.push({ from: i, to: i, text });
  });
  if (!groups.length) return 'לא הוגדרו שעות פעילות';
  return groups.map((g) => `${g.from === g.to ? DAYS[g.from] : `${DAYS[g.from]}–${DAYS[g.to]}`} ${g.text}`).join(', ');
}

export interface CannedContext { customerName?: string | null; agentName: string; agentTitle?: string | null; agentPhone?: string | null; hours: BusinessHours; channelLabel?: string | null; now?: Date }

/** Fill the variables of a canned reply. Values are plain text (no markup is interpreted) and stay on one line. */
export function renderCanned(body: string, c: CannedContext): string {
  const one = (s: string | null | undefined) => (s ?? '').replace(/[\r\n]+/g, ' ').trim();
  const date = (c.now ?? new Date()).toLocaleDateString('he-IL', { timeZone: c.hours.timezone, day: 'numeric', month: 'long', year: 'numeric' });
  const vals: Record<string, string> = {
    'שם': one(c.customerName), 'name': one(c.customerName), 'נציג': one(c.agentName), 'agent': one(c.agentName),
    'שעות': hoursSummary(c.hours), 'hours': hoursSummary(c.hours), 'תאריך': date, 'date': date, 'ערוץ': one(c.channelLabel), 'channel': one(c.channelLabel),
    'תפקיד': one(c.agentTitle), 'title': one(c.agentTitle), 'טלפון נציג': one(c.agentPhone), 'agent phone': one(c.agentPhone),
  };
  let empty = false;
  const out = body.replace(/\{([^{}\n]{1,20})\}/g, (m, k: string) => { if (!(k in vals)) return m; if (!vals[k]) empty = true; return vals[k]!; });
  // a variable with no value (no customer name, no role) must not leave "שלום , כאן דנה, ." behind
  return empty ? out.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([,.!?:;])/g, '$1').replace(/,([.!?:;,])/g, '$1').replace(/,\s*$/gm, '').trim() : out;
}

/** Variables in a body that are not known ones, to warn the author. */
export function unknownVariables(body: string): string[] {
  const known = new Set(['שם', 'name', 'נציג', 'agent', 'תפקיד', 'title', 'טלפון נציג', 'agent phone', 'שעות', 'hours', 'תאריך', 'date', 'ערוץ', 'channel']);
  return [...new Set([...body.matchAll(/\{([^{}\n]{1,20})\}/g)].map((m) => m[1]!).filter((k) => !known.has(k)))];
}

export const openNow = (h: BusinessHours) => isOpen(h, new Date());

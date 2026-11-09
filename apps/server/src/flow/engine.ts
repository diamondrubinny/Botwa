import { normalize, waLink } from '../bot.js';
import { NODE_WAITS, type Flow, type FlowNode } from './schema.js';

export type Vars = Record<string, string>;
export interface FlowState {
  /** node the customer is answering now (menu, question, media or list), or null before the first message / after the flow ended */
  node: string | null;
  vars: Vars;
  invalid: number;
  done: boolean;
  /** set when the flow finished without a person taking over: after a while the next message starts it again */
  endedAt?: number;
  /** files received during the flow (photos, documents) */
  files?: number;
  /** progress inside a `list` node */
  list?: { items: string[]; phase: 'item' | 'more' };
  /** "did you mean" candidates offered after a question the knowledge base could not answer with confidence (picked by letter) */
  suggest?: { id: string; label: string }[];
}
export const NEW_FLOW_STATE: FlowState = { node: null, vars: {}, invalid: 0, done: false };

export type Effect =
  | { kind: 'handoff'; reason: 'requested' | 'flow' | 'unrecognized' | 'media'; userId?: string; text?: string; /** the person was chosen by the place the customer named */ viaArea?: boolean; officerTopic?: string; showContact?: boolean }
  | { kind: 'tag'; tagId: string }
  | { kind: 'note'; text: string }
  | { kind: 'name'; value: string }
  | { kind: 'profile'; vars: Vars };

/** What the customer sent: text (null for a message without any), and whether it carried a photo or file. */
export interface FlowInput { text: string | null; media?: boolean }

export interface FlowContext {
  isOpen: boolean;
  channelType: string;
  humanKeywords: string[];
  humanOption: boolean;
  invalidRetries: number;
  invalidMessage: string;
  now?: number;
  /** what is already known about this customer (from earlier conversations), used when a conversation starts */
  profile?: Vars;
  /** confident knowledge-base answer text (already formatted) or null */
  kbAnswer: (text: string) => Promise<string | null>;
  /** index of the option whose meaning matches the free text, or null (needs the local model; returns null when it is off) */
  matchOption: (text: string, options: { label: string; examples: string[] }[]) => Promise<number | null>;
  /** close-but-not-confident knowledge-base entries for a question, offered as "did you mean" (max 3) */
  kbSuggest?: (text: string) => Promise<{ id: string; label: string }[]>;
  /** the formatted answer of one knowledge-base entry chosen from the suggestions */
  kbSource?: (id: string, question: string) => Promise<string | null>;
  /** the person responsible for the area a free text names (building, place), or null */
  resolveArea?: (text: string) => Promise<string | null>;
}

export interface FlowResult { replies: string[]; state: FlowState; effects: Effect[]; /** the last reply is a menu node's numbered menu */ menu?: boolean }
const MAX_STEPS = 60;
export const RESTART_AFTER_MS = 30 * 60_000;
const MENU_WORDS = new Set(['תפריט', 'menu', 'start', 'התחלה', 'תפריט ראשי']);
const SKIP_WORDS = new Set(['דלג', 'דלגי', 'skip', 'לא', 'אין']);
const YES = new Set(['כן', 'yes', 'y', '1', 'עוד']);
const NO = new Set(['לא', 'no', 'n', '2', 'די', 'זהו', 'סיימתי']);
const GREETINGS = new Set(['שלום', 'היי', 'הי', 'הלו', 'אהלן', 'בוקר טוב', 'ערב טוב', 'צהריים טובים', 'תודה', 'תודה רבה', 'ok', 'אוקיי', 'אוקי', 'hello', 'hi']);
const LETTERS = ['א', 'ב', 'ג'];
const DEFAULT_LABELS: Record<string, string> = { name: 'שם', phone: 'טלפון', email: 'אימייל', text: 'פירוט' };

const menuText = (n: Extract<FlowNode, { type: 'menu' }>, humanOption: boolean, humanLabel = 'נציג אנושי') =>
  `${n.text}\n\n${[...n.options.map((o, i) => `${i + 1}. ${o.label}`), ...(humanOption ? [`0. ${humanLabel}`] : [])].join('\n')}`;

function validate(kind: string, raw: string): string | null {
  const t = raw.trim();
  if (kind === 'email') return /^[^\s@]{1,64}@[^\s@]{1,200}\.[^\s@]{2,}$/.test(t) ? t.slice(0, 254) : null;
  if (kind === 'phone') { const d = t.replace(/[\s()-]/g, ''); return /^\+?\d{8,15}$/.test(d) ? d : null; }
  if (kind === 'name') return t.length >= 2 && t.length <= 60 && !/[<>{}\n]/.test(t) ? t : null;
  return t.length >= 1 ? t.slice(0, 500) : null;
}
const QUESTION_WORDS = new Set(['מה', 'מי', 'מתי', 'איך', 'איפה', 'האם', 'כמה', 'למה', 'מדוע', 'מהו', 'מהי', 'אילו', 'איזה', 'איזו', 'היכן', 'אפשר', 'צריך', 'חייב', 'מותר', 'אסור', 'יש']);
/** Looks like a question rather than an answer to "your name / building / ...". */
export const looksLikeQuestion = (t: string): boolean => /[?؟]/.test(t) || QUESTION_WORDS.has(normalize(t).split(' ')[0] ?? '');
const kindOf = (n: Extract<FlowNode, { type: 'question' }>) => n.kind ?? (['name', 'phone', 'email'].includes(n.save) ? n.save : 'text');

/** Run the flow for one customer message. Pure apart from the injected context functions. */
export async function runFlow(flow: Flow, prev: FlowState | null, input: FlowInput | string | null, ctx: FlowContext, humanLabel?: string): Promise<FlowResult> {
  const inp: FlowInput = input !== null && typeof input === 'object' ? input : { text: input };
  const nodes = new Map(flow.nodes.map((n) => [n.id, n]));
  const now = ctx.now ?? Date.now();
  let state: FlowState = prev ? { ...prev, vars: { ...prev.vars } } : { ...NEW_FLOW_STATE, vars: {} };
  if (state.done && state.endedAt && now - state.endedAt > RESTART_AFTER_MS) state = { ...NEW_FLOW_STATE, vars: {} };
  const fresh = state.node === null && !state.done;
  if (fresh && ctx.profile) state = { ...state, vars: { ...ctx.profile, ...state.vars } };
  const replies: string[] = [];
  const effects: Effect[] = [];
  const labels = { ...DEFAULT_LABELS, ...(flow.labels ?? {}) };

  const summary = () => {
    const order = [...Object.keys(flow.labels ?? {}), ...Object.keys(state.vars)];
    const keys = [...new Set(order)].filter((k) => state.vars[k]);
    const parts = keys.map((k) => `${labels[k] ?? k}: ${state.vars[k]}`);
    if (state.files) parts.push(`קבצים שנשלחו: ${state.files}`);
    if (parts.length) effects.push({ kind: 'note', text: `פרטים שנאספו בבוט:\n${parts.join('\n')}` });
  };
  const handoff = (reason: 'requested' | 'flow' | 'unrecognized' | 'media', userId?: string, t?: string, extra: { viaArea?: boolean; officerTopic?: string; showContact?: boolean } = {}): FlowResult => {
    summary();
    effects.push({ kind: 'handoff', reason, userId, text: t, ...extra });
    return { replies, state: { ...state, node: null, list: undefined, done: true }, effects };
  };
  const finished = (): FlowResult => { summary(); return { replies, state: { ...state, node: null, list: undefined, done: true, endedAt: now }, effects }; };

  if (state.done) return { replies: [], state, effects: [] }; // a person (or the end node) has the conversation

  const hasText = inp.text !== null && inp.text.trim() !== '';
  const waiting = state.node ? nodes.get(state.node) : undefined;
  const mediaNode = waiting?.type === 'media';

  // a photo or file where the flow wants text: when files already came in (several photos in a row) stay quiet, else it needs a person
  if (inp.media && state.node !== null && !mediaNode) {
    state = { ...state, files: (state.files ?? 0) + 1 };
    if ((state.files ?? 0) > 1 || (prev?.files ?? 0) > 0) return { replies, state, effects };
    if (!hasText) return handoff('media');
  }
  if (!hasText && !inp.media && state.node !== null) return handoff('media'); // sticker, location...

  const t = hasText ? normalize(inp.text!) : '';
  if (hasText && state.node !== null) {
    if (ctx.humanKeywords.some((k) => t.includes(normalize(k)))) return handoff('requested');
    if (MENU_WORDS.has(t)) state = { ...state, node: null, invalid: 0, list: undefined }; // restart
  }

  // 1. handle the answer to the node we were waiting at
  let cursor: string | undefined;
  const w = state.node ? nodes.get(state.node) : undefined;
  // a letter picks one of the "did you mean" suggestions offered with the last reply
  if (w?.type === 'menu' && state.suggest?.length && hasText) {
    const k = LETTERS.indexOf(t.replace(/[.'׳)]/g, ''));
    const pick = k >= 0 ? state.suggest[k] : undefined;
    if (pick && ctx.kbSource) {
      const a = await ctx.kbSource(pick.id, pick.label).catch(() => null);
      if (a) { replies.push(a, menuText(w, ctx.humanOption, humanLabel)); return { replies, state: { ...state, suggest: undefined, invalid: 0 }, effects, menu: true }; }
    }
  }
  if (state.suggest) state = { ...state, suggest: undefined };
  if (w && state.node !== null) {
    if (w.type === 'menu') {
      let idx: number | null = null;
      if (ctx.humanOption && t === '0') return handoff('requested');
      if (/^\d{1,2}$/.test(t)) idx = Number(t) - 1 < w.options.length ? Number(t) - 1 : null;
      if (idx === null) { const k = w.options.findIndex((o) => normalize(o.label) === t); if (k >= 0) idx = k; }
      if (idx === null && !/^\d{1,2}$/.test(t)) idx = await ctx.matchOption(inp.text!, w.options).catch(() => null);
      if (idx !== null && idx >= 0 && idx < w.options.length) {
        state = { ...state, invalid: 0 };
        if (w.save) state = { ...state, vars: { ...state.vars, [w.save]: w.options[idx]!.label } };
        cursor = w.options[idx]!.next;
        if (!cursor) return finished();
      } else {
        const a = w.kbOnFreeText && !/^\d{1,2}$/.test(t) ? await ctx.kbAnswer(inp.text!).catch(() => null) : null;
        if (a) { replies.push(a); replies.push(menuText(w, ctx.humanOption, humanLabel)); return { replies, state: { ...state, invalid: 0 }, effects, menu: true }; }
        // no confident answer: offer the closest entries ("did you mean")
        const sug = w.kbOnFreeText && ctx.kbSuggest && !/^\d{1,2}$/.test(t) ? (await ctx.kbSuggest(inp.text!).catch(() => [])).slice(0, 3) : [];
        if (sug.length && state.invalid < ctx.invalidRetries) {
          replies.push(`לא מצאתי תשובה מדויקת. האם התכוונתם לאחד מאלה?\n${sug.map((x, i) => `${LETTERS[i]}. ${x.label}`).join('\n')}\n\nכתבו את האות, או בחרו מהתפריט:\n\n${menuText(w, ctx.humanOption, humanLabel)}`);
          return { replies, state: { ...state, suggest: sug, invalid: state.invalid + 1 }, effects, menu: true };
        }
        if (state.invalid < ctx.invalidRetries) { replies.push(`${ctx.invalidMessage}\n\n${menuText(w, ctx.humanOption, humanLabel)}`); return { replies, state: { ...state, invalid: state.invalid + 1 }, effects, menu: true }; }
        return handoff('unrecognized');
      }
    } else if (w.type === 'question' && w.kbAside && hasText && looksLikeQuestion(t) && t.length >= 6) {
      // a question instead of the answer: answer it from the knowledge base and ask again (no progress is lost)
      const a = await ctx.kbAnswer(inp.text!).catch(() => null);
      if (a) return { replies: [a, w.text], state: { ...state, invalid: 0 }, effects };
      if (kindOf(w) === 'name') {
        if (state.invalid < 2) return { replies: [`${w.retryText}\nאם יש לכם שאלה, אפשר לשאול אותה מיד אחרי ההזדהות.`], state: { ...state, invalid: state.invalid + 1 }, effects };
      }
      cursor = undefined;
      // not answerable: treat it like any other answer below
      const v = validate(kindOf(w), inp.text!);
      if (v === null) { if (state.invalid < 2) return { replies: [w.retryText], state: { ...state, invalid: state.invalid + 1 }, effects }; state = { ...state, invalid: 0 }; }
      else state = { ...state, invalid: 0, vars: { ...state.vars, [w.save]: v } };
      cursor = w.next;
      if (!cursor) return finished();
    } else if (w.type === 'question') {
      if (w.optional && SKIP_WORDS.has(t)) {
        state = { ...state, invalid: 0 };
      } else {
        const v = validate(kindOf(w), inp.text!);
        if (v === null) {
          if (state.invalid < 2) { replies.push(w.retryText); return { replies, state: { ...state, invalid: state.invalid + 1 }, effects }; }
          state = { ...state, invalid: 0 }; // give up on this answer and move on
        } else {
          state = { ...state, invalid: 0, vars: { ...state.vars, [w.save]: v } };
          if (kindOf(w) === 'name') effects.push({ kind: 'name', value: v });
        }
      }
      cursor = w.next;
      if (!cursor) return finished();
    } else if (w.type === 'media') {
      const got = inp.media || hasText;
      if (w.optional && !inp.media && SKIP_WORDS.has(t)) { /* skipped */ }
      else if (!got || (!inp.media && !w.allowText)) {
        if (state.invalid < 2) { replies.push(w.retryText); return { replies, state: { ...state, invalid: state.invalid + 1 }, effects }; }
      } else {
        if (inp.media) state = { ...state, files: (state.files ?? 0) + 1 };
        if (hasText && w.save) state = { ...state, vars: { ...state.vars, [w.save]: [state.vars[w.save], inp.text!.trim().slice(0, 500)].filter(Boolean).join(' | ').slice(0, 900) } };
      }
      state = { ...state, invalid: 0 };
      cursor = w.next;
      if (!cursor) return finished();
    } else if (w.type === 'list') {
      const cur = state.list ?? { items: [], phase: 'item' as const };
      if (cur.phase === 'item') {
        const first = cur.items.length === 0;
        if (first && w.optional && SKIP_WORDS.has(t)) {
          state = { ...state, list: undefined, invalid: 0 };
          cursor = w.next;
          if (!cursor) return finished();
        } else {
          const items = [...cur.items, inp.text!.trim().slice(0, 120)];
          if (items.length >= w.max) {
            state = { ...state, vars: { ...state.vars, [w.save]: items.join('; ') }, list: undefined, invalid: 0 };
            cursor = w.next;
            if (!cursor) return finished();
          } else {
            replies.push(`${w.moreText}\n\n1. כן\n2. לא`);
            return { replies, state: { ...state, list: { items, phase: 'more' }, invalid: 0 }, effects };
          }
        }
      } else if (YES.has(t)) {
        replies.push(w.text);
        return { replies, state: { ...state, list: { items: cur.items, phase: 'item' }, invalid: 0 }, effects };
      } else if (NO.has(t)) {
        state = { ...state, vars: { ...state.vars, [w.save]: cur.items.join('; ') }, list: undefined, invalid: 0 };
        cursor = w.next;
        if (!cursor) return finished();
      } else {
        if (state.invalid < 2) { replies.push(`${w.moreText}\n\n1. כן\n2. לא`); return { replies, state: { ...state, invalid: state.invalid + 1 }, effects }; }
        state = { ...state, vars: { ...state.vars, [w.save]: cur.items.join('; ') }, list: undefined, invalid: 0 };
        cursor = w.next;
        if (!cursor) return finished();
      }
    }
  }
  if (!w || state.node === null) {
    cursor = flow.start;
    // flows with kbFirst answer a question in the very first message before anything else (then carry on, e.g. with identification)
    const askable = hasText && !/^\d{1,2}$/.test(t) && !MENU_WORDS.has(t) && !GREETINGS.has(t) && t.length >= 6 && !ctx.humanKeywords.some((k) => t.includes(normalize(k)));
    if (flow.kbFirst && fresh && askable) {
      const a = await ctx.kbAnswer(inp.text!).catch(() => null);
      if (a) replies.push(a);
    }
    // the very first message may already be a question the knowledge base can answer
    const first = nodes.get(flow.start);
    if (first?.type === 'menu' && askable && first.kbOnFreeText && !flow.kbFirst) {
      const a = await ctx.kbAnswer(inp.text!).catch(() => null);
      if (a) { replies.push(a, menuText(first, ctx.humanOption, humanLabel)); return { replies, state: { ...state, node: first.id }, effects, menu: true }; }
    }
  }

  // 2. advance through the graph until something waits for the customer
  const lastText = hasText ? inp.text! : '';
  for (let steps = 0; cursor && steps < MAX_STEPS; steps++) {
    const n = nodes.get(cursor);
    if (!n) break;
    switch (n.type) {
      case 'message': replies.push(n.text); cursor = n.next; break;
      case 'referral': replies.push(`${n.text}\n\n${n.contactName}:\n${waLink(n.phone, n.message)}`); cursor = n.next; break;
      case 'tag': effects.push({ kind: 'tag', tagId: n.tagId }); cursor = n.next; break;
      case 'remember': {
        const keep: Vars = {};
        for (const k of n.vars) if (state.vars[k]) keep[k] = state.vars[k]!;
        effects.push({ kind: 'profile', vars: keep });
        cursor = n.next;
        break;
      }
      case 'condition': {
        const c = n.check;
        const yes = c.kind === 'hours' ? ctx.isOpen : c.kind === 'channel' ? ctx.channelType === c.is : c.kind === 'has' ? !!state.vars[c.name] : (state.vars[c.name] ?? '').toLowerCase().includes(c.contains.toLowerCase());
        cursor = yes ? n.yes : n.no;
        break;
      }
      case 'kb': {
        const a = lastText ? await ctx.kbAnswer(lastText).catch(() => null) : null;
        if (a) replies.push(n.intro ? `${n.intro}\n\n${a}` : a);
        cursor = a ? n.found : n.notFound;
        break;
      }
      case 'menu': replies.push(menuText(n, ctx.humanOption, humanLabel)); return { replies, state: { ...state, node: n.id, invalid: 0 }, effects, menu: true };
      case 'question': case 'media': replies.push(n.text); return { replies, state: { ...state, node: n.id, invalid: 0 }, effects };
      case 'list': replies.push(n.text); return { replies, state: { ...state, node: n.id, invalid: 0, list: { items: [], phase: 'item' } }, effects };
      case 'handoff': {
        let who = n.userId;
        let viaArea = false;
        if (n.areaVars?.length && ctx.resolveArea) {
          for (const v of n.areaVars) { const hit = state.vars[v] ? await ctx.resolveArea(state.vars[v]!).catch(() => null) : null; if (hit) { who = hit; viaArea = true; break; } }
        }
        return handoff('flow', who, n.text || undefined, { viaArea, officerTopic: n.officerTopic, showContact: n.showContact });
      }
      case 'end': if (n.text) replies.push(n.text); return finished();
    }
  }
  return finished(); // fell off the graph (a node without next)
}

export { NODE_WAITS };

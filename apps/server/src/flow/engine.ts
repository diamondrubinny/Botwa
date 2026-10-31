import { normalize, waLink } from '../bot.js';
import { NODE_WAITS, type Flow, type FlowNode } from './schema.js';

export interface FlowState {
  /** node the customer is answering now (a menu or question), or null before the first message / after the flow ended */
  node: string | null;
  vars: Partial<Record<'name' | 'phone' | 'email' | 'text', string>>;
  invalid: number;
  done: boolean;
  /** set when the flow finished without a person taking over: after a while the next message starts it again */
  endedAt?: number;
}
export const NEW_FLOW_STATE: FlowState = { node: null, vars: {}, invalid: 0, done: false };

export type Effect =
  | { kind: 'handoff'; reason: 'requested' | 'flow' | 'unrecognized' | 'media'; userId?: string; text?: string }
  | { kind: 'tag'; tagId: string }
  | { kind: 'note'; text: string }
  | { kind: 'name'; value: string };

export interface FlowContext {
  isOpen: boolean;
  channelType: string;
  humanKeywords: string[];
  humanOption: boolean;
  invalidRetries: number;
  invalidMessage: string;
  now?: number;
  /** confident knowledge-base answer text (already formatted) or null */
  kbAnswer: (text: string) => Promise<string | null>;
  /** index of the option whose meaning matches the free text, or null (needs the local model; returns null when it is off) */
  matchOption: (text: string, options: { label: string; examples: string[] }[]) => Promise<number | null>;
}

export const RESTART_AFTER_MS = 30 * 60_000;
export interface FlowResult { replies: string[]; state: FlowState; effects: Effect[] }
const MAX_STEPS = 40;
const MENU_WORDS = new Set(['תפריט', 'menu', 'start', 'התחלה', 'תפריט ראשי']);

const menuText = (n: Extract<FlowNode, { type: 'menu' }>, humanOption: boolean, humanLabel = 'נציג אנושי') =>
  `${n.text}\n\n${[...n.options.map((o, i) => `${i + 1}. ${o.label}`), ...(humanOption ? [`0. ${humanLabel}`] : [])].join('\n')}`;

function validate(save: string, raw: string): string | null {
  const t = raw.trim();
  if (save === 'email') return /^[^\s@]{1,64}@[^\s@]{1,200}\.[^\s@]{2,}$/.test(t) ? t.slice(0, 254) : null;
  if (save === 'phone') { const d = t.replace(/[\s()-]/g, ''); return /^\+?\d{8,15}$/.test(d) ? d : null; }
  if (save === 'name') return t.length >= 2 && t.length <= 60 && !/[<>{}\n]/.test(t) ? t : null;
  return t.length >= 1 ? t.slice(0, 500) : null;
}

/** Run the flow for one customer message (text null = a non-text message). Pure apart from the injected context functions. */
export async function runFlow(flow: Flow, prev: FlowState | null, text: string | null, ctx: FlowContext, humanLabel?: string): Promise<FlowResult> {
  const nodes = new Map(flow.nodes.map((n) => [n.id, n]));
  const now = ctx.now ?? Date.now();
  let state: FlowState = prev ? { ...prev, vars: { ...prev.vars } } : { ...NEW_FLOW_STATE, vars: {} };
  if (state.done && state.endedAt && now - state.endedAt > RESTART_AFTER_MS) state = { ...NEW_FLOW_STATE, vars: {} };
  const finished = (): FlowResult => { summary(); return { replies, state: { ...state, node: null, done: true, endedAt: now }, effects }; };
  const replies: string[] = [];
  const effects: Effect[] = [];
  const handoff = (reason: 'requested' | 'flow' | 'unrecognized' | 'media', userId?: string, t?: string): FlowResult => {
    summary();
    effects.push({ kind: 'handoff', reason, userId, text: t });
    return { replies, state: { ...state, node: null, done: true }, effects };
  };
  const summary = () => {
    const parts = Object.entries(state.vars).filter(([, v]) => v).map(([k, v]) => `${{ name: 'שם', phone: 'טלפון', email: 'אימייל', text: 'פירוט' }[k]}: ${v}`);
    if (parts.length) effects.push({ kind: 'note', text: `פרטים שנאספו בבוט: ${parts.join(' | ')}` });
  };

  if (state.done) return { replies: [], state, effects: [] }; // a person (or the end node) has the conversation
  if (text === null && state.node !== null) return handoff('media');

  const t = text === null ? '' : normalize(text);
  if (text !== null && state.node !== null) {
    if (ctx.humanKeywords.some((k) => t.includes(normalize(k)))) return handoff('requested');
    if (MENU_WORDS.has(t)) state = { ...state, node: null, invalid: 0 }; // restart
  }

  // 1. handle the answer to the node we were waiting at
  let cursor: string | undefined;
  const waiting = state.node ? nodes.get(state.node) : undefined;
  if (waiting && text !== null && state.node !== null) {
    if (waiting.type === 'menu') {
      let idx: number | null = null;
      if (ctx.humanOption && t === '0') return handoff('requested');
      if (/^\d{1,2}$/.test(t)) idx = Number(t) - 1 < waiting.options.length ? Number(t) - 1 : null;
      if (idx === null) { const k = waiting.options.findIndex((o) => normalize(o.label) === t); if (k >= 0) idx = k; }
      if (idx === null && !/^\d{1,2}$/.test(t)) idx = await ctx.matchOption(text, waiting.options).catch(() => null);
      if (idx !== null && idx >= 0 && idx < waiting.options.length) {
        state = { ...state, invalid: 0 };
        cursor = waiting.options[idx]!.next;
        if (!cursor) return finished();
      } else {
        const a = waiting.kbOnFreeText && !/^\d{1,2}$/.test(t) ? await ctx.kbAnswer(text).catch(() => null) : null;
        if (a) { replies.push(a); replies.push(menuText(waiting, ctx.humanOption, humanLabel)); return { replies, state: { ...state, invalid: 0 }, effects }; }
        if (state.invalid < ctx.invalidRetries) { replies.push(`${ctx.invalidMessage}\n\n${menuText(waiting, ctx.humanOption, humanLabel)}`); return { replies, state: { ...state, invalid: state.invalid + 1 }, effects }; }
        return handoff('unrecognized');
      }
    } else if (waiting.type === 'question') {
      const v = validate(waiting.save, text);
      if (v === null) {
        if (state.invalid < 2) { replies.push(waiting.retryText); return { replies, state: { ...state, invalid: state.invalid + 1 }, effects }; }
        state = { ...state, invalid: 0 }; // give up on this answer and move on
      } else {
        state = { ...state, invalid: 0, vars: { ...state.vars, [waiting.save]: v } };
        if (waiting.save === 'name') effects.push({ kind: 'name', value: v });
      }
      cursor = waiting.next;
      if (!cursor) return finished();
    }
  } else {
    cursor = flow.start;
    // the very first message may already be a question the knowledge base can answer
    const first = nodes.get(flow.start);
    if (first?.type === 'menu' && text !== null && first.kbOnFreeText && !/^\d{1,2}$/.test(t) && !MENU_WORDS.has(t)) {
      const a = await ctx.kbAnswer(text).catch(() => null);
      if (a) { replies.push(a, menuText(first, ctx.humanOption, humanLabel)); return { replies, state: { ...state, node: first.id }, effects }; }
    }
  }

  // 2. advance through the graph until something waits for the customer
  for (let steps = 0; cursor && steps < MAX_STEPS; steps++) {
    const n = nodes.get(cursor);
    if (!n) break;
    switch (n.type) {
      case 'message': replies.push(n.text); cursor = n.next; break;
      case 'referral': replies.push(`${n.text}\n\n${n.contactName}:\n${waLink(n.phone, n.message)}`); cursor = n.next; break;
      case 'tag': effects.push({ kind: 'tag', tagId: n.tagId }); cursor = n.next; break;
      case 'condition': {
        const c = n.check;
        const yes = c.kind === 'hours' ? ctx.isOpen : c.kind === 'channel' ? ctx.channelType === c.is : (state.vars[c.name] ?? '').toLowerCase().includes(c.contains.toLowerCase());
        cursor = yes ? n.yes : n.no;
        break;
      }
      case 'kb': {
        const a = text ? await ctx.kbAnswer(text).catch(() => null) : null;
        if (a) replies.push(n.intro ? `${n.intro}\n\n${a}` : a);
        cursor = a ? n.found : n.notFound;
        break;
      }
      case 'menu': replies.push(menuText(n, ctx.humanOption, humanLabel)); return { replies, state: { ...state, node: n.id, invalid: 0 }, effects };
      case 'question': replies.push(n.text); return { replies, state: { ...state, node: n.id, invalid: 0 }, effects };
      case 'handoff': if (n.text) replies.push(n.text); return handoff('flow', n.userId);
      case 'end': if (n.text) replies.push(n.text); return finished();
    }
  }
  return finished(); // fell off the graph (a node without next)
}

export { NODE_WAITS };

import type { Conversation } from '../api';

/** Who handles the inquiry right now, as one clear state (never "not assigned" next to "the bot handles it"). */
export type HandlerKind = 'me' | 'agent' | 'bot' | 'waiting' | 'closed';
export function handlerOf(c: Pick<Conversation, 'status' | 'assignedTo' | 'assignedName' | 'botState'>, meId: string, botName: string): { kind: HandlerKind; text: string } {
  const bot = c.botState === 'menu' || c.botState === 'area';
  if (c.status === 'closed') return { kind: 'closed', text: c.assignedName ? `טופלה ע״י ${c.assignedName}` : 'סגורה' };
  if (c.assignedTo && c.assignedTo === meId) return { kind: 'me', text: 'בטיפולך' };
  if (c.assignedTo) return { kind: 'agent', text: `מטפל/ת: ${c.assignedName ?? 'נציג/ה'}` };
  if (bot) return { kind: 'bot', text: `${botName} מטפל/ת` };
  return { kind: 'waiting', text: 'ממתינה לנציג/ה' };
}

const since = (iso: string) => {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' });
};

/** The handler as a labelled chip: in the list (compact) and in the conversation header (with "since"). */
export function HandlerChip({ c, meId, botName, withSince }: { c: Pick<Conversation, 'status' | 'assignedTo' | 'assignedName' | 'assignedAt' | 'botState'>; meId: string; botName: string; withSince?: boolean }) {
  const h = handlerOf(c, meId, botName);
  const t = withSince && c.assignedAt && (h.kind === 'me' || h.kind === 'agent') ? ` · מ-${since(c.assignedAt)}` : '';
  return (
    <span className={`mchip handler h-${h.kind}`} title={`מי מטפל בפנייה: ${h.text}${t}`}>
      <span className="sr-only">מי מטפל בפנייה: </span>
      <span aria-hidden="true" className="h-dot" />
      {h.text}{t}
    </span>
  );
}

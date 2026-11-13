import type { BotConfig } from '../bot.js';
import type { Flow, FlowNode } from './schema.js';

/** A starting flow that behaves like the current numbered menu (answers loop back to the menu; referrals and hand-overs are kept). */
export function flowFromMenu(bot: BotConfig): Flow {
  const nodes: FlowNode[] = [];
  const opts = bot.items.map((it, i) => ({ label: it.title, next: `a${i + 1}`, examples: [] as string[] }));
  nodes.push({ id: 'menu', type: 'menu', label: 'תפריט ראשי', text: bot.welcome, options: opts.length ? opts : [{ label: 'נציג אנושי', next: 'h', examples: [] }], kbOnFreeText: bot.kb.enabled });
  bot.items.forEach((it, i) => {
    const id = `a${i + 1}`;
    if (it.route) {
      const h = `h${i + 1}`;
      nodes.push(it.contact
        ? { id, type: 'referral', label: it.title, text: it.answer, contactName: it.contact.name, phone: it.contact.phone, message: it.contact.message, next: h }
        : { id, type: 'message', label: it.title, text: it.answer, next: h });
      nodes.push({ id: h, type: 'handoff', label: `${it.title}: נציג`, text: '', userId: it.route.userId });
    } else if (it.contact) {
      nodes.push({ id, type: 'referral', label: it.title, text: it.answer, contactName: it.contact.name, phone: it.contact.phone, message: it.contact.message, next: 'menu' });
    } else {
      nodes.push({ id, type: 'message', label: it.title, text: it.answer, next: 'menu' });
    }
  });
  if (!opts.length) nodes.push({ id: 'h', type: 'handoff', text: bot.humanMessage });
  return { start: 'menu', nodes, kbFirst: false };
}

import { z } from 'zod';

/**
 * Conversation flow ("flow chart") for the bot: a graph of nodes. Nodes that wait for the customer are `menu` and `question`;
 * all others run immediately and continue to `next`. Stored as JSON in settings.flow, validated here on every save.
 */
const id = z.string().regex(/^[a-z][a-z0-9_]{0,29}$/);
const next = id.optional();
const text = (max: number) => z.string().trim().min(1).max(max);
const base = { id, label: z.string().trim().max(60).optional() };

export const flowNode = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('message'), text: text(1500), next }),
  z.object({
    ...base, type: z.literal('menu'), text: text(1000),
    options: z.array(z.object({ label: text(60), next, /** other ways a customer might say it; used by meaning matching */ examples: z.array(text(80)).max(8).default([]) })).min(1).max(9),
    /** try the knowledge base when the customer types a question instead of choosing */
    kbOnFreeText: z.boolean().default(true),
  }),
  z.object({ ...base, type: z.literal('question'), text: text(500), save: z.enum(['name', 'phone', 'email', 'text']), retryText: z.string().trim().max(300).default('לא הצלחתי להבין, אפשר לנסות שוב?'), next }),
  z.object({
    ...base, type: z.literal('condition'),
    check: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('hours') }),
      z.object({ kind: z.literal('variable'), name: z.enum(['name', 'phone', 'email', 'text']), contains: z.string().trim().max(60) }),
      z.object({ kind: z.literal('channel'), is: z.enum(['whatsapp', 'whatsapp_cloud', 'telegram']) }),
    ]),
    yes: next, no: next,
  }),
  z.object({ ...base, type: z.literal('kb'), intro: z.string().trim().max(120).default(''), found: next, notFound: next }),
  z.object({ ...base, type: z.literal('referral'), text: text(1000), contactName: text(60), phone: z.string().trim().regex(/^\+?[\d\s-]{8,18}$/), message: z.string().trim().max(200).default(''), next }),
  z.object({ ...base, type: z.literal('tag'), tagId: z.string().uuid(), next }),
  z.object({ ...base, type: z.literal('handoff'), text: z.string().trim().max(500).default(''), userId: z.string().uuid().optional() }),
  z.object({ ...base, type: z.literal('end'), text: z.string().trim().max(500).default('') }),
]);
export type FlowNode = z.infer<typeof flowNode>;

export const flowSchema = z.object({ start: id, nodes: z.array(flowNode).min(1).max(60) });
export type Flow = z.infer<typeof flowSchema>;

export const NODE_WAITS = new Set(['menu', 'question']);

/** Targets a node points to, with a label for the diagram. */
export function edgesOf(n: FlowNode): { to: string; label: string }[] {
  const out: { to: string; label: string }[] = [];
  const add = (to: string | undefined, label: string) => { if (to) out.push({ to, label }); };
  switch (n.type) {
    case 'menu': n.options.forEach((o, i) => add(o.next, `${i + 1}. ${o.label}`)); break;
    case 'condition': add(n.yes, 'כן'); add(n.no, 'לא'); break;
    case 'kb': add(n.found, 'נמצאה תשובה'); add(n.notFound, 'לא נמצאה'); break;
    case 'handoff': case 'end': break;
    default: add(n.next, '');
  }
  return out;
}

/** Structural problems that make a flow unusable (returned as codes the editor can show). */
export function validateFlow(flow: Flow): string[] {
  const errors: string[] = [];
  const byId = new Map<string, FlowNode>();
  for (const n of flow.nodes) { if (byId.has(n.id)) errors.push(`duplicate_id:${n.id}`); byId.set(n.id, n); }
  if (!byId.has(flow.start)) errors.push('missing_start');
  for (const n of flow.nodes) for (const e of edgesOf(n)) if (!byId.has(e.to)) errors.push(`missing_target:${n.id}->${e.to}`);
  // a loop made only of nodes that never wait for the customer would spin forever
  const color = new Map<string, 1 | 2>();
  const visit = (nid: string, path: string[]): void => {
    const n = byId.get(nid);
    if (!n || NODE_WAITS.has(n.type)) return;
    if (color.get(nid) === 1) { errors.push(`loop:${[...path, nid].join('>')}`); return; }
    if (color.get(nid) === 2) return;
    color.set(nid, 1);
    for (const e of edgesOf(n)) visit(e.to, [...path, nid]);
    color.set(nid, 2);
  };
  for (const n of flow.nodes) visit(n.id, []);
  return [...new Set(errors)];
}

/** Nodes nobody can reach from the start (warning only). */
export function unreachable(flow: Flow): string[] {
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const stack = [flow.start];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur) || !byId.has(cur)) continue;
    seen.add(cur);
    for (const e of edgesOf(byId.get(cur)!)) stack.push(e.to);
  }
  return flow.nodes.filter((n) => !seen.has(n.id)).map((n) => n.id);
}

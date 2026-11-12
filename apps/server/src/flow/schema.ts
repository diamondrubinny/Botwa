import { z } from 'zod';

/**
 * Conversation flow ("flow chart") for the bot: a graph of nodes. Nodes that wait for the customer are `menu` and `question`;
 * all others run immediately and continue to `next`. Stored as JSON in settings.flow, validated here on every save.
 */
const id = z.string().regex(/^[a-z][a-z0-9_]{0,29}$/);
const next = id.optional();
const text = (max: number) => z.string().trim().min(1).max(max);
const base = { id, label: z.string().trim().max(60).optional() };
/** Name of a collected answer ("fullName", "building", "chemicals"...). The four original names stay valid. */
export const varName = z.string().regex(/^[a-z][a-zA-Z0-9_]{0,23}$/);
export const MAX_NODES = 150;

export const flowNode = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('message'), text: text(1500), next }),
  z.object({
    ...base, type: z.literal('menu'), text: text(1000),
    options: z.array(z.object({ label: text(60), next, /** other ways a customer might say it; used by meaning matching */ examples: z.array(text(80)).max(8).default([]) })).min(1).max(20),
    /** store the label of the chosen option in this variable */
    save: varName.optional(),
    /** try the knowledge base when the customer types a question instead of choosing */
    kbOnFreeText: z.boolean().default(true),
  }),
  z.object({
    ...base, type: z.literal('question'), text: text(500), save: varName,
    /** how the answer is checked; `name` also becomes the contact's name */
    kind: z.enum(['text', 'name', 'phone', 'email']).optional(),
    /** the customer may skip it by writing "דלג" */
    optional: z.boolean().default(false),
    /** a question typed here (instead of the answer) is answered from the knowledge base, then this question is asked again */
    kbAside: z.boolean().optional(),
    retryText: z.string().trim().max(300).default('לא הצלחתי להבין, אפשר לנסות שוב?'), next,
  }),
  /** wait for a photo or document, or a written description (a photo with a caption counts as both) */
  z.object({ ...base, type: z.literal('media'), text: text(500), save: varName.optional(), allowText: z.boolean().default(true), optional: z.boolean().default(false), retryText: z.string().trim().max(300).default('אפשר לשלוח כאן תמונה, קובץ או הסבר בכתב.'), next }),
  /** collect several items ("add another chemical"), up to `max` */
  z.object({ ...base, type: z.literal('list'), text: text(500), save: varName, max: z.number().int().min(2).max(20).default(10), moreText: z.string().trim().max(200).default('להוסיף עוד?'), optional: z.boolean().default(false), next }),
  /** keep these answers on the contact, so the next conversation does not ask them again */
  z.object({ ...base, type: z.literal('remember'), vars: z.array(varName).min(1).max(12), next }),
  z.object({
    ...base, type: z.literal('condition'),
    check: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('hours') }),
      z.object({ kind: z.literal('variable'), name: varName, contains: z.string().trim().max(60) }),
      z.object({ kind: z.literal('has'), name: varName }),
      z.object({ kind: z.literal('channel'), is: z.enum(['whatsapp', 'whatsapp_cloud', 'telegram', 'webchat', 'messenger', 'instagram', 'email']) }),
    ]),
    yes: next, no: next,
  }),
  z.object({ ...base, type: z.literal('kb'), intro: z.string().trim().max(120).default(''), found: next, notFound: next }),
  z.object({ ...base, type: z.literal('referral'), text: text(1000), contactName: text(60), phone: z.string().trim().regex(/^\+?[\d\s-]{8,18}$/), message: z.string().trim().max(200).default(''), next }),
  z.object({ ...base, type: z.literal('tag'), tagId: z.string().uuid(), next }),
  z.object({
    ...base, type: z.literal('handoff'), text: z.string().trim().max(500).default(''), userId: z.string().uuid().optional(),
    /** pick the person by responsibility area from these answers (first one that matches an area); userId is the fallback */
    areaVars: z.array(varName).max(4).optional(),
    /** hand over to the officer of this topic (see the officers list); used when no area matched. userId stays as the last fallback */
    officerTopic: z.string().trim().min(1).max(60).optional(),
    /** tell the customer the officer's name and how to reach them */
    showContact: z.boolean().optional(),
  }),
  z.object({ ...base, type: z.literal('end'), text: z.string().trim().max(500).default('') }),
]);
export type FlowNode = z.infer<typeof flowNode>;

export const flowSchema = z.object({
  start: id, nodes: z.array(flowNode).min(1).max(MAX_NODES),
  /** where each node sits in the editor (drawing only; the bot ignores it) */
  layout: z.record(id, z.object({ x: z.number().min(-1000).max(20000), y: z.number().min(-1000).max(20000) })).optional(),
  /** answer a question typed as the very first message from the knowledge base, before the flow starts */
  kbFirst: z.boolean().default(false),
  /** names for the variables in the summary note given to the person who takes over */
  labels: z.record(varName, z.string().trim().min(1).max(40)).optional(),
});
export type Flow = z.infer<typeof flowSchema>;

export const NODE_WAITS = new Set(['menu', 'question', 'media', 'list']);

/** Unfinished placeholders such as "[להשלים: קישור]" in texts that customers would receive. */
export function unfinished(flow: Flow): string[] {
  return flow.nodes.filter((n) => JSON.stringify(n).includes('[להשלים')).map((n) => n.id);
}

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

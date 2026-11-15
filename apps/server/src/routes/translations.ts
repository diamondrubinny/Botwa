import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireAuth } from '../auth.js';
import { loadAutomations } from '../automations.js';
import { loadBot } from '../bot.js';
import type { Db } from '../db.js';
import { loadFlow } from '../flow/store.js';
import { defaultEntries, invalidateTranslations, loadOverrides } from '../i18n/translate.js';
import { loadBusinessHours } from './settings.js';

/**
 * Bot > English translation: every Hebrew text Betty may send (from the flow, the bot settings, the automatic messages and the
 * working hours, plus her own built-in messages), with its English wording: the built-in one, the unit's own, or none yet.
 */
const he = (s: unknown): s is string => typeof s === 'string' && /[א-ת]/.test(s) && s.trim().length > 0;

async function sources(db: Db): Promise<Map<string, string>> {
  const out = new Map<string, string>();   // text → where it is used
  const add = (s: unknown, where: string) => {
    if (!he(s)) return;
    // a long message is translated paragraph by paragraph (and line by line), so each paragraph is its own entry
    for (const part of s.split('\n\n')) if (he(part) && !out.has(part.trim())) out.set(part.trim(), where);
  };
  const flow = await loadFlow(db).catch(() => null);
  for (const n of (flow?.nodes ?? []) as unknown as Record<string, unknown>[]) {
    const where = `תרשים זרימה: ${typeof n.label === 'string' && n.label ? n.label : n.id}`;
    add(n.text, where); add(n.retryText, where); add(n.moreText, where);
    for (const o of (Array.isArray(n.options) ? n.options : []) as { label?: string }[]) add(o.label, where);
  }
  const bot = await loadBot(db);
  for (const [k, v] of [['welcome', bot.welcome], ['humanMessage', bot.humanMessage], ['invalidMessage', bot.invalidMessage], ['footer', bot.footer], ['humanLabel', bot.humanLabel], ['kb.intro', bot.kb.intro], ['kb.outro', bot.kb.outro], ['emergency', bot.emergency.text]] as const) add(v, `בוט: ${k}`);
  for (const i of bot.items) { add(i.title, 'בוט: תפריט'); add(i.answer, 'בוט: תפריט'); }
  const a = await loadAutomations(db);
  add(a.idle.reminderText, 'אוטומציות: תזכורת'); add(a.idle.closeText, 'אוטומציות: סגירה'); add(a.holding.text, 'אוטומציות: הודעת המתנה');
  add(a.closing.text, 'אוטומציות: הודעת סיום'); add(a.feedback.question, 'אוטומציות: משוב'); add(a.feedback.thanks, 'אוטומציות: משוב');
  add(a.customerClose.text, 'אוטומציות: סגירה על ידי הלקוח'); add(a.introduce.text, 'אוטומציות: הצגת נציג');
  add((await loadBusinessHours(db)).awayMessage, 'שעות פעילות');
  return out;
}

export function translationRoutes(app: FastifyInstance, db: Db) {
  app.get('/settings/translations', { preHandler: requireAuth(db, 'bot.view') }, async () => {
    const defs = defaultEntries();
    const custom = await loadOverrides(db);
    const used = await sources(db);
    const keys = new Set<string>([...used.keys(), ...Object.keys(custom), ...defs.keys()]);
    const items = [...keys].map((text) => ({
      he: text,
      en: Object.hasOwn(custom, text) ? custom[text]! : defs.get(text) ?? '',
      builtIn: defs.get(text) ?? null,
      custom: Object.hasOwn(custom, text),
      where: used.get(text) ?? (defs.has(text) ? 'הודעות מובנות של הבוט' : 'תרגום שנוסף'),
      used: used.has(text),
    }));
    // what is in use and has no English first, then what is in use, then the rest
    items.sort((x, y) => Number(!!y.used && !y.en) - Number(!!x.used && !x.en) || Number(y.used) - Number(x.used) || x.where.localeCompare(y.where, 'he'));
    return { items, missing: items.filter((i) => i.used && !i.en).length };
  });

  app.put('/settings/translations', { preHandler: requireAuth(db, 'bot.manage'), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ entries: z.record(z.string().trim().min(1).max(2000), z.string().trim().max(2000)) }).safeParse(req.body);
    if (!b.success || Object.keys(b.data.entries).length > 3000) return reply.code(400).send({ error: 'bad_request' });
    const defs = defaultEntries();
    // only what differs from the built-in wording is stored (an empty value switches a built-in translation off)
    const entries: Record<string, string> = {};
    for (const [k, v] of Object.entries(b.data.entries)) {
      if (defs.has(k) ? defs.get(k) !== v : v !== '') entries[k] = v;
    }
    await db.query(`INSERT INTO settings (key, value) VALUES ('translations_en', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [{ entries }]);
    invalidateTranslations();
    await audit(db, { actorId: req.user!.id, action: 'settings.translations', ip: req.ip, meta: { custom: Object.keys(entries).length } });
    return { ok: true, custom: Object.keys(entries).length };
  });
}

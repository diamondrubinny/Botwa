import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireAuth } from '../auth.js';
import { loadBot } from '../bot.js';
import type { Db } from '../db.js';
import { newPlaceCode, PLACE_CODE, placeText } from '../safety/places.js';

/** Where a sticker leads: the website chat (one of the unit's chat sites) and/or WhatsApp (the unit's business number). */
export interface PlaceTargets { whatsappNumber: string; webchatKey: string }
export async function loadPlaceTargets(db: Db): Promise<PlaceTargets> {
  const v = (await db.query(`SELECT value FROM settings WHERE key = 'qr_targets'`)).rows[0]?.value as Partial<PlaceTargets> | undefined;
  return { whatsappNumber: v?.whatsappNumber ?? '', webchatKey: v?.webchatKey ?? '' };
}

/** The emergency numbers and advice, without sentences about a message already passed on (this page sent nothing yet). */
export function emergencyLine(text: string): string {
  return text.split(/\n+|(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x && !/העברתי|הועברה|הפנייה|נציג|נחזור/.test(x)).join(' ').trim();
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The page a scanned sticker opens: where you are, and how to reach Betty. No scripts, nothing about the visitor is kept. */
function landing(o: { title: string; place?: string; chat?: string; whatsapp?: string; emergency?: string; inactive?: boolean }): string {
  const btn = (href: string, text: string, cls: string) => `<a class="btn ${cls}" href="${esc(href)}" rel="noopener">${esc(text)}</a>`;
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(o.title)}</title><style>
:root{color-scheme:light dark;--bg:#f7f5fc;--fg:#1b1530;--card:#fff;--accent:#5b34d6;--wa:#0b7a3e;--muted:#5b5470;--warn:#93370d}
@media (prefers-color-scheme:dark){:root{--bg:#15121f;--fg:#f2effa;--card:#211c30;--accent:#a991ff;--wa:#4ade80;--muted:#bab2d4;--warn:#fdba74}}
*{box-sizing:border-box}body{margin:0;font:17px/1.6 system-ui,-apple-system,"Segoe UI",Arial,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:30rem;margin:0 auto;padding:1.5rem 1rem}.card{background:var(--card);border-radius:16px;padding:1.25rem;box-shadow:0 2px 12px rgba(0,0,0,.08)}
h1{font-size:1.35rem;margin:0 0 .5rem}.place{font-size:1.1rem;font-weight:600;margin:.25rem 0 1rem}.muted{color:var(--muted);font-size:.92rem}
.btn{display:block;text-align:center;text-decoration:none;font-weight:700;padding:.9rem 1rem;border-radius:12px;margin:.6rem 0;min-height:48px;border:2px solid transparent}
.chat{background:var(--accent);color:#fff}.wa{background:var(--wa);color:#fff}@media (prefers-color-scheme:dark){.chat,.wa{color:#111}}
.btn:focus-visible{outline:3px solid var(--fg);outline-offset:3px}.em{margin-top:1rem;color:var(--warn);font-weight:600;white-space:pre-line;font-size:.95rem}
</style></head><body><main><div class="card">
<h1>${esc(o.title)}</h1>
${o.inactive ? '<p>המדבקה הזו אינה פעילה. אפשר לפנות ליחידת הבטיחות בדרכים הרגילות.</p>' : `<p class="muted">המיקום שלכם:</p><p class="place">📍 ${esc(o.place ?? '')}</p>
<p>לדיווח על מפגע או לשאלת בטיחות, בחרו איך לכתוב לנו:</p>
${o.chat ? btn(o.chat, '💬 צ׳אט עם בטי באתר', 'chat') : ''}${o.whatsapp ? btn(o.whatsapp, 'WhatsApp', 'wa') : ''}
${!o.chat && !o.whatsapp ? '<p>עדיין לא הוגדרה דרך פנייה למדבקה הזו.</p>' : ''}
<p class="muted">המיקום יצורף לפנייה אוטומטית. בטי היא בוט, ונציג אנושי ממשיך כשצריך.</p>`}
${o.emergency ? `<p class="em" role="note">${esc(o.emergency)}</p>` : ''}
</div></main></body></html>`;
}

/**
 * QR stickers: the unit's places (bot.view to see, bot.manage to change), where stickers lead, and the public page a scan opens.
 */
export function placeRoutes(app: FastifyInstance, db: Db) {
  const view = requireAuth(db, 'bot.view');
  const manage = requireAuth(db, 'bot.manage');
  const body = z.object({ building: z.string().trim().max(80).default(''), room: z.string().trim().max(40).default(''), label: z.string().trim().max(120).default('') })
    .strict().refine((b) => b.building || b.room || b.label, 'empty');

  app.get('/places', { preHandler: view }, async () => {
    const places = (await db.query(`SELECT id, code, building, room, label, active, scans, last_scan_at AS "lastScanAt", created_at AS "createdAt" FROM qr_places ORDER BY building, room, label`)).rows;
    const sites = (await db.query(`SELECT w.public_key AS key, c.label FROM webchat_configs w JOIN channels c ON c.id = w.channel_id WHERE c.type = 'webchat' ORDER BY c.label`)).rows;
    return { places, targets: await loadPlaceTargets(db), sites };
  });

  app.post('/places', { preHandler: manage, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = body.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    if (((await db.query(`SELECT count(*)::int AS n FROM qr_places`)).rows[0].n as number) >= 2000) return reply.code(409).send({ error: 'too_many' });
    for (let i = 0; i < 5; i++) {
      const r = await db.query(`INSERT INTO qr_places (code, building, room, label, created_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (code) DO NOTHING RETURNING id, code, building, room, label, active, scans`,
        [newPlaceCode(), b.data.building, b.data.room, b.data.label, req.user!.id]);
      if (r.rows[0]) {
        await audit(db, { actorId: req.user!.id, action: 'places.create', target: r.rows[0].id, ip: req.ip });
        return reply.code(201).send(r.rows[0]);
      }
    }
    return reply.code(500).send({ error: 'code_collision' });
  });

  app.patch('/places/:id', { preHandler: manage }, async (req, reply) => {
    const p = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const b = z.object({ building: z.string().trim().max(80).optional(), room: z.string().trim().max(40).optional(), label: z.string().trim().max(120).optional(), active: z.boolean().optional() }).strict().safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: 'bad_request' });
    const r = await db.query(
      `UPDATE qr_places SET building = COALESCE($2, building), room = COALESCE($3, room), label = COALESCE($4, label), active = COALESCE($5, active) WHERE id = $1
       RETURNING id, code, building, room, label, active, scans`, [p.data.id, b.data.building ?? null, b.data.room ?? null, b.data.label ?? null, b.data.active ?? null]);
    if (!r.rows[0]) return reply.code(404).send({ error: 'not_found' });
    await audit(db, { actorId: req.user!.id, action: 'places.update', target: p.data.id, ip: req.ip, meta: b.data.active === undefined ? undefined : { active: b.data.active } });
    return r.rows[0];
  });

  app.delete('/places/:id', { preHandler: manage }, async (req, reply) => {
    const p = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const r = await db.query(`DELETE FROM qr_places WHERE id = $1`, [p.data.id]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(db, { actorId: req.user!.id, action: 'places.delete', target: p.data.id, ip: req.ip });
    return { ok: true };
  });

  app.put('/places/targets', { preHandler: manage }, async (req, reply) => {
    const b = z.object({
      whatsappNumber: z.string().trim().transform((v) => v.replace(/[\s+()-]/g, '')).refine((v) => v === '' || /^\d{8,15}$/.test(v), 'phone'),
      webchatKey: z.string().trim().refine((v) => v === '' || /^wc_[\w-]{10,60}$/.test(v), 'key'),
    }).strict().safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'bad_request' });
    if (b.data.webchatKey && !(await db.query(`SELECT 1 FROM webchat_configs WHERE public_key = $1`, [b.data.webchatKey])).rowCount) return reply.code(400).send({ error: 'unknown_site' });
    await db.query(`INSERT INTO settings (key, value) VALUES ('qr_targets', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(b.data)]);
    await audit(db, { actorId: req.user!.id, action: 'places.targets', ip: req.ip });
    return b.data;
  });

  // ---- public: the page a scanned sticker opens ----
  app.get('/q/:code', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const code = String((req.params as { code: string }).code ?? '').toUpperCase();
    reply.header('content-type', 'text/html; charset=utf-8').header('cache-control', 'no-store').header('referrer-policy', 'no-referrer')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
      .header('x-content-type-options', 'nosniff').header('x-frame-options', 'DENY');
    const bot = await loadBot(db).catch(() => null);
    // the bot's emergency text without what only fits after a message ("העברתי את הפנייה…"): nothing was sent from this page yet
    const emergency = bot?.emergency?.enabled ? emergencyLine(bot.emergency.text) : '';
    const p = PLACE_CODE.test(code)
      ? (await db.query(`UPDATE qr_places SET scans = scans + 1, last_scan_at = now() WHERE code = $1 AND active RETURNING code, building, room, label`, [code])).rows[0] as { code: string; building: string; room: string; label: string } | undefined
      : undefined;
    if (!p) return reply.code(404).send(landing({ title: 'יחידת הבטיחות', inactive: true, emergency }));
    const t = await loadPlaceTargets(db);
    return reply.send(landing({
      title: 'דיווח ושאלות בטיחות', place: placeText(p), emergency,
      chat: t.webchatKey ? `/w/${encodeURIComponent(t.webchatKey)}?place=${p.code}` : undefined,
      whatsapp: t.whatsappNumber ? `https://wa.me/${t.whatsappNumber}?text=${encodeURIComponent(`שלום 👋 (📍${p.code})`)}` : undefined,
    }));
  });
}

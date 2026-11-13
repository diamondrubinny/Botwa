import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { PHRASES, type Situation } from '../phrases';
import { errText } from '../strings';

interface Automations {
  idle: { enabled: boolean; reminderAfter: number; reminderText: string; closeAfter: number; closeText: string };
  holding: { enabled: boolean; after: number; text: string };
  closing: { defaultOn: boolean; text: string };
}

/** A text box with "choose a ready phrasing" for its situation. */
function PhraseField({ id, label, value, onChange, situation, disabled, required }: { id: string; label: string; value: string; onChange: (v: string) => void; situation: Situation; disabled: boolean; required?: boolean }) {
  const lib = PHRASES[situation];
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select aria-label={`ניסוח מוכן: ${lib.title}`} value="" disabled={disabled} onChange={(e) => { const p = lib.items[Number(e.target.value)]; if (p) onChange(p.text); }} style={{ marginBottom: '.35rem' }}>
        <option value="">בחירת ניסוח מוכן…</option>
        {lib.items.map((p, i) => <option key={i} value={i}>{p.style}: {p.text.length > 70 ? `${p.text.slice(0, 70)}…` : p.text}</option>)}
      </select>
      <textarea id={id} rows={3} maxLength={1000} value={value} disabled={disabled} required={required} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

const minsLabel = (m: number) => (m % 1440 === 0 ? `${m / 1440} ימים` : m % 60 === 0 ? `${m / 60} שעות` : `${m} דקות`);

/** Conversation automations: remind and close when the customer is silent, a holding message, the closing message. */
export function AutomationsCard({ canEdit }: { canEdit: boolean }) {
  const [a, setA] = useState<Automations | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { void api<Automations>('GET', '/settings/automations').then(setA).catch(() => undefined); }, []);
  if (!a) return null;
  const set = <K extends keyof Automations>(k: K, patch: Partial<Automations[K]>) => setA({ ...a, [k]: { ...a[k], ...patch } });
  const num = (v: string) => Math.max(0, Math.min(10080, Math.round(Number(v) || 0)));
  async function save(e: FormEvent) {
    e.preventDefault(); setMsg(null);
    try { setA(await api<Automations>('PUT', '/settings/automations', a)); setMsg({ ok: true, text: 'האוטומציות נשמרו.' }); }
    catch (er) { setMsg({ ok: false, text: errText(er instanceof ApiError ? er.code : 'generic') }); }
  }
  const off = !canEdit;
  return (
    <form className="card" onSubmit={save} aria-labelledby="auto-h">
      <h2 id="auto-h">אוטומציות לשיחות</h2>
      <p className="hint">הודעות אוטומטיות מסומנות בשיחה ולא נספרות בדוחות כמענה של נציג. הן לא נשלחות ללקוח חסום, ללקוח שביקש להפסיק לקבל הודעות, לתגובות ציבוריות על פוסטים, או מחוץ לחלון 24 השעות של Meta. משתנים: {'{שם}'} {'{נציג}'} {'{שעות}'} {'{ערוץ}'}.</p>

      <fieldset>
        <legend>הלקוח לא עונה: תזכורת וסגירה</legend>
        <label><input type="checkbox" role="switch" checked={a.idle.enabled} disabled={off} onChange={(e) => set('idle', { enabled: e.target.checked })} /> הפעלה</label>
        <p className="hint">מתחיל כשהצד שלנו (נציג או בוט) כתב אחרון והלקוח לא הגיב. אם הלקוח כותב שוב, השיחה נפתחת מחדש.</p>
        <div className="row">
          <div className="field"><label htmlFor="au-ra">תזכורת אחרי (דקות, 0 = בלי תזכורת)</label><input id="au-ra" type="number" min={0} max={10080} value={a.idle.reminderAfter} disabled={off} onChange={(e) => set('idle', { reminderAfter: num(e.target.value) })} /></div>
          <div className="field"><label htmlFor="au-ca">סגירה אחרי עוד (דקות)</label><input id="au-ca" type="number" min={1} max={10080} value={a.idle.closeAfter} disabled={off} onChange={(e) => set('idle', { closeAfter: Math.max(1, num(e.target.value)) })} /></div>
        </div>
        <p className="hint" role="note">{a.idle.reminderAfter > 0 ? `תזכורת אחרי ${minsLabel(a.idle.reminderAfter)} בלי מענה, וסגירה ${minsLabel(a.idle.closeAfter)} אחריה.` : `סגירה אחרי ${minsLabel(a.idle.closeAfter)} בלי מענה, בלי תזכורת.`}</p>
        {a.idle.reminderAfter > 0 && <PhraseField id="au-rt" label="נוסח התזכורת" situation="idleReminder" value={a.idle.reminderText} disabled={off} required={a.idle.enabled} onChange={(v) => set('idle', { reminderText: v })} />}
        <PhraseField id="au-ct" label="הודעת הסגירה (ריק = סגירה בלי הודעה)" situation="idleClose" value={a.idle.closeText} disabled={off} onChange={(v) => set('idle', { closeText: v })} />
      </fieldset>

      <fieldset>
        <legend>הלקוח מחכה לנציג: הודעת המתנה</legend>
        <label><input type="checkbox" role="switch" checked={a.holding.enabled} disabled={off} onChange={(e) => set('holding', { enabled: e.target.checked })} /> הפעלה</label>
        <p className="hint">נשלחת פעם אחת לכל המתנה, כשהלקוח כתב ואף נציג עוד לא ענה. לא בזמן שהבוט מטפל, ולא מחוץ לשעות הפעילות (שם נשלחת הודעת "מחוץ לשעות").</p>
        <div className="field"><label htmlFor="au-ha">אחרי (דקות)</label><input id="au-ha" type="number" min={1} max={10080} value={a.holding.after} disabled={off} onChange={(e) => set('holding', { after: Math.max(1, num(e.target.value)) })} /></div>
        <PhraseField id="au-ht" label="נוסח הודעת ההמתנה" situation="holding" value={a.holding.text} disabled={off} required onChange={(v) => set('holding', { text: v })} />
      </fieldset>

      <fieldset>
        <legend>נציג סוגר שיחה: הודעת סיום</legend>
        <label><input type="checkbox" role="switch" checked={a.closing.defaultOn} disabled={off} onChange={(e) => set('closing', { defaultOn: e.target.checked })} /> לסמן כברירת מחדל "לשלוח הודעת סיום" בסגירת שיחה</label>
        <p className="hint">הנציג רואה את ההודעה ויכול לבטל את השליחה בכל סגירה.</p>
        <PhraseField id="au-cl" label="נוסח הודעת הסיום (ריק = בלי אפשרות לשלוח)" situation="closing" value={a.closing.text} disabled={off} onChange={(v) => set('closing', { text: v })} />
      </fieldset>

      {canEdit && <button className="primary" type="submit">שמירת האוטומציות</button>}
      <p role="status" className={msg ? (msg.ok ? 'ok' : 'error') : undefined}>{msg?.text}</p>
    </form>
  );
}

import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { PHRASES, type Situation } from '../phrases';
import { errText } from '../strings';

interface Automations {
  idle: { enabled: boolean; reminderAfter: number; reminderText: string; closeAfter: number; closeText: string };
  holding: { enabled: boolean; after: number; text: string };
  closing: { defaultOn: boolean; text: string };
  feedback: { enabled: boolean; question: string; thanks: string; afterAuto: boolean };
  customerClose: { enabled: boolean; text: string };
  introduce: { enabled: boolean; text: string };
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

const FEEDBACK_Q = [
  'נשמח לשמוע איך היה השירות: השיבו במספר מ-1 עד 5 (5 = מצוין).',
  'עזרנו לך היום? דרגו את השירות מ-1 (לא טוב) עד 5 (מצוין). התשובה עוזרת לנו להשתפר.',
  'תודה שפנית אלינו, {שם}! כמה היית ממליץ/ה על השירות שלנו, מ-1 עד 5?',
  'לסיום, נשמח לדירוג קצר: 1 עד 5 ⭐',
];

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

      <fieldset>
        <legend>משוב מהלקוח אחרי סגירה</legend>
        <label><input type="checkbox" role="switch" checked={a.feedback.enabled} disabled={off} onChange={(e) => set('feedback', { enabled: e.target.checked })} /> לבקש מהלקוח לדרג את השירות (1 עד 5) אחרי שהשיחה נסגרת</label>
        <p className="hint">תשובה של ספרה (או כוכבים) נשמרת על הפנייה, מוצגת בהיסטוריה ובדוחות, ולא פותחת את השיחה מחדש. כל תשובה אחרת נחשבת לפנייה חדשה. שואלים פעם אחת לכל פנייה.</p>
        <label><input type="checkbox" checked={a.feedback.afterAuto} disabled={off || !a.feedback.enabled} onChange={(e) => set('feedback', { afterAuto: e.target.checked })} /> לשאול גם כשהשיחה נסגרה אוטומטית (הלקוח לא הגיב)</label>
        <div className="field"><label htmlFor="au-fq">שאלת המשוב</label>
          <select aria-label="ניסוח מוכן: שאלת משוב" value="" disabled={off} onChange={(e) => { const v = FEEDBACK_Q[Number(e.target.value)]; if (v) set('feedback', { question: v }); }} style={{ marginBottom: '.35rem' }}>
            <option value="">בחירת ניסוח מוכן…</option>
            {FEEDBACK_Q.map((q, i) => <option key={i} value={i}>{q}</option>)}
          </select>
          <textarea id="au-fq" rows={2} maxLength={1000} value={a.feedback.question} disabled={off} required onChange={(e) => set('feedback', { question: e.target.value })} /></div>
        <div className="field"><label htmlFor="au-ft">תודה על המשוב</label><input id="au-ft" maxLength={300} value={a.feedback.thanks} disabled={off} onChange={(e) => set('feedback', { thanks: e.target.value })} /></div>
      </fieldset>

      <fieldset>
        <legend>הצגת המטפל/ת ללקוח</legend>
        <label><input type="checkbox" role="switch" checked={a.introduce?.enabled ?? true} disabled={off} onChange={(e) => set('introduce', { enabled: e.target.checked })} /> כשפנייה עוברת לנציג/ה או לממונה, להציג אותם ללקוח</label>
        <p className="hint">נשלח פעם אחת לכל מטפל/ת בכל פנייה: בשיוך אוטומטי, כשהבוט מעביר, כשמישהו לוקח את הפנייה או מעביר אותה לעמית. משתנים: {'{נציג}'} שם, {'{תפקיד}'} התפקיד (כל אחד ממלא ב"החשבון שלי"), {'{טלפון נציג}'} טלפון עבודה אם מולא, {'{שם}'} שם הלקוח. משתנה בלי ערך נשמט יחד עם הפסיק שלו.</p>
        <PhraseField id="au-in" label="הודעת ההצגה" value={a.introduce?.text ?? ''} onChange={(v) => set('introduce', { text: v })} situation="introduce" disabled={off || !(a.introduce?.enabled ?? true)} required />
      </fieldset>

      <fieldset>
        <legend>סגירה לבקשת הלקוח</legend>
        <label><input type="checkbox" role="switch" checked={a.customerClose?.enabled ?? true} disabled={off} onChange={(e) => set('customerClose', { enabled: e.target.checked })} /> לסגור את הפנייה כשהלקוח כותב שהעניין הסתדר או מבקש לסגור</label>
        <p className="hint">למשל "הסתדרתי", "הסתדר, תודה", "הבעיה נפתרה", "תסגרו את הקריאה", "אפשר לסגור". הודעה עם שאלה, "עדיין", "אבל" או "אל תסגרו" לא סוגרת. הלקוח מקבל אישור, ואם המשוב פעיל הוא גם יתבקש לדרג. הודעה חדשה ממנו פותחת את הפנייה מחדש. בהיסטוריה הפנייה תסומן "נסגרה לבקשת הלקוח".</p>
        <PhraseField id="au-cc" label="הודעת אישור ללקוח (ריק = לסגור בלי הודעה)" value={a.customerClose?.text ?? ''} onChange={(v) => set('customerClose', { text: v })} situation="customerClose" disabled={off || !(a.customerClose?.enabled ?? true)} />
      </fieldset>

      {canEdit && <button className="primary" type="submit">שמירת האוטומציות</button>}
      <p role="status" className={msg ? (msg.ok ? 'ok' : 'error') : undefined}>{msg?.text}</p>
    </form>
  );
}

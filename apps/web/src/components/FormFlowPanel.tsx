import { Fragment, useEffect, useState } from 'react';
import { api, ApiError, type FormTemplate } from '../api';
import { errText } from '../strings';

interface FlowInfo {
  enabled: boolean; version: string; problems: string[]; signature: boolean;
  fields: { id: string; label: string; short: string; custom: string }[];
  channels: { id: string; label: string; connected: boolean; upToDate: boolean; ready: boolean; flow: { flowId: string; status: string; errors: string[]; previewUrl: string | null; at: string } | null }[];
}
const STATUS: Record<string, string> = { PUBLISHED: 'פורסם', DRAFT: 'טיוטה (יש שגיאות)', DEPRECATED: 'הוצא משימוש', BLOCKED: 'חסום ע"י Meta', THROTTLED: 'מוגבל ע"י Meta' };
const LABEL_MAX = 20;
const HEALTH: Record<string, string> = { account_review_status: 'סקירת החשבון העסקי', business_verification_status: 'אימות העסק', quality_rating: 'איכות המספר', name_status: 'אישור שם התצוגה', code_verification_status: 'אימות המספר', messaging_limit_tier: 'מגבלת הודעות' };

/**
 * Filling a template inside WhatsApp (WhatsApp Flows, official channel): the switch, short labels (Meta allows 20 characters),
 * and the Flow on each official channel, published from here. The link with a drawn signature always stays available.
 */
export function FormFlowPanel({ tpl, onClose }: { tpl: FormTemplate; onClose: () => void }) {
  const [info, setInfo] = useState<FlowInfo | null>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [health, setHealth] = useState<Record<string, string> | null>(null);
  const base = `/forms/templates/${tpl.id}/flow`;
  async function load() {
    try {
      const i = await api<FlowInfo>('GET', base);
      setInfo(i); setEnabled(i.enabled); setLabels(Object.fromEntries(i.fields.map((f) => [f.id, f.custom])));
    } catch (e) { setMsg({ ok: false, text: errText(e instanceof ApiError ? e.code : 'generic') }); }
  }
  useEffect(() => { void load(); }, [tpl.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  const fail = (e: unknown) => setMsg({ ok: false, text: `${errText(e instanceof ApiError ? e.code : 'generic')}${e instanceof ApiError && e.detail ? ` (${e.detail})` : ''}` });
  async function save() {
    setBusy(true); setMsg(null);
    try { await api('PUT', base, { enabled, labels: Object.fromEntries(Object.entries(labels).filter(([, v]) => v.trim())) }); setMsg({ ok: true, text: 'נשמר. אם שיניתם תוויות, צריך לפרסם מחדש.' }); await load(); } catch (e) { fail(e); }
    setBusy(false);
  }
  async function probe(channelId: string) {
    setBusy(true); setMsg({ ok: true, text: 'מאבחן מול Meta… זה לוקח עד דקה (כמה טפסי בדיקה נוצרים ומוסרים).' });
    try {
      const r = await api<{ verdict: string; field?: { label: string; type: string }; problem?: string; detail?: string; health?: Record<string, string> }>('POST', '/forms/flow/probe', { channelId, templateId: tpl.id });
      const text: Record<string, string> = {
        account: 'גם טופס בדיקה בלי שום שדה נחסם, כלומר החסימה היא על החשבון ולא על הטופס. צריך לפנות לתמיכה של Meta (https://business.facebook.com/direct-support/, נושא WhatsApp Business API ← Flows), עם הודעת השגיאה ועם צילום המסך הזה.',
        field: `Meta חוסמת את השדה "${r.field?.label ?? ''}". כל שאר הטופס עובר. אפשר לשנות את הנוסח או את הסוג שלו בעורך, להסיר אותו, או לשלוח את הטופס כקישור.`,
        signature: 'השדות עוברים. Meta חוסמת את שלב החתימה (ההצהרה על חתימה אלקטרונית והשם המוקלד). כבו את "מילוי בתוך ווצאפ" בטופס הזה ושלחו קישור, או הסירו מהטופס את שדות החתימה.',
        content: 'כל חלק עובר בנפרד, אבל הטופס השלם נחסם. כנראה Meta מתנגדת לשילוב (למשל לכותרת הטופס). נסו לשנות את כותרת הטופס, או שלחו כקישור.',
        none: 'כל הבדיקות עברו, כולל הטופס המלא. לחצו שוב "פרסום מחדש". אם החסימה חוזרת, ייתכן שזו בעיה זמנית אצל Meta.',
        other: `${errText(r.problem ?? 'generic')}${r.detail ? ` (${r.detail})` : ''}`,
      };
      setMsg({ ok: r.verdict === 'none', text: text[r.verdict] ?? text.other! });
      setHealth(r.health ?? null);
    } catch (e) { fail(e); }
    setBusy(false);
  }
  async function publish(channelId: string) {
    setBusy(true); setMsg(null);
    try {
      const f = await api<{ status: string; errors: string[]; problem?: string; detail?: string; health?: Record<string, string> }>('POST', `${base}/publish`, { channelId });
      if (f.status === 'PUBLISHED') { setMsg({ ok: true, text: 'הטופס פורסם בווצאפ. אפשר לשלוח אותו מהשיחות בערוץ הזה.' }); setHealth(null); }
      else { setMsg({ ok: false, text: errText(f.problem ?? 'flow_validation') }); setHealth(f.health ?? null); }
      await load();
    } catch (e) { fail(e); }
    setBusy(false);
  }
  return (
    <section className="card" aria-labelledby="ff-h">
      <h2 id="ff-h">מילוי בתוך ווצאפ: {tpl.title}</h2>
      <p className="hint">בערוץ ווצאפ הרשמי אפשר לשלוח את הטופס כך שהלקוח ימלא אותו במסכים של ווצאפ עצמו, בלי קישור ובלי קוד אימות. התשובות חוזרות לשיחה, ונוצר אותו PDF נעול עם עמוד ביקורת.
        {info?.signature ? ' בווצאפ אין חתימה מצוירת: החותם מאשר הצהרה ומקליד את שמו המלא, וזה מה שמופיע במקום החתימה. בטפסים שדורשים חתימה ביד, כבו את האפשרות ושלחו קישור.' : ''}</p>
      {!info ? <p role="status">טוען…</p> : (
        <>
          <label className="row" style={{ fontWeight: 400 }}><input type="checkbox" role="switch" style={{ width: 'auto', minHeight: 'auto' }} checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> מותר למלא את הטופס בתוך ווצאפ</label>
          {info.problems.map((p) => <p key={p} className="error">{errText(p)}</p>)}
          {info.fields.length > 0 && (
            <table>
              <caption>תוויות בווצאפ (עד {LABEL_MAX} תווים; התווית המלאה מוצגת כהסבר מתחת לשדה)</caption>
              <thead><tr><th scope="col">השדה</th><th scope="col">בווצאפ</th></tr></thead>
              <tbody>{info.fields.map((f) => (
                <tr key={f.id}>
                  <th scope="row">{f.label}</th>
                  <td><label className="sr-only" htmlFor={`ffl-${f.id}`}>תווית קצרה ל{f.label}</label>
                    <input id={`ffl-${f.id}`} maxLength={LABEL_MAX} placeholder={f.short} value={labels[f.id] ?? ''} onChange={(e) => setLabels({ ...labels, [f.id]: e.target.value })} /></td>
                </tr>))}</tbody>
            </table>
          )}
          <div className="row"><button type="button" className="primary" disabled={busy} onClick={() => void save()}>שמירה</button><button type="button" onClick={onClose}>סגירה</button></div>

          <h3>בערוצים הרשמיים</h3>
          {!info.channels.length ? <p className="hint">אין ערוץ ווצאפ רשמי. מילוי בתוך ווצאפ זמין רק בערוץ הרשמי (Cloud API).</p> : (
            <ul className="plain">
              {info.channels.map((c) => (
                <li key={c.id} className="card" style={{ margin: '.4rem 0' }}>
                  <strong>{c.label}</strong>{' · '}
                  {!c.flow ? 'לא פורסם' : `${STATUS[c.flow.status] ?? c.flow.status}${c.upToDate ? '' : ' · הטופס השתנה מאז, צריך לפרסם מחדש'}`}
                  {c.flow?.errors.length ? <ul className="error">{c.flow.errors.map((e, i) => <li key={i} dir="ltr">{e}</li>)}</ul> : null}
                  <div className="row">
                    <button type="button" disabled={busy || !c.connected || !enabled || info.problems.length > 0 || c.ready} onClick={() => void publish(c.id)}>{c.flow ? 'פרסום מחדש' : 'פרסום בווצאפ'}<span className="sr-only"> ב{c.label}</span></button>
                    {c.flow?.previewUrl && <a href={c.flow.previewUrl} target="_blank" rel="noopener noreferrer">תצוגה מקדימה אצל Meta<span className="sr-only"> (נפתח בלשונית חדשה)</span></a>}
                  </div>
                  {!c.connected && <p className="hint">הערוץ לא מחובר כרגע.</p>}
                  {c.flow?.errors.some((e) => /integrity/i.test(e)) && (
                    <div className="row" style={{ alignItems: 'center' }}>
                      <button type="button" disabled={busy || !c.connected} onClick={() => void probe(c.id)}>אבחון: מה בדיוק Meta חוסמת?<span className="sr-only"> ב{c.label}</span></button>
                      <span className="hint">מפרסם אצל Meta כמה טפסי בדיקה (בלי שדות, עם חלק מהשדות, עם החתימה) ומסיר כל אחד מיד. כך מגלים אם החסימה בחשבון, בשדה מסוים או בשלב החתימה.</span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="hint">פרסום יוצר טופס חדש אצל Meta (טופס שפורסם שם אי אפשר לשנות). הגרסה הקודמת נשארת פעילה, כך שבקשות שכבר נשלחו בה עדיין ייפתחו ויתקבלו.</p>
        </>
      )}
      {msg && <p role="status" className={msg.ok ? 'ok' : 'error'}>{msg.text}</p>}
      {health && (
        <div className="card">
          <h3>מה Meta אומרת על החשבון</h3>
          <dl className="kv">{Object.entries(health).map(([k, v]) => <Fragment key={k}><dt>{HEALTH[k] ?? k}</dt><dd dir="ltr">{v}</dd></Fragment>)}</dl>
          <p className="hint">ערכים כמו PENDING, REJECTED, RED או FLAGGED מסבירים את החסימה. בעסק מאומת עם איכות GREEN, ובכל זאת חסום, צריך לפנות לתמיכה של Meta.</p>
        </div>
      )}
    </section>
  );
}

import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';

interface Item { id: string; kind: 'variant' | 'faq_draft' | 'option_example'; text: string; answer: string | null; hits: number; sourceTitle: string | null; node?: string; option?: string; updatedAt: string }
interface Fb { id: string; title: string; up: number; down: number; flagged: boolean }
interface Stats { thisWeek: number; thisWeekAnswered: number; thisWeekRate: number | null; lastWeek: number; lastWeekRate: number | null; pending: Record<string, number> }
interface Settings { enabled: boolean; autoVariants: boolean; autoAfter: number }

const ERR: Record<string, string> = {
  variants_full: 'לערך הזה כבר יש 20 ניסוחים. ערכו אותו במקורות ומחקו ניסוח ישן.',
  examples_full: 'לאפשרות הזו כבר יש 8 דוגמאות בתרשים.',
  option_gone: 'האפשרות הזו כבר לא קיימת בתרשים.',
  no_flow: 'אין תרשים שמור.',
  invalid_flow: 'השינוי היה הופך את התרשים ללא תקין.',
  not_pending: 'ההצעה כבר טופלה.',
  not_found: 'ההצעה לא נמצאה (אולי הערך נמחק).',
  bad_request: 'הטקסט קצר מדי.',
};
const SECTIONS: [Item['kind'], string, string][] = [
  ['variant', 'ניסוחים חדשים לשאלות קיימות', 'לקוחות שאלו בניסוח שלהם ובחרו ב"האם התכוונתם". באישור, הניסוח נוסף לערך והבוט יענה עליו ישירות.'],
  ['faq_draft', 'טיוטות שאלה-תשובה מתשובות נציגים', 'שאלות שהבוט לא ידע לענות עליהן ונציג ענה. טלפונים, מיילים, מספרים מזהים ושם הלקוח הוסרו אוטומטית, אבל ההסרה לא מושלמת: קראו לפני אישור.'],
  ['option_example', 'דוגמאות לאפשרויות בתפריט', 'לקוח כתב טקסט שהתפריט לא הבין ואז בחר אפשרות. באישור, הטקסט נוסף כדוגמה לאותה אפשרות.'],
];

/** "The bot learns": approve or reject what real conversations suggest, and see answers customers marked as unhelpful. */
export function BotLearning() {
  const [items, setItems] = useState<Item[]>([]);
  const [fb, setFb] = useState<Fb[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [set, setSet] = useState<Settings | null>(null);
  const [edits, setEdits] = useState<Record<string, { text?: string; answer?: string }>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = async () => {
    setItems(await api<Item[]>('GET', '/kb/learning').catch(() => []));
    setFb(await api<Fb[]>('GET', '/kb/learning/feedback').catch(() => []));
    setStats(await api<Stats>('GET', '/kb/learning/stats').catch(() => null));
  };
  useEffect(() => { void load(); void api<Settings>('GET', '/kb/learning/settings').then(setSet).catch(() => undefined); }, []);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try { await fn(); setMsg({ ok: true, text: ok }); await load(); } catch (e) { setMsg({ ok: false, text: e instanceof ApiError ? ERR[e.code] ?? 'הפעולה נכשלה.' : 'הפעולה נכשלה.' }); }
  };
  const ed = (id: string) => edits[id] ?? {};
  const rate = (r: number | null) => (r == null ? '—' : `${r}%`);

  return (
    <section aria-labelledby="learn-h">
      <h2 id="learn-h">הבוט לומד</h2>
      <p className="hint">הבוט אוסף הצעות משיחות אמיתיות. שום דבר לא משתנה בלי אישור שלכם (אלא אם הפעלתם אישור אוטומטי לניסוחים). כל אישור נרשם ביומן הפעולות. הצעות שלא אושרו נמחקות אחרי 90 יום.</p>
      {stats && (
        <div className="kpis" style={{ marginBottom: '1rem' }}>
          <div className="kpi"><div className="hint">שאלות שהבוט ענה עליהן השבוע</div><div className="kpi-v">{rate(stats.thisWeekRate)}</div><div className="hint">{stats.thisWeekAnswered} מתוך {stats.thisWeek}</div></div>
          <div className="kpi"><div className="hint">שבוע שעבר</div><div className="kpi-v">{rate(stats.lastWeekRate)}</div><div className="hint">{stats.lastWeek} שאלות</div></div>
          <div className="kpi"><div className="hint">הצעות שממתינות</div><div className="kpi-v">{Object.values(stats.pending).reduce((a, b) => a + b, 0)}</div></div>
        </div>
      )}
      <p role={msg?.ok === false ? 'alert' : 'status'} className={msg?.ok === false ? 'error' : 'ok'}>{msg?.text}</p>

      {set && (
        <details className="card">
          <summary><strong>הגדרות למידה</strong></summary>
          <div className="field"><label><input type="checkbox" style={{ width: 'auto', minHeight: 0, marginInlineEnd: '.5rem' }} checked={set.enabled} onChange={(e) => setSet({ ...set, enabled: e.target.checked })} />לאסוף הצעות למידה</label></div>
          <div className="field"><label><input type="checkbox" style={{ width: 'auto', minHeight: 0, marginInlineEnd: '.5rem' }} checked={set.autoVariants} onChange={(e) => setSet({ ...set, autoVariants: e.target.checked })} />לאשר אוטומטית ניסוח חדש כשמספיק לקוחות שונים בחרו באותה הצעה</label></div>
          {set.autoVariants && <div className="field"><label htmlFor="learn-after">כמה לקוחות שונים</label><input id="learn-after" type="number" min={2} max={20} value={set.autoAfter} onChange={(e) => setSet({ ...set, autoAfter: Number(e.target.value) })} style={{ maxWidth: 120 }} /></div>}
          <p className="hint">טיוטות מתשובות נציגים ודוגמאות לתפריט תמיד דורשות אישור ידני.</p>
          <button type="button" className="primary" onClick={() => void act(() => api('PUT', '/kb/learning/settings', set), 'הגדרות הלמידה נשמרו.')}>שמירה</button>
        </details>
      )}

      {SECTIONS.map(([kind, title, hint]) => {
        const list = items.filter((x) => x.kind === kind);
        return (
          <section key={kind} className="card" aria-labelledby={`learn-${kind}`}>
            <h3 id={`learn-${kind}`}>{title} ({list.length})</h3>
            <p className="hint">{hint}</p>
            {list.length === 0 ? <p>אין הצעות כרגע.</p> : (
              <ul className="plain">
                {list.map((x) => (
                  <li key={x.id} className="card" style={{ marginBottom: '.5rem' }}>
                    <p className="hint" style={{ marginTop: 0 }}>
                      {x.hits === 1 ? 'לקוח אחד' : `${x.hits} לקוחות`}
                      {kind === 'variant' && x.sourceTitle ? <> · לערך: <strong>{x.sourceTitle}</strong></> : null}
                      {kind === 'option_example' ? <> · לאפשרות: <strong>{x.option}</strong> (צומת {x.node})</> : null}
                    </p>
                    <div className="field"><label htmlFor={`lt-${x.id}`}>{kind === 'faq_draft' ? 'השאלה' : 'הניסוח של הלקוח'}</label>
                      <input id={`lt-${x.id}`} maxLength={kind === 'option_example' ? 80 : 300} value={ed(x.id).text ?? x.text} onChange={(e) => setEdits({ ...edits, [x.id]: { ...ed(x.id), text: e.target.value } })} /></div>
                    {kind === 'faq_draft' && (
                      <div className="field"><label htmlFor={`la-${x.id}`}>התשובה (לבדוק שאין פרטים אישיים)</label>
                        <textarea id={`la-${x.id}`} rows={4} maxLength={4000} value={ed(x.id).answer ?? x.answer ?? ''} onChange={(e) => setEdits({ ...edits, [x.id]: { ...ed(x.id), answer: e.target.value } })} /></div>
                    )}
                    <div className="row">
                      <button type="button" className="primary" onClick={() => void act(() => api('POST', `/kb/learning/${x.id}/approve`, ed(x.id)), 'אושר. הבוט ישתמש בזה מעכשיו.')}>אישור<span className="sr-only">: {x.text}</span></button>
                      <button type="button" onClick={() => void act(() => api('POST', `/kb/learning/${x.id}/reject`, {}), 'נדחה. ההצעה לא תוצע שוב.')}>דחייה<span className="sr-only">: {x.text}</span></button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}

      <section className="card" aria-labelledby="learn-fb">
        <h3 id="learn-fb">משוב לקוחות על תשובות</h3>
        <p className="hint">רגשונים שלקוחות שמו על תשובות הבוט בוואטסאפ: 👍 🙏 ❤️ = עזר, 👎 😡 = לא עזר. תשובה שסומנה "לא עזר" 3 פעמים ויותר (ופי שניים יותר מ"עזר") לא נשלחת ישירות, רק מוצעת, עד שתסמנו שבדקתם ותיקנתם אותה.</p>
        {fb.length === 0 ? <p>אין עדיין משוב.</p> : (
          <table>
            <caption className="sr-only">משוב לקוחות לפי ערך במאגר</caption>
            <thead><tr><th scope="col">ערך</th><th scope="col">עזר</th><th scope="col">לא עזר</th><th scope="col">מצב</th><th scope="col"><span className="sr-only">פעולות</span></th></tr></thead>
            <tbody>
              {fb.map((f) => (
                <tr key={f.id}>
                  <th scope="row">{f.title}</th><td>{f.up}</td><td>{f.down}</td>
                  <td>{f.flagged ? <span className="badge error">מוחזק מתשובה ישירה</span> : 'פעיל'}</td>
                  <td><button type="button" onClick={() => void act(() => api('POST', `/kb/learning/feedback/${f.id}/reviewed`, {}), 'סומן כנבדק. הספירה מתחילה מחדש.')}>סימון כנבדק<span className="sr-only">: {f.title}</span></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </section>
  );
}

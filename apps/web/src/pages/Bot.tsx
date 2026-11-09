import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, can, type Me } from '../api';
import { usePoll } from '../hooks';

interface BotCfg {
  enabled: boolean; welcome: string; items: { title: string; answer: string; contact?: { name: string; phone: string; message: string }; route?: { userId: string; byArea?: boolean } }[]; humanOption: boolean; humanLabel: string;
  humanKeywords: string[]; humanMessage: string; invalidMessage: string; invalidRetries: number; footer: string; preview?: string; mode?: 'menu' | 'flow';
  kb: { enabled: boolean; minScore: number; maxChars: number; showSource: boolean; intro: string };
  reactions?: { enabled: boolean; ackAll?: boolean; working: string; done: string; noAnswer: string; handoff: string };
  catchupHours?: number;
  interactiveMenus?: boolean;
}

const RX = { enabled: false, ackAll: false, working: '👀', done: '✅', noAnswer: '🤔', handoff: '🙋' };
const menuText = (b: BotCfg) =>
  `${b.welcome}\n\n${[...b.items.map((it, i) => `${i + 1}. ${it.title}`), ...(b.humanOption ? [`0. ${b.humanLabel}`] : [])].join('\n')}`;

export function Bot({ me }: { me: Me }) {
  const canEdit = can(me, 'bot.manage');
  const [b, setB] = useState<BotCfg | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => { void api<{ id: string; name: string }[]>('GET', '/settings/bot/assignees').then(setPeople).catch(() => undefined); }, []);
  usePoll(async () => { if (!b) setB(await api<BotCfg>('GET', '/settings/bot').catch(() => null)); }, 60000);
  if (!b) return <><h1 tabIndex={-1}>בוט</h1><p role="status">טוען…</p></>;

  const set = (patch: Partial<BotCfg>) => setB({ ...b, ...patch });
  const setItem = (i: number, patch: Partial<BotCfg['items'][number]>) => set({ items: b.items.map((it, k) => (k === i ? { ...it, ...patch } : it)) });
  const move = (i: number, d: -1 | 1) => {
    const j = i + d; if (j < 0 || j >= b.items.length) return;
    const items = [...b.items]; [items[i], items[j]] = [items[j]!, items[i]!]; set({ items });
  };

  async function save(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    const { preview: _p, ...payload } = b!;
    try {
      setB(await api<BotCfg>('PUT', '/settings/bot', payload));
      setMsg({ ok: true, text: 'הבוט נשמר.' });
    } catch (er) {
      setMsg({ ok: false, text: er instanceof ApiError && er.code === 'bad_request' ? 'הנתונים אינם תקינים (בדקו שכל כותרת ותשובה מלאות, עד 9 פריטים).' : 'השמירה נכשלה.' });
    }
  }

  return (
    <>
      <h1 tabIndex={-1}>בוט תפריט</h1>
      {!canEdit && <p className="banner" role="note">צפייה בלבד. רק מנהל יכול לשנות את הבוט.</p>}
      <form className="card" onSubmit={save}>
        <p className="hint">הלקוח מקבל תפריט ממוספר ועונה במספר. אם אין התאמה, או שהוא מבקש נציג, השיחה עוברת לנציג (עם הודעה פנימית, שיוך אוטומטי אם הוגדר ניתוב, ו"מחוץ לשעות" אם הוגדרו שעות פעילות). אין שימוש בשירותי AI חיצוניים.</p>
        <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0 }}>
          <div className="field">
            <label><input type="checkbox" style={{ width: 'auto', minHeight: 0, marginInlineEnd: '.5rem' }} checked={b.enabled} onChange={(e) => set({ enabled: e.target.checked })} />הפעלת הבוט</label>
          </div>
          <div className="field">
            <label htmlFor="b-welcome">הודעת פתיחה (מעל התפריט)</label>
            <textarea id="b-welcome" rows={2} maxLength={1000} required value={b.welcome} onChange={(e) => set({ welcome: e.target.value })} />
          </div>

          <h2>פריטי התפריט (עד 9)</h2>
          {b.items.map((it, i) => (
            <fieldset key={i} className="card" style={{ marginBottom: '.75rem' }}>
              <legend>פריט {i + 1}</legend>
              <div className="field">
                <label htmlFor={`bt${i}`}>כותרת (מוצגת בתפריט)</label>
                <input id={`bt${i}`} required maxLength={60} value={it.title} onChange={(e) => setItem(i, { title: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor={`ba${i}`}>תשובה</label>
                <textarea id={`ba${i}`} required rows={3} maxLength={1500} value={it.answer} onChange={(e) => setItem(i, { answer: e.target.value })} />
              </div>
              <div className="field">
                <label><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={!!it.route} onChange={(e) => setItem(i, { route: e.target.checked ? { userId: people[0]?.id ?? '' } : undefined })} disabled={people.length === 0} /> העברת השיחה לנציג מסוים שאחראי על הנושא (השיחה נשארת במערכת)</label>
                {it.route && (
                  <div className="card" style={{ marginTop: '.5rem' }}>
                    <label htmlFor={`brt${i}`}>הנציג האחראי</label>
                    <select id={`brt${i}`} required value={it.route.userId} onChange={(e) => setItem(i, { route: { ...it.route!, userId: e.target.value } })}>
                      {people.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                    </select>
                    <label><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={!!it.route.byArea} onChange={(e) => setItem(i, { route: { ...it.route!, byArea: e.target.checked || undefined } })} /> לשאול את הלקוח באיזה בניין או מקום מדובר, ולהעביר לנציג שאחראי על המקום</label>
                    <p className="hint">האחראי על כל מקום מוגדר ב<a href="#/safety">לוח בטיחות ← אזורי אחריות</a> (ידנית או בייבוא אקסל). אם המקום לא מזוהה, הנציג שנבחר כאן מקבל את השיחה.</p>
                    <p className="hint">אחרי התשובה הלקוח מועבר לנציג הזה, והבוט שותק. אם הנציג מושבת, תופעל ההקצאה הרגילה. אפשר לשלב עם הפניה לווצאפ אישי (למטה), ואז הלקוח מקבל גם קישור וגם נציג במערכת.</p>
                  </div>
                )}
              </div>
              <div className="field">
                <label><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={!!it.contact} onChange={(e) => setItem(i, { contact: e.target.checked ? { name: '', phone: '', message: '' } : undefined })} /> הפניה לווצאפ אישי של איש מקצוע (למשל ממונה בטיחות לתחום זה)</label>
                {it.contact && (
                  <div className="card" style={{ marginTop: '.5rem' }}>
                    <div className="field"><label htmlFor={`bcn${i}`}>שם ותפקיד (יוצג ללקוח)</label><input id={`bcn${i}`} required maxLength={60} value={it.contact.name} onChange={(e) => setItem(i, { contact: { ...it.contact!, name: e.target.value } })} placeholder="דני כהן, ממונה בטיחות בעבודה בגובה" /></div>
                    <div className="field"><label htmlFor={`bcp${i}`}>מספר ווצאפ</label><input id={`bcp${i}`} required dir="ltr" inputMode="tel" pattern="\+?[\d\s\-]{8,18}" value={it.contact.phone} onChange={(e) => setItem(i, { contact: { ...it.contact!, phone: e.target.value } })} placeholder="0501234567" /></div>
                    <div className="field"><label htmlFor={`bcm${i}`}>הודעה שתוכתב מראש ללקוח (אופציונלי)</label><input id={`bcm${i}`} maxLength={200} value={it.contact.message} onChange={(e) => setItem(i, { contact: { ...it.contact!, message: e.target.value } })} placeholder="שלום, אני פונה בנושא בטיחות בגובה" /></div>
                    <p className="hint">הלקוח יקבל קישור שפותח צ'אט ווצאפ ישירות עם האדם. המספר יוצג ללקוחות, ולכן יש לקבל את הסכמת האדם לכך. השיחה הנוכחית נשארת בבוט ולא תועבר לנציג.</p>
                  </div>
                )}
              </div>
              <div className="row">
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0}>הזזה למעלה<span className="sr-only"> פריט {i + 1}</span></button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === b.items.length - 1}>הזזה למטה<span className="sr-only"> פריט {i + 1}</span></button>
                <button type="button" className="danger" onClick={() => set({ items: b.items.filter((_, k) => k !== i) })}>מחיקה<span className="sr-only"> פריט {i + 1}</span></button>
              </div>
            </fieldset>
          ))}
          {b.items.length < 9 && <button type="button" onClick={() => set({ items: [...b.items, { title: '', answer: '' }] })}>הוספת פריט</button>}
          {b.items.some((it) => it.route) && (
            <table style={{ marginTop: '.75rem' }}>
              <caption>מי מטפל בכל נושא</caption>
              <thead><tr><th scope="col">נושא</th><th scope="col">נציג</th><th scope="col">לפי מקום</th></tr></thead>
              <tbody>{b.items.filter((it) => it.route).map((it, k) => <tr key={k}><th scope="row">{it.title || '(ללא כותרת)'}</th><td>{people.find((u) => u.id === it.route!.userId)?.name ?? 'לא נבחר'}</td><td>{it.route!.byArea ? 'כן' : 'לא'}</td></tr>)}</tbody>
            </table>
          )}

          <h2 style={{ marginTop: '1.25rem' }}>מעבר לנציג</h2>
          <div className="field">
            <label><input type="checkbox" style={{ width: 'auto', minHeight: 0, marginInlineEnd: '.5rem' }} checked={b.humanOption} onChange={(e) => set({ humanOption: e.target.checked })} />להציג בתפריט את האפשרות "0" לנציג אנושי</label>
          </div>
          <div className="field">
            <label htmlFor="b-hl">שם האפשרות "0"</label>
            <input id="b-hl" required maxLength={40} value={b.humanLabel} onChange={(e) => set({ humanLabel: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="b-kw">מילים שמעבירות לנציג (מופרדות בפסיק)</label>
            <input id="b-kw" value={b.humanKeywords.join(', ')} aria-describedby="b-kw-h"
              onChange={(e) => set({ humanKeywords: e.target.value.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 10) })} />
            <p id="b-kw-h" className="hint">הודעה שמכילה אחת מהמילים (באותיות כלשהן) מעבירה לנציג, למשל "נציג, agent, human".</p>
          </div>
          <div className="field">
            <label htmlFor="b-hm">הודעה ללקוח בעת המעבר לנציג</label>
            <textarea id="b-hm" required rows={2} maxLength={500} value={b.humanMessage} onChange={(e) => set({ humanMessage: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="b-im">הודעה כשלא הובנה הבחירה</label>
            <input id="b-im" required maxLength={300} value={b.invalidMessage} onChange={(e) => set({ invalidMessage: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="b-ir">כמה פעמים להציג שוב את התפריט לפני מעבר לנציג</label>
            <select id="b-ir" value={b.invalidRetries} onChange={(e) => set({ invalidRetries: Number(e.target.value) })}>
              <option value={0}>0 – מעבר מיידי לנציג</option>
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="b-ft">שורת תחתית אחרי כל תשובה (אופציונלי)</label>
            <input id="b-ft" maxLength={300} value={b.footer} onChange={(e) => set({ footer: e.target.value })} />
          </div>
        </fieldset>

        <p className="card">מצב הבוט כעת: <strong>{b.mode === 'flow' ? 'תרשים זרימה' : 'תפריט ממוספר (העמוד הזה)'}</strong>. לבניית שיחה מתקדמת עם שאלות, תנאים והפניות: <a href="#/flow">תרשים זרימה</a>.</p>

        <fieldset disabled={!canEdit}>
          <legend>תפריט ככפתורים (ווצאפ רשמי)</legend>
          <div className="field"><label><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={b.interactiveMenus !== false} onChange={(e) => set({ interactiveMenus: e.target.checked })} /> בערוץ הרשמי, לשלוח את התפריט ככפתורים או כרשימה לבחירה</label>
            <p className="hint">עד שלוש אפשרויות קצרות (עד 20 תווים) נשלחות ככפתורים, עד עשר כרשימה, ותפריט ארוך מזה נשלח כטקסט ממוספר. לחיצה של הלקוח נקראת כמו מספר שהקליד. אם Meta דוחה את ההודעה, נשלח הטקסט הממוספר. בערוצים האחרים התפריט נשאר טקסט ממוספר. מגבלות והפורמט אצל Meta צריכים אימות מול התיעוד הרשמי.</p></div>
        </fieldset>

        <fieldset disabled={!canEdit}>
          <legend>תשובה אחרי ניתוק החיבור</legend>
          <p className="hint">אם הערוץ (למשל הטלפון) איבד תקשורת ובזמן הזה הבוט לא הצליח לענות, ההודעה של הלקוח נשמרת, והבוט עונה לה ברגע שהחיבור חוזר (בדרך כלל תוך כמה שניות, ובדיקה גם בכל דקה). אם הלקוח כתב כמה הודעות, הבוט עונה לאחרונה. אחרי חמישה ניסיונות או אחרי מספר השעות שמוגדר כאן הוא מפסיק ומשאיר הערה פנימית כדי שנציג יטפל בשיחה.</p>
          <div className="field">
            <label htmlFor="b-cu">להמשיך לענות עד כמה שעות אחרי ההודעה (0 = לא לענות אחרי ניתוק)</label>
            <input id="b-cu" type="number" min={0} max={72} style={{ maxWidth: 120 }} value={b.catchupHours ?? 12} onChange={(e) => set({ catchupHours: Math.min(72, Math.max(0, Math.round(Number(e.target.value) || 0))) })} />
          </div>
        </fieldset>

        <fieldset disabled={!canEdit}>
          <legend>תגובות אוטומטיות (אימוג׳י על הודעת הלקוח)</legend>
          <p className="hint">הבוט מגיב באימוג׳י על ההודעה של הלקוח לפי מה שהוא עושה: כשהלקוח שואל והבוט מחפש במאגר הידע, מופיע "עיניים" על ההודעה, ואחרי שהתשובה נשלחה האימוג׳י מוחלף בסימון הצלחה (או "לא מצאתי"). כשהבוט מעביר לנציג יופיע אימוג׳י העברה. אימוג׳י ריק = בלי תגובה לאירוע הזה, ואם כבר הוצגה "עיניים" היא תוסר.</p>
          <div className="field"><label><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={!!b.reactions?.enabled} onChange={(e) => set({ reactions: { ...(b.reactions ?? RX), enabled: e.target.checked } })} /> להפעיל תגובות אוטומטיות</label></div>
          {b.reactions?.enabled && (
            <div className="field"><label><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={!!b.reactions.ackAll} onChange={(e) => set({ reactions: { ...b.reactions!, ackAll: e.target.checked } })} /> להגיב על כל הודעה (עיניים מיד עם הקבלה, ואחרי המענה סימון סיום), גם כשלא מתבצע חיפוש</label>
              <p className="hint">בלי הסימון, העיניים מופיעות רק כשהבוט מחפש במאגר הידע בעקבות שאלה חופשית. בתפריט ממוספר ובתרשים בלי צומת מאגר ידע אין חיפוש, ולכן בלי הסימון לא תהיה תגובה על רוב ההודעות.</p></div>
          )}
          {b.reactions?.enabled && (
            <div className="row">
              {([['working', 'בזמן חיפוש'], ['done', 'נמצאה תשובה'], ['noAnswer', 'לא נמצאה תשובה'], ['handoff', 'העברה לנציג']] as const).map(([k, label]) => (
                <div className="field" key={k}><label htmlFor={`rx-${k}`}>{label}</label>
                  <input id={`rx-${k}`} style={{ width: 90, fontSize: '1.4rem', textAlign: 'center' }} maxLength={12} value={b.reactions![k]} onChange={(e) => set({ reactions: { ...b.reactions!, [k]: e.target.value.trim() } })} aria-describedby="rx-hint" /></div>
              ))}
            </div>
          )}
          <ReactionDiagnostics />
          <p id="rx-hint" className="hint">אימוג׳י אחד בכל שדה. עובד בווצאפ (QR ורשמי) ובטלגרם (טלגרם מאפשר רק קבוצה קבועה של אימוג׳י, למשל 👀 👍 🤔 🙏; אחרים לא יוצגו). בצ׳אט באתר אין תגובות. התגובות נשלחות רק בתגובה להודעה שהלקוח כתב, עד 30 בדקה לערוץ, ולכן הן לא מגדילות סיכון לחסימה כמו הודעות יזומות.</p>
        </fieldset>

        <fieldset className="card" disabled={!canEdit}>
          <legend>מענה ממאגר הידע</legend>
          <p className="hint">הבוט עונה על שאלה חופשית מתוך המסמכים, הקישורים והשאלות והתשובות שב<a href="#/kb">מאגר הידע</a>. זה חיפוש מילים בשרת שלכם, בלי בינה מלאכותית ובלי לשלוח מידע החוצה. כשאין התאמה טובה הבוט ממשיך כרגיל (תפריט, ואז העברה לנציג).</p>
          <div className="field">
            <label><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={b.kb.enabled} onChange={(e) => set({ kb: { ...b.kb, enabled: e.target.checked } })} /> לאפשר מענה ממאגר הידע</label>
          </div>
          <div className="field">
            <label htmlFor="b-kms">רמת ביטחון מינימלית ({Math.round(b.kb.minScore * 100)}%)</label>
            <input id="b-kms" type="range" min={0.3} max={1} step={0.05} value={b.kb.minScore} onChange={(e) => set({ kb: { ...b.kb, minScore: Number(e.target.value) } })} />
            <p className="hint">גבוה יותר = פחות תשובות אבל בטוחות יותר. מומלץ 60% ומעלה. אפשר לבדוק ב"בדיקת חיפוש" במאגר.</p>
          </div>
          <div className="field">
            <label htmlFor="b-kin">פתיח לפני התשובה</label>
            <input id="b-kin" maxLength={120} value={b.kb.intro} onChange={(e) => set({ kb: { ...b.kb, intro: e.target.value } })} />
          </div>
          <div className="field">
            <label htmlFor="b-kmc">אורך תשובה מרבי (תווים)</label>
            <input id="b-kmc" type="number" min={200} max={1500} step={50} value={b.kb.maxChars} onChange={(e) => set({ kb: { ...b.kb, maxChars: Number(e.target.value) } })} />
          </div>
          <div className="field">
            <label><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={b.kb.showSource} onChange={(e) => set({ kb: { ...b.kb, showSource: e.target.checked } })} /> להציג את המקור (כתובת או שם המסמך) מתחת לתשובה</label>
          </div>
        </fieldset>

        <section aria-labelledby="b-prev" className="card">
          <h2 id="b-prev">תצוגה מקדימה של התפריט שהלקוח יקבל</h2>
          <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontFamily: 'inherit' }}>{menuText(b)}</pre>
          {b.items.some((x) => x.contact) && <p className="hint">פריטים עם הפניה שולחים ללקוח, אחרי התשובה, קישור ווצאפ לאיש הקשר שהגדרתם.</p>}
        </section>

        {canEdit && <button className="primary" type="submit">שמירה</button>}
        <p role="status" className={msg?.ok ? 'ok' : 'error'}>{msg?.text}</p>
      </form>
    </>
  );
}


interface RxDiag { enabled: boolean; reactionsEnabled: boolean; ackAll: boolean; mode: string; searches: boolean; hints: string[]; log: { at: string; channel: string; emoji: string; outcome: string }[] }
const OUTCOME: Record<string, string> = { sent: 'נשלחה', no_support: 'הערוץ לא תומך בתגובות', not_connected: 'הערוץ לא מחובר', paused: 'הערוץ מושהה', rate_limited: 'חריגה ממכסת התגובות (30 בדקה)' };

/** Why there may be no reaction on a customer's message: what is on, whether this bot ever searches, and the last attempts with their outcome. */
function ReactionDiagnostics() {
  const [d, setD] = useState<RxDiag | null>(null);
  const load = async () => setD(await api<RxDiag>('GET', '/settings/bot/reactions').catch(() => null));
  return (
    <details onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) void load(); }}>
      <summary>למה אין תגובות? בדיקה</summary>
      {!d ? <p className="hint">טוען…</p> : (
        <>
          <p>מה שמור בשרת: הבוט {d.enabled ? 'פעיל' : 'כבוי'}, תגובות {d.reactionsEnabled ? 'פעילות' : 'כבויות'}, "להגיב על כל הודעה" {d.ackAll ? 'פעיל' : 'כבוי'}, מצב {d.mode === 'flow' ? 'תרשים' : 'תפריט'}, חיפוש במאגר הידע {d.searches ? 'מתבצע' : 'לא מתבצע'}.</p>
          {d.hints.length > 0 ? <ul>{d.hints.map((h) => <li key={h}>{h}</li>)}</ul> : <p className="ok">לא נמצאה סיבה בהגדרות.</p>}
          <p><strong>ניסיונות אחרונים</strong> (מאז שהשרת עלה):</p>
          {d.log.length === 0 ? <p className="hint">עוד לא נעשה אף ניסיון להגיב. אם שלחתם הודעה ולא נרשם כלום, ההגדרה לא נשמרה, השרת לא עודכן לגרסה הזו, או שהבוט לא טיפל בהודעה (שיחה שנציג לקח, או בוט כבוי).</p> : (
            <table>
              <caption className="sr-only">ניסיונות תגובה אחרונים</caption>
              <thead><tr><th scope="col">מתי</th><th scope="col">ערוץ</th><th scope="col">אימוג׳י</th><th scope="col">תוצאה</th></tr></thead>
              <tbody>{d.log.slice(0, 10).map((l, i) => <tr key={i}><td>{new Date(l.at).toLocaleTimeString('he-IL')}</td><td>{l.channel}</td><td>{l.emoji || '(הסרה)'}</td><td>{OUTCOME[l.outcome] ?? (l.outcome.startsWith('error:') ? `שגיאה: ${l.outcome.slice(6)}` : l.outcome)}</td></tr>)}</tbody>
            </table>
          )}
          <button type="button" onClick={() => void load()}>רענון</button>
        </>
      )}
    </details>
  );
}

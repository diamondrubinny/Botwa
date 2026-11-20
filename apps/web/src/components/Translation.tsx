import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type Message } from '../api';

/**
 * Translation for the agent by the local model on the server (no outside service):
 *  - MessageTranslation: under a customer's message in English, Arabic or Russian, its Hebrew translation (automatic when the unit
 *    turned that on, else on a click);
 *  - DraftTranslation: in the composer of a conversation in another language, the agent's Hebrew reply translated into it, shown
 *    for review and editing before it is sent.
 * Machine translation can be wrong: it is labelled as such everywhere, and the original is always shown.
 */
type Lang = 'he' | 'en' | 'ar' | 'ru';
export const LANG_HE: Record<Exclude<Lang, 'he'>, string> = { en: 'אנגלית', ar: 'ערבית', ru: 'רוסית' };
interface Status { configured: boolean; ready: boolean; auto: boolean }

let statusP: Promise<Status> | null = null;
let statusAt = 0;
/** Asked of the server at most once a minute for the whole panel. */
function loadStatus(): Promise<Status> {
  if (!statusP || Date.now() - statusAt > 60_000) {
    statusAt = Date.now();
    statusP = api<Status>('GET', '/translation/status').catch(() => ({ configured: false, ready: false, auto: false }));
  }
  return statusP;
}
export function useTranslationStatus(): Status | null {
  const [s, setS] = useState<Status | null>(null);
  useEffect(() => { let live = true; void loadStatus().then((x) => { if (live) setS(x); }); return () => { live = false; }; }, []);
  return s;
}
/** After the unit changes the setting, the next screen asks again. */
export const resetTranslationStatus = () => { statusP = null; };

/** Is this text in a language other than Hebrew, with enough letters to translate? (the server decides finally) */
export function foreignLang(text: string | null | undefined): Exclude<Lang, 'he'> | null {
  if (!text) return null;
  const t = text.replace(/https?:\/\/\S+|www\.\S+|\S+@\S+\.\S+/gi, ' ');
  const he = (t.match(/[א-ת]/g) ?? []).length;
  const en = (t.match(/[A-Za-z]/g) ?? []).length;
  const ar = (t.match(/[ء-ي]/g) ?? []).length;
  const ru = (t.match(/[Ѐ-ӿ]/g) ?? []).length;
  if (ar >= 3 && ar > he && ar >= en / 2) return 'ar';
  if (ru >= 3 && ru > he && ru >= en / 2) return 'ru';
  if (en >= 3 && he === 0 && ar === 0 && ru === 0 && /[a-z]{2,}/i.test(t) && !/^\s*botwa[-\s]?\d+\s*$/i.test(t)) return 'en';
  if (en >= 12 && en > he * 4) return 'en';
  return null;
}

// automatic translations run one at a time from this panel: the model serves the whole team on one server
let chain: Promise<unknown> = Promise.resolve();
const queued = <T,>(fn: () => Promise<T>): Promise<T> => { const p = chain.then(fn, fn); chain = p.catch(() => undefined); return p; };

const ERR: Record<string, string> = {
  translation_unavailable: 'התרגום לא זמין כרגע: המודל המקומי לא פעיל בשרת.',
  translation_failed: 'התרגום נכשל או לא נראה אמין. נסו שוב, או קראו את המקור.',
  too_long: 'ההודעה ארוכה מדי לתרגום.',
  not_needed: 'אין צורך בתרגום.',
  rate_limited: 'יותר מדי תרגומים בדקה. נסו שוב בעוד רגע.',
};
const errText = (e: unknown) => ERR[e instanceof ApiError ? e.code : ''] ?? 'התרגום נכשל. נסו שוב.';
const WARN = 'המספרים בתרגום לא זהים למקור: בדקו אותם מול ההודעה המקורית.';

/** Under a customer's message: the Hebrew translation (kept on the server, so it is made once). `auto`: request it without a click. */
export function MessageTranslation({ convId, m, auto }: { convId: string; m: Message; auto: boolean }) {
  const [t, setT] = useState<{ text: string; warning?: string } | null>(m.translationHe ? { text: m.translationHe, ...(m.translationWarn ? { warning: 'numbers' } : {}) } : null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [none, setNone] = useState(false);
  const tried = useRef(false);
  const run = async () => {
    setBusy(true); setErr('');
    try { setT(await queued(() => api<{ text: string; warning?: string }>('POST', `/conversations/${convId}/messages/${m.id}/translation`))); }
    catch (e) { if (e instanceof ApiError && e.code === 'not_needed') setNone(true); else setErr(errText(e)); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    if (auto && !t && !tried.current) { tried.current = true; void run(); }
  }, [auto]); // eslint-disable-line react-hooks/exhaustive-deps
  if (t) {
    return (
      <div className="msg-translation" role="group" aria-label="תרגום לעברית">
        <small className="mt-label">תרגום אוטומטי לעברית (עשוי להכיל טעויות)</small>
        <div dir="rtl">{t.text}</div>
        {t.warning && <small className="mt-warn" role="note">⚠️ {WARN}</small>}
      </div>
    );
  }
  if (none) return null;
  return (
    <div className="msg-translation-actions">
      <button type="button" className="link-btn" disabled={busy} aria-busy={busy} onClick={() => void run()}>{busy ? 'מתרגם…' : 'תרגום לעברית'}</button>
      {err && <small role="alert" className="mt-warn">{err}</small>}
    </div>
  );
}

/** Under an agent's reply that was sent translated: what the agent wrote in Hebrew. */
export function SentOriginal({ text }: { text: string }) {
  return (
    <details className="msg-translation">
      <summary><small>נשלח בתרגום אוטומטי · מה שנכתב בעברית</small></summary>
      <div dir="rtl">{text}</div>
    </details>
  );
}

/**
 * In the composer of a conversation in another language: translate the Hebrew draft, review and edit the translation, send it.
 * The customer gets the translation; the Hebrew is kept with the message for the team.
 */
export function DraftTranslation({ convId, lang, draft, disabled, onSend }: { convId: string; lang: Exclude<Lang, 'he'>; draft: string; disabled: boolean; onSend: (translated: string, original: string) => Promise<boolean> }) {
  const [out, setOut] = useState<{ text: string; original: string; warning?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setOut(null); setErr(''); }, [convId]);
  const translate = async () => {
    if (!draft.trim()) return;
    setBusy(true); setErr('');
    try {
      const r = await api<{ text: string; warning?: string }>('POST', `/conversations/${convId}/translate-draft`, { text: draft });
      setOut({ ...r, original: draft });
      requestAnimationFrame(() => box.current?.focus());
    } catch (e) { setErr(errText(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="draft-translation">
      {!out && (
        <button type="button" onClick={() => void translate()} disabled={busy || disabled || !draft.trim()} aria-busy={busy}>
          {busy ? 'מתרגם…' : `תרגום ל${LANG_HE[lang]} לפני שליחה`}
        </button>
      )}
      {err && <p role="alert" className="mt-warn">{err}</p>}
      {out && (
        <div className="draft-translation-preview" role="group" aria-labelledby={`dt-l-${convId}`}>
          <label id={`dt-l-${convId}`} htmlFor={`dt-${convId}`}>התרגום ל{LANG_HE[lang]} שיישלח ללקוח (אפשר לערוך). תרגום אוטומטי: כדאי לעבור עליו.</label>
          <textarea id={`dt-${convId}`} ref={box} rows={3} maxLength={4000} dir={lang === 'ar' ? 'rtl' : 'ltr'} lang={lang} value={out.text} onChange={(e) => setOut({ ...out, text: e.target.value })} />
          {out.warning && <p className="mt-warn" role="note">⚠️ {WARN}</p>}
          {out.original !== draft && <p className="hint" role="note">התשובה בעברית השתנתה מאז התרגום. אפשר לתרגם שוב.</p>}
          <div className="row" style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
            <button type="button" className="primary" disabled={disabled || busy || !out.text.trim()} onClick={async () => { setBusy(true); try { if (await onSend(out.text.trim(), out.original)) setOut(null); } finally { setBusy(false); } }}>שליחת התרגום</button>
            <button type="button" disabled={busy} onClick={() => void translate()}>תרגום מחדש</button>
            <button type="button" disabled={busy} onClick={() => setOut(null)}>ביטול</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Bot settings: translate customers' messages for the agent automatically, or only on a click. Saved at once. */
export function AgentTranslationSetting({ canEdit }: { canEdit: boolean }) {
  const st = useTranslationStatus();
  const [auto, setAuto] = useState<boolean | null>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => { if (st) setAuto(st.auto); }, [st]);
  if (!st || auto === null) return null;
  return (
    <fieldset className="field" id="agent-mt">
      <legend>תרגום לנציג (במודל המקומי)</legend>
      <p className="hint">כשלקוח כותב באנגלית, בערבית או ברוסית, הנציג רואה תרגום לעברית מתחת להודעה, ויכול לכתוב בעברית ולתרגם לשפת הלקוח לפני השליחה (עם אפשרות לערוך). התרגום נעשה בשרת שלכם ושום דבר לא נשלח החוצה. תרגום אוטומטי עשוי לטעות: המקור תמיד מוצג.</p>
      <label>
        <input type="checkbox" checked={auto} disabled={!canEdit} onChange={async (e) => {
          const v = e.target.checked;
          try { await api('PUT', '/settings/agent-translation', { auto: v }); setAuto(v); resetTranslationStatus(); setMsg('נשמר.'); }
          catch { setMsg('השינוי לא נשמר.'); }
        }} /> לתרגם הודעות של לקוחות לעברית מיד כשפותחים שיחה (בלי לחיצה)
      </label>
      <p className={st.ready ? 'ok' : 'hint'} role="status">
        {!st.configured ? 'המודל המקומי לא מותקן בשרת, ולכן התרגום לא זמין. התקנה: bash scripts/enable-local-llm.sh.' : !st.ready ? 'המודל המקומי לא עונה כרגע, ולכן התרגום לא זמין.' : 'התרגום זמין.'}
        {msg && ` ${msg}`}
      </p>
      <GlossaryEditor canEdit={canEdit} />
    </fieldset>
  );
}

interface Term { he: string; en: string; ar: string; ru: string }
/** The unit's fixed terms for machine translation (מנדף = fume hood). The model gets the terms that appear in each text. */
export function GlossaryEditor({ canEdit }: { canEdit: boolean }) {
  const [rows, setRows] = useState<Term[] | null>(null);
  const [defaults, setDefaults] = useState<Term[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api<{ entries: Term[]; defaults: Term[] }>('GET', '/settings/mt-glossary').then((r) => { setRows(r.entries); setDefaults(r.defaults); }).catch(() => setRows([])); }, []);
  if (!rows) return null;
  const set = (i: number, k: keyof Term, v: string) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const COLS: [keyof Term, string, 'rtl' | 'ltr'][] = [['he', 'עברית', 'rtl'], ['en', 'English', 'ltr'], ['ar', 'العربية', 'rtl'], ['ru', 'Русский', 'ltr']];
  return (
    <details className="field" id="mt-glossary">
      <summary>מילון מונחים לתרגום ({rows.length})</summary>
      <p className="hint">מונח שמופיע בטקסט מתורגם תמיד כפי שכתוב כאן, למשל "מנדף" ← "fume hood". אפשר להשאיר תא ריק. התרגומים לערבית ולרוסית ברשימה ההתחלתית הם טיוטה שכדאי שדובר השפה יבדוק.</p>
      <div className="table-wrap">
        <table>
          <caption className="sr-only">מונחים קבועים לתרגום</caption>
          <thead><tr>{COLS.map(([k, l]) => <th key={k} scope="col">{l}</th>)}<th scope="col"><span className="sr-only">פעולות</span></th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {COLS.map(([k, l, dir]) => (
                  <td key={k}><input aria-label={`${l}, שורה ${i + 1}`} dir={dir} lang={k} maxLength={120} disabled={!canEdit} value={r[k]} onChange={(e) => set(i, k, e.target.value)} /></td>
                ))}
                <td>{canEdit && <button type="button" className="sm" onClick={() => setRows(rows.filter((_, j) => j !== i))}>הסרה<span className="sr-only"> – {r.he || `שורה ${i + 1}`}</span></button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canEdit && (
        <div className="row" style={{ gap: '.5rem', flexWrap: 'wrap', marginTop: '.5rem' }}>
          <button type="button" onClick={() => setRows([...rows, { he: '', en: '', ar: '', ru: '' }])} disabled={rows.length >= 300}>הוספת מונח</button>
          <button type="button" className="primary" disabled={busy} onClick={async () => {
            setBusy(true); setMsg(null);
            try { const r = await api<{ entries: Term[] }>('PUT', '/settings/mt-glossary', { entries: rows }); setRows(r.entries); setMsg({ ok: true, text: `נשמר (${r.entries.length} מונחים). שורות בלי מונח בעברית או בלי אף תרגום לא נשמרות.` }); }
            catch { setMsg({ ok: false, text: 'השמירה נכשלה.' }); }
            finally { setBusy(false); }
          }}>שמירת המילון</button>
          <button type="button" onClick={() => setRows(defaults)}>חזרה לרשימה ההתחלתית</button>
        </div>
      )}
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'ok' : 'error'}>{msg.text}</p>}
    </details>
  );
}

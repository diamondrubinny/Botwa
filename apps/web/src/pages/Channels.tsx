import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, type Channel, type ChannelHealth } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { usePoll } from '../hooks';
import { errText, t } from '../strings';

const WARN: Record<string, string> = {
  restricted: 'החשבון הוגבל או נחסם (חשד). עצרו שליחה אוטומטית ובדקו את הטלפון/האפליקציה. אל תקשרו מחדש שוב ושוב.',
  logged_out: 'החשבון מנותק. נדרש קישור מחדש.',
  daily_cap_reached: 'הגעתם למכסה היומית. ההודעות לא יישלחו עד שהמכסה תתפנה.',
  daily_cap_near: 'מתקרבים למכסה היומית.',
  warming_up: 'מכסה מוגדלת בהדרגה ככל שהמספר "מתבגר".',
};

type Pending = { kind: 'logout' | 'delete'; ch: Channel } | null;

export function Channels({ isAdmin }: { isAdmin: boolean }) {
  const [list, setList] = useState<Channel[]>([]);
  const [label, setLabel] = useState('');
  const [type, setType] = useState<'whatsapp' | 'telegram'>('whatsapp');
  const [msg, setMsg] = useState('');
  const [linking, setLinking] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [health, setHealth] = useState<ChannelHealth[]>([]);
  usePoll(async () => setHealth(await api<ChannelHealth[]>('GET', '/channels/health').catch(() => [])), 15000);
  const [pairFor, setPairFor] = useState<string | null>(null);
  const [phone, setPhone] = useState('');

  const reload = async () => setList(await api<Channel[]>('GET', '/channels').catch(() => []));
  usePoll(reload, 5000);

  const run = async (fn: () => Promise<unknown>) => {
    setMsg('');
    try { await fn(); await reload(); } catch (e) { setMsg(errText(e instanceof ApiError ? e.code : 'generic')); }
  };

  async function create(e: FormEvent) {
    e.preventDefault();
    await run(() => api('POST', '/channels', { type, label }));
    setLabel('');
  }

  return (
    <>
      <h1 tabIndex={-1}>ערוצים</h1>
      <p role="alert" className="error">{msg}</p>
      <section className="card" aria-labelledby="health-h">
        <h2 id="health-h">בריאות ערוצים והגנה מחסימה</h2>
        {health.length === 0 ? <p>אין ערוצים.</p> : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <caption className="sr-only">מצב ערוצים, כמות הודעות שנשלחו מול המכסה, ואזהרות</caption>
              <thead><tr><th scope="col">ערוץ</th><th scope="col">מצב</th><th scope="col">נשלחו ב-24 שעות</th><th scope="col">אזהרות</th><th scope="col">אירועים אחרונים</th></tr></thead>
              <tbody>
                {health.map((h) => (
                  <tr key={h.id}>
                    <th scope="row">{h.label}</th>
                    <td><span className={`badge ${h.status}`}>{t.status[h.status] ?? h.status}</span></td>
                    <td>{h.sentLast24h} / {h.dailyCap}{h.warnings.includes('warming_up') ? ' (חימום מספר חדש)' : ''}</td>
                    <td>
                      {h.warnings.length === 0 ? '—' : (
                        <ul style={{ margin: 0, paddingInlineStart: '1rem' }}>
                          {h.warnings.map((w) => <li key={w} className={w === 'warming_up' ? 'hint' : 'error'}>{WARN[w] ?? w}</li>)}
                        </ul>
                      )}
                    </td>
                    <td><small>{h.events.slice(0, 3).map((e) => `${t.status[e.kind] ?? e.kind} (${new Date(e.at).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' })})`).join(' · ')}</small></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="hint">המערכת מגבילה את קצב השליחה (מרווח אקראי בין הודעות, מכסה לדקה וליום, חימום מספר חדש) כדי להקטין את הסיכון לחסימה. ההגדרות: הגדרות ← הגנה מחסימה. אין הבטחה מוחלטת: שימוש בספרייה לא רשמית עלול להוביל להגבלה גם בהתנהגות זהירה.</p>
      </section>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {list.map((ch) => (
          <li key={ch.id} className="card">
            <div className="row">
              <strong>{ch.label}</strong>
              <span>{ch.type === 'whatsapp' ? 'ווצאפ' : 'טלגרם'}</span>
              <span className={`badge ${ch.status}`}>{t.status[ch.status] ?? ch.status}</span>
            </div>
            {isAdmin && (
              <div className="row" style={{ marginTop: '.5rem' }}>
                <button className="primary" onClick={() => { setLinking(ch.id); void run(() => api('POST', `/channels/${ch.id}/start`)); }}>
                  קישור / הפעלה
                </button>
                {ch.type === 'whatsapp' && (
                  <button onClick={() => { setPairFor(pairFor === ch.id ? null : ch.id); setPhone(''); }} aria-expanded={pairFor === ch.id}>קישור עם מספר טלפון (בלי QR)</button>
                )}
                <button onClick={() => run(() => api('POST', `/channels/${ch.id}/stop`))}>עצירה</button>
                <button className="danger" onClick={() => setPending({ kind: 'logout', ch })}>ניתוק החשבון</button>
                <button className="danger" onClick={() => setPending({ kind: 'delete', ch })}>מחיקת ערוץ</button>
              </div>
            )}
            {pairFor === ch.id && (
              <form className="card" onSubmit={(e) => { e.preventDefault(); setLinking(ch.id); setPairFor(null); void run(() => api('POST', `/channels/${ch.id}/start`, { phone })); }}>
                <p className="hint">מתאים כשיש לכם רק מכשיר אחד (אי אפשר לסרוק QR מאותו מסך). נקבל קוד בן 8 תווים שמקלידים בווצאפ.</p>
                <div className="field">
                  <label htmlFor={`ph-${ch.id}`}>מספר הטלפון של חשבון הווצאפ (עם קידומת מדינה, ספרות בלבד, בלי +)</label>
                  <input id={`ph-${ch.id}`} inputMode="numeric" pattern="\d{8,15}" required dir="ltr" placeholder="972501234567" value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))} />
                </div>
                <button className="primary" type="submit">קבלת קוד קישור</button>
              </form>
            )}
            {linking === ch.id && <LinkPanel channel={ch} onClose={() => setLinking(null)} />}
          </li>
        ))}
        {list.length === 0 && <li>אין עדיין ערוצים.</li>}
      </ul>

      {isAdmin && (
        <form className="card" onSubmit={create}>
          <h2>ערוץ חדש</h2>
          <div className="field">
            <label htmlFor="ch-label">שם הערוץ</label>
            <input id="ch-label" required maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="ch-type">פלטפורמה</label>
            <select id="ch-type" value={type} onChange={(e) => setType(e.target.value as 'whatsapp')}>
              <option value="whatsapp">ווצאפ (סריקת QR)</option>
              <option value="telegram">טלגרם (חשבון משתמש, סריקת QR)</option>
            </select>
            <p className="hint">הערה: החיבור לווצאפ נעשה באמצעות ספרייה לא רשמית וקיים סיכון לחסימת המספר. גם שליחה אוטומטית מחשבון טלגרם עלולה להוביל להגבלת החשבון.</p>
          </div>
          <button className="primary" type="submit">יצירה</button>
        </form>
      )}

      <ConfirmDialog
        open={!!pending}
        danger
        title={pending?.kind === 'delete' ? 'מחיקת ערוץ' : 'ניתוק החשבון'}
        message={
          pending?.kind === 'delete'
            ? `הערוץ "${pending.ch.label}" וכל אנשי הקשר, השיחות וההודעות שלו יימחקו לצמיתות.`
            : `החשבון המקושר ל-"${pending?.ch.label}" ינותק והסשן יימחק. כדי לחבר שוב תידרש סריקת QR.`
        }
        onCancel={() => setPending(null)}
        onConfirm={() => {
          const p = pending!;
          setPending(null);
          void run(() => (p.kind === 'delete' ? api('DELETE', `/channels/${p.ch.id}`) : api('POST', `/channels/${p.ch.id}/logout`)));
        }}
      />
    </>
  );
}

function LinkPanel({ channel, onClose }: { channel: Channel; onClose: () => void }) {
  const [status, setStatus] = useState('connecting');
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [lost, setLost] = useState(false);
  const [pw, setPw] = useState('');
  const [pwErr, setPwErr] = useState('');
  const platform = channel.type === 'whatsapp' ? 'ווצאפ' : 'טלגרם';
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const es = new EventSource(`/channels/${channel.id}/events`);
    es.onmessage = (ev) => {
      const d = JSON.parse(ev.data) as { type: string; status?: string; qr?: string };
      setLost(false);
      if (d.type === 'qr' && d.qr) setQr(d.qr);
      if (d.type === 'pairing_code' && (d as { code?: string }).code) setCode((d as { code?: string }).code!);
      if (d.type === 'status' && d.status) {
        setStatus(d.status);
        if (d.status !== 'qr') { setQr(null); setCode(null); }
        if (d.status !== 'password') setPw('');
      }
    };
    es.onerror = () => setLost(true);
    return () => es.close();
  }, [channel.id]);

  return (
    <section aria-label={`קישור הערוץ ${channel.label}`} style={{ marginTop: '1rem' }}>
      <p role="status" aria-live="polite">
        <span className={`badge ${status}`}>{t.status[status] ?? status}</span>
        {lost && <span className="error"> החיבור לשרת אבד, מנסה שוב…</span>}
      </p>
      {code && (
        <div role="status" aria-live="polite">
          <p>הקלידו בווצאפ את הקוד:</p>
          <p dir="ltr" style={{ fontSize: '2rem', fontWeight: 700, letterSpacing: '.15em', fontFamily: 'monospace' }}>{code}</p>
          <ol>
            <li>בטלפון: ווצאפ ← הגדרות ← מכשירים מקושרים ← קישור מכשיר.</li>
            <li>בחרו "קישור באמצעות מספר טלפון במקום זאת" והקלידו את הקוד.</li>
            <li>הקוד פג תוך כדקה; אם פג, ייווצר קוד חדש אוטומטית.</li>
          </ol>
        </div>
      )}
      {qr && (
        <>
          <img className="qr" src={qr} alt={`קוד QR לקישור ${platform}`} width={320} height={320} />
          {channel.type === 'whatsapp' ? (
            <ol>
              <li>פתחו את ווצאפ בטלפון.</li>
              <li>הגדרות ← מכשירים מקושרים ← קישור מכשיר.</li>
              <li>סרקו את הקוד. הקוד מתחדש אוטומטית.</li>
            </ol>
          ) : (
            <ol>
              <li>פתחו את טלגרם בטלפון.</li>
              <li>הגדרות ← מכשירים ← קישור מכשיר שולחן עבודה.</li>
              <li>סרקו את הקוד. הקוד מתחדש אוטומטית.</li>
            </ol>
          )}
        </>
      )}
      {status === 'password' && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setPwErr('');
            try { await api('POST', `/channels/${channel.id}/password`, { password: pw }); setPw(''); }
            catch (er) { setPwErr(errText(er instanceof ApiError ? er.code : 'generic')); }
          }}
        >
          <div className="field">
            <label htmlFor={`tgpw-${channel.id}`}>סיסמת האימות הדו-שלבי של טלגרם</label>
            <input id={`tgpw-${channel.id}`} type="password" autoComplete="off" required value={pw} onChange={(e) => setPw(e.target.value)} dir="ltr" aria-describedby={`tgpw-h-${channel.id}`} />
            <p id={`tgpw-h-${channel.id}`} className="hint">הסיסמה משמשת רק להשלמת ההתחברות ואינה נשמרת בשרת.</p>
          </div>
          <button className="primary" type="submit">שליחה</button>
          <p role="alert" className="error">{pwErr}</p>
        </form>
      )}
      {status === 'connected' && <p className="ok">החשבון מחובר.</p>}
      {(status === 'stopped' || status === 'logged_out') && <p>לא התקבלה סריקה. לחצו "קישור / הפעלה" לניסיון נוסף.</p>}
      <button onClick={onClose}>סגירה</button>
    </section>
  );
}

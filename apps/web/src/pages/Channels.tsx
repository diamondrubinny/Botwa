import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, can, type Channel, type ChannelHealth, type Me } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { usePoll } from '../hooks';
import { errText, t } from '../strings';

const RISK = { low: 'נמוך', medium: 'בינוני', high: 'גבוה' } as const;
const RISK_WHY: Record<string, string> = {
  restricted: 'החשבון הוגבל/נחסם', auto_paused_recently: 'עצירה אוטומטית ב-24 שעות האחרונות', cap_near: 'קרוב למכסה היומית', cap_half: 'מעל חצי מהמכסה היומית',
  outbound_heavy: 'הרבה יותר הודעות יוצאות מנכנסות', new_number_busy: 'מספר חדש עם נפח שליחה גבוה',
};
const WARN: Record<string, string> = {
  restricted: 'החשבון הוגבל או נחסם (חשד). עצרו שליחה אוטומטית ובדקו את הטלפון/האפליקציה. אל תקשרו מחדש שוב ושוב.',
  logged_out: 'החשבון מנותק. נדרש קישור מחדש.',
  daily_cap_reached: 'הגעתם למכסה היומית. ההודעות לא יישלחו עד שהמכסה תתפנה.',
  daily_cap_near: 'מתקרבים למכסה היומית.',
  warming_up: 'מכסה מוגדלת בהדרגה ככל שהמספר "מתבגר".',
};

type Pending = { kind: 'logout' | 'delete'; ch: Channel } | null;

export function Channels({ me }: { me: Me }) {
  const isAdmin = can(me, 'channels.manage');
  const [list, setList] = useState<Channel[]>([]);
  const [label, setLabel] = useState('');
  const [type, setType] = useState<'whatsapp' | 'whatsapp_cloud' | 'telegram' | 'webchat'>('whatsapp');
  const [msg, setMsg] = useState('');
  const [linking, setLinking] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [health, setHealth] = useState<ChannelHealth[]>([]);
  usePoll(async () => setHealth(await api<ChannelHealth[]>('GET', '/channels/health').catch(() => [])), 15000);
  const [pairFor, setPairFor] = useState<string | null>(null);
  const [cloudFor, setCloudFor] = useState<string | null>(null);
  const [webFor, setWebFor] = useState<string | null>(null);
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
              <thead><tr><th scope="col">ערוץ</th><th scope="col">מצב</th><th scope="col">נשלחו ב-24 שעות</th><th scope="col">סיכון חסימה</th><th scope="col">אזהרות</th><th scope="col">אירועים אחרונים</th></tr></thead>
              <tbody>
                {health.map((h) => (
                  <tr key={h.id}>
                    <th scope="row">{h.label}</th>
                    <td><span className={`badge ${h.status}`}>{t.status[h.status] ?? h.status}</span></td>
                    <td>{h.sentLast24h} / {h.dailyCap}{h.warnings.includes('warming_up') ? ' (חימום מספר חדש)' : ''}</td>
                    <td>
                      <strong className={h.risk.level === 'low' ? 'ok' : 'error'}>{RISK[h.risk.level]}</strong>
                      {h.risk.reasons.length > 0 && <ul style={{ margin: 0, paddingInlineStart: '1rem' }}>{h.risk.reasons.map((r) => <li key={r}><small>{RISK_WHY[r] ?? r}</small></li>)}</ul>}
                      <div style={{ marginTop: '.4rem' }}>
                        {h.paused
                          ? <button onClick={() => run(() => api('POST', `/channels/${h.id}/resume`))}>חידוש שליחה<span className="sr-only"> {h.label}</span></button>
                          : <button className="danger" onClick={() => run(() => api('POST', `/channels/${h.id}/pause`))}>עצירת חירום של שליחה<span className="sr-only"> {h.label}</span></button>}
                      </div>
                      {h.paused && <p className="error" role="status">השליחה מושהית ידנית.</p>}
                      {h.autoPausedUntil && <p className="error" role="status">הושהה אוטומטית עד {new Date(h.autoPausedUntil).toLocaleTimeString('he-IL')} עקב כשלי שליחה.</p>}
                    </td>
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
              <span>{ch.type === 'whatsapp' ? 'ווצאפ' : ch.type === 'whatsapp_cloud' ? 'ווצאפ רשמי (Cloud API)' : ch.type === 'webchat' ? 'צ׳אט באתר' : 'טלגרם'}</span>
              <span className={`badge ${ch.status}`}>{t.status[ch.status] ?? ch.status}</span>
            </div>
            {isAdmin && (
              <div className="row" style={{ marginTop: '.5rem' }}>
                {ch.type === 'webchat' ? (
                  <>
                    <button className="primary" onClick={() => setWebFor(webFor === ch.id ? null : ch.id)} aria-expanded={webFor === ch.id}>הגדרת הוויגיט וקוד ההטמעה</button>
                    <button onClick={() => run(() => api('POST', `/channels/${ch.id}/start`))}>הפעלה</button>
                  </>
                ) : ch.type === 'whatsapp_cloud' ? (
                  <>
                    <button className="primary" onClick={() => setCloudFor(cloudFor === ch.id ? null : ch.id)} aria-expanded={cloudFor === ch.id}>הגדרת הערוץ הרשמי</button>
                    <button onClick={() => run(() => api('POST', `/channels/${ch.id}/start`))}>הפעלה</button>
                  </>
                ) : (
                  <button className="primary" onClick={() => { setLinking(ch.id); void run(() => api('POST', `/channels/${ch.id}/start`)); }}>
                    קישור / הפעלה
                  </button>
                )}
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
            {webFor === ch.id && <WebChatPanel channel={ch} onSaved={() => void reload()} />}
            {cloudFor === ch.id && <CloudPanel channel={ch} onSaved={() => { setCloudFor(null); void reload(); }} />}
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
              <option value="whatsapp_cloud">ווצאפ רשמי (WhatsApp Business Cloud API)</option>
              <option value="webchat">צ׳אט באתר (ויגיט להטמעה באתרים)</option>
              <option value="telegram">טלגרם (חשבון משתמש, סריקת QR)</option>
            </select>
            {type === 'webchat' && <p className="hint">ויגיט צ׳אט שמטמיעים באתר שלכם בשורת קוד אחת. הפניות נכנסות לתיבה כמו כל ערוץ, והבוט, תרשים הזרימה ומאגר הידע עובדים גם בו. אין סיכון חסימה, ואין תלות בפלטפורמה חיצונית.</p>}
            {type === 'whatsapp_cloud' && <p className="hint">הדרך המותרת והיציבה: מספר עסקי מאומת אצל Meta, בלי סיכון חסימה בגלל ספרייה לא רשמית. דורשת חשבון Meta Business ועלולה לעלות כסף לפי שיחה. ניתן לשלוח טקסט חופשי רק עד 24 שעות מהודעת הלקוח האחרונה.</p>}
            <p className="hint">הערה: החיבור לווצאפ בסריקת QR נעשה באמצעות ספרייה לא רשמית וקיים סיכון לחסימת המספר. גם שליחה אוטומטית מחשבון טלגרם עלולה להוביל להגבלת החשבון.</p>
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
            <li>הקלידו את הקוד מיד: הוא תקף זמן קצר. אם ווצאפ דוחה אותו, לחצו "קישור" שוב לקבלת קוד חדש.</li>
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


/** Credentials for the official WhatsApp channel, plus the webhook details to paste into Meta's app dashboard. */
function CloudPanel({ channel, onSaved }: { channel: Channel; onSaved: () => void }) {
  const [info, setInfo] = useState<{ configured: boolean; phoneNumberId?: string; verifyToken?: string; webhookUrl: string } | null>(null);
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api<typeof info>('GET', `/channels/${channel.id}/cloud`).then((d) => { setInfo(d); if (d?.phoneNumberId) setPhoneNumberId(d.phoneNumberId); }).catch(() => undefined); }, [channel.id]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg('');
    try {
      const r = await api<{ status: string }>('PUT', `/channels/${channel.id}/cloud`, { phoneNumberId, accessToken, appSecret });
      setAccessToken(''); setAppSecret('');
      setMsg(r.status === 'connected' ? 'החיבור הצליח.' : 'הפרטים נשמרו אך החיבור ל-Meta נכשל. בדקו את מזהה המספר ואת האסימון.');
      onSaved();
    } catch (er) { setMsg(errText(er instanceof ApiError ? er.code : 'generic')); }
    setBusy(false);
  }
  const copy = (v: string) => void navigator.clipboard?.writeText(v).catch(() => undefined);

  return (
    <div className="card">
      <h3>הגדרת ווצאפ רשמי</h3>
      <ol>
        <li>ב-Meta for Developers: צרו אפליקציה מסוג Business והוסיפו את המוצר WhatsApp.</li>
        <li>העתיקו את <strong>Phone number ID</strong>, צרו אסימון גישה קבוע (System User) ואת <strong>App secret</strong> (הגדרות האפליקציה ← Basic).</li>
        <li>הדביקו אותם בטופס. הערכים נשמרים מוצפנים ולא יוצגו שוב.</li>
        <li>ב-WhatsApp ← Configuration ← Webhook: הדביקו את הכתובת ואת ה-Verify token שלמטה, ואז הרשמו (Subscribe) לשדה <span dir="ltr">messages</span>.</li>
      </ol>
      <p className="hint">שמות השדות והשלבים אצל Meta משתנים מעת לעת. יש לאמת מול התיעוד הרשמי.</p>
      {info && (
        <dl>
          <dt>כתובת Webhook (Callback URL)</dt>
          <dd dir="ltr"><code>{info.webhookUrl}</code> <button type="button" onClick={() => copy(info.webhookUrl)}>העתקה</button></dd>
          {info.verifyToken && (<><dt>Verify token</dt><dd dir="ltr"><code>{info.verifyToken}</code> <button type="button" onClick={() => copy(info.verifyToken!)}>העתקה</button></dd></>)}
        </dl>
      )}
      <form onSubmit={save}>
        <div className="field"><label htmlFor={`pn-${channel.id}`}>Phone number ID</label><input id={`pn-${channel.id}`} required inputMode="numeric" dir="ltr" pattern="\d{5,32}" value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value.replace(/\D/g, ''))} /></div>
        <div className="field"><label htmlFor={`tk-${channel.id}`}>אסימון גישה (Access token)</label><input id={`tk-${channel.id}`} required type="password" autoComplete="off" dir="ltr" minLength={20} value={accessToken} onChange={(e) => setAccessToken(e.target.value.trim())} /></div>
        <div className="field"><label htmlFor={`as-${channel.id}`}>App secret</label><input id={`as-${channel.id}`} required type="password" autoComplete="off" dir="ltr" minLength={16} value={appSecret} onChange={(e) => setAppSecret(e.target.value.trim())} /></div>
        <button className="primary" type="submit" disabled={busy}>{info?.configured ? 'עדכון ופתיחת חיבור' : 'שמירה וחיבור'}</button>
        <p role="status" className={msg.startsWith('החיבור הצליח') ? 'ok' : 'error'}>{msg}</p>
      </form>
    </div>
  );
}


type Level = 'off' | 'optional' | 'required';
interface WebCfg {
  design: { title: string; subtitle: string; welcome: string; color: string; position: 'left' | 'right'; launcherLabel: string; launcherIcon: 'chat' | 'help' | 'message'; language: 'he' | 'en' };
  behavior: { askName: Level; askEmail: Level; askPhone: Level; popupText: string; popupDelaySec: number; autoOpenSec: number; showAgentName: boolean; consentText: string; consentLink: string; offlineMessage: string; maxLength: number };
  allowedOrigins: string[]; allowAnyOrigin: boolean; publicKey: string; embedCode: string; previewUrl: string; status: string;
}
const LEVELS: [Level, string][] = [['off', 'לא לבקש'], ['optional', 'לא חובה'], ['required', 'חובה']];

/** Settings of a website-chat channel: look, behaviour, which sites may embed it, the embed code and the identity secret. */
function WebChatPanel({ channel, onSaved }: { channel: Channel; onSaved: () => void }) {
  const [c, setC] = useState<WebCfg | null>(null);
  const [origins, setOrigins] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [secret, setSecret] = useState('');
  const [preview, setPreview] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api<WebCfg>('GET', `/channels/${channel.id}/webchat`).then((d) => { setC(d); setOrigins(d.allowedOrigins.join('\n')); }).catch(() => undefined); }, [channel.id]);
  if (!c) return <p role="status">טוען…</p>;
  const d = (p: Partial<WebCfg['design']>) => setC({ ...c, design: { ...c.design, ...p } });
  const b = (p: Partial<WebCfg['behavior']>) => setC({ ...c, behavior: { ...c.behavior, ...p } });
  const id = (k: string) => `wc-${k}-${channel.id}`;
  const copy = (v: string) => void navigator.clipboard?.writeText(v).then(() => setMsg({ ok: true, text: 'הועתק.' })).catch(() => undefined);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const r = await api<WebCfg>('PUT', `/channels/${channel.id}/webchat`, { design: c!.design, behavior: c!.behavior, allowedOrigins: origins.split('\n').map((x) => x.trim()).filter(Boolean), allowAnyOrigin: c!.allowAnyOrigin });
      setC(r); setOrigins(r.allowedOrigins.join('\n')); setPreview((n) => n + 1); onSaved();
      setMsg({ ok: true, text: 'נשמר, והערוץ פעיל.' });
    } catch (er) { setMsg({ ok: false, text: er instanceof ApiError && er.code === 'bad_color' ? 'הצבע שנבחר לא מאפשר טקסט קריא (לבן או כהה). בחרו צבע כהה או בהיר יותר.' : er instanceof ApiError && er.code === 'bad_origin' ? 'כתובת אתר לא תקינה. נדרש https://example.com (או https://*.example.com), בלי נתיב.' : errText(er instanceof ApiError ? er.code : 'generic') }); }
    setBusy(false);
  }
  async function rotate() {
    if (!confirm('ליצור סוד חדש? הסוד הקודם יפסיק לעבוד מיד, ויש לעדכן אותו בשרת האתר.')) return;
    const r = await api<{ secret: string }>('POST', `/channels/${channel.id}/webchat/identity-secret`).catch(() => null);
    if (r) setSecret(r.secret);
  }
  const LevelSel = ({ k, label }: { k: 'askName' | 'askEmail' | 'askPhone'; label: string }) => (
    <div className="field"><label htmlFor={id(k)}>{label}</label>
      <select id={id(k)} value={c.behavior[k]} onChange={(e) => b({ [k]: e.target.value as Level })}>{LEVELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
  );

  return (
    <div className="card">
      <h3>ויגיט הצ׳אט לאתר</h3>
      <section aria-labelledby={id('emb')}>
        <h4 id={id('emb')}>1. קוד ההטמעה</h4>
        <p className="hint">הדביקו בכל עמוד שבו הצ׳אט צריך להופיע, לפני התג <span dir="ltr">&lt;/body&gt;</span>. העמוד מציג רק כפתור, והצ׳אט עצמו רץ במסגרת מבודדת מהשרת הזה.</p>
        <label htmlFor={id('code')} className="sr-only">קוד ההטמעה</label>
        <textarea id={id('code')} dir="ltr" readOnly rows={3} value={c.embedCode} onFocus={(e) => e.currentTarget.select()} />
        <div className="row"><button type="button" onClick={() => copy(c.embedCode)}>העתקת הקוד</button></div>
        {c.allowedOrigins.length === 0 && !c.allowAnyOrigin && <p className="error" role="status">עדיין לא הוגדר אתר מורשה: הוויגיט לא יוצג באף אתר עד שתוסיפו כתובת בסעיף 3.</p>}
      </section>

      <form onSubmit={save}>
        <h4>2. מראה</h4>
        <div className="field"><label htmlFor={id('title')}>כותרת</label><input id={id('title')} required maxLength={40} value={c.design.title} onChange={(e) => d({ title: e.target.value })} /></div>
        <div className="field"><label htmlFor={id('sub')}>כותרת משנה</label><input id={id('sub')} maxLength={80} value={c.design.subtitle} onChange={(e) => d({ subtitle: e.target.value })} /></div>
        <div className="field"><label htmlFor={id('wel')}>הודעת פתיחה</label><textarea id={id('wel')} rows={2} maxLength={300} value={c.design.welcome} onChange={(e) => d({ welcome: e.target.value })} /></div>
        <div className="row">
          <div className="field"><label htmlFor={id('col')}>צבע המותג</label><input id={id('col')} type="color" value={c.design.color} onChange={(e) => d({ color: e.target.value })} style={{ width: 70, padding: 2 }} /></div>
          <div className="field"><label htmlFor={id('pos')}>מיקום הכפתור</label><select id={id('pos')} value={c.design.position} onChange={(e) => d({ position: e.target.value as 'left' })}><option value="left">שמאל</option><option value="right">ימין</option></select></div>
          <div className="field"><label htmlFor={id('ico')}>אייקון</label><select id={id('ico')} value={c.design.launcherIcon} onChange={(e) => d({ launcherIcon: e.target.value as 'chat' })}><option value="chat">בועת שיחה</option><option value="help">עזרה</option><option value="message">הודעה</option></select></div>
          <div className="field"><label htmlFor={id('lang')}>שפת הממשק</label><select id={id('lang')} value={c.design.language} onChange={(e) => d({ language: e.target.value as 'he' })}><option value="he">עברית</option><option value="en">English</option></select></div>
        </div>
        <div className="field"><label htmlFor={id('ll')}>טקסט על הכפתור (אופציונלי, במחשב בלבד)</label><input id={id('ll')} maxLength={20} value={c.design.launcherLabel} onChange={(e) => d({ launcherLabel: e.target.value })} /></div>

        <h4>התנהגות</h4>
        <LevelSel k="askName" label="לבקש שם בתחילת השיחה" />
        <LevelSel k="askEmail" label="לבקש אימייל" />
        <LevelSel k="askPhone" label="לבקש טלפון" />
        <div className="field"><label htmlFor={id('pop')}>בועת הזמנה ליד הכפתור (אופציונלי)</label><input id={id('pop')} maxLength={100} value={c.behavior.popupText} onChange={(e) => b({ popupText: e.target.value })} placeholder="צריכים עזרה? אנחנו כאן" /></div>
        <div className="row">
          <div className="field"><label htmlFor={id('pd')}>השהיה עד הבועה (שניות)</label><input id={id('pd')} type="number" min={0} max={120} value={c.behavior.popupDelaySec} onChange={(e) => b({ popupDelaySec: Number(e.target.value) })} /></div>
          <div className="field"><label htmlFor={id('ao')}>פתיחה אוטומטית אחרי (שניות, 0 = לא)</label><input id={id('ao')} type="number" min={0} max={300} value={c.behavior.autoOpenSec} onChange={(e) => b({ autoOpenSec: Number(e.target.value) })} /></div>
        </div>
        <div className="field"><label><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={c.behavior.showAgentName} onChange={(e) => b({ showAgentName: e.target.checked })} /> להציג לגולש את השם הפרטי של הנציג שעונה</label></div>
        <div className="field"><label htmlFor={id('off')}>הודעה מחוץ לשעות הפעילות</label><textarea id={id('off')} rows={2} maxLength={300} value={c.behavior.offlineMessage} onChange={(e) => b({ offlineMessage: e.target.value })} /></div>
        <div className="field"><label htmlFor={id('cons')}>הצהרת הסכמה לפני תחילת שיחה (אופציונלי)</label><input id={id('cons')} maxLength={300} value={c.behavior.consentText} onChange={(e) => b({ consentText: e.target.value })} placeholder="קראתי ואני מסכים/ה למדיניות הפרטיות" /><p className="hint">אם מוגדרת, הגולש חייב לסמן אותה, והאישור נרשם בשיחה. מומלץ לכלול קישור למדיניות. ניסוח ההצהרה דורש בדיקה משפטית.</p></div>
        <div className="field"><label htmlFor={id('cl')}>קישור למדיניות הפרטיות (https)</label><input id={id('cl')} dir="ltr" maxLength={300} value={c.behavior.consentLink} onChange={(e) => b({ consentLink: e.target.value })} placeholder="https://example.com/privacy" /></div>

        <h4>3. אתרים מורשים</h4>
        <div className="field">
          <label htmlFor={id('org')}>כתובות האתרים שמותר להם להציג את הצ׳אט (שורה לכל אתר)</label>
          <textarea id={id('org')} dir="ltr" rows={3} value={origins} onChange={(e) => setOrigins(e.target.value)} placeholder={'https://www.example.com\nhttps://*.example.co.il'} />
          <p className="hint">הדפדפן עצמו חוסם הטמעה באתרים שאינם ברשימה, כך שאי אפשר "לגנוב" את הקוד לאתר אחר. כתובת עם תת-דומיינים: <span dir="ltr">https://*.example.com</span>.</p>
        </div>
        <div className="field"><label><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={c.allowAnyOrigin} onChange={(e) => setC({ ...c, allowAnyOrigin: e.target.checked })} /> לאפשר הטמעה בכל אתר (לא מומלץ)</label></div>
        <button className="primary" type="submit" disabled={busy}>{busy ? 'שומר…' : 'שמירה והפעלה'}</button>
        <p role="status" className={msg?.ok ? 'ok' : 'error'}>{msg?.text}</p>
      </form>

      <section aria-labelledby={id('prev')}>
        <h4 id={id('prev')}>תצוגה מקדימה</h4>
        <iframe key={preview} title="תצוגה מקדימה של הצ׳אט" src={c.previewUrl} style={{ width: 'min(100%, 380px)', height: 520, border: '1px solid var(--border)', borderRadius: 12 }} />
        <p className="hint">התצוגה פועלת על ערוץ אמיתי: הודעה שתשלחו תיכנס לתיבה.</p>
      </section>

      <section aria-labelledby={id('idn')}>
        <h4 id={id('idn')}>זיהוי לקוח מחובר (מתקדם)</h4>
        <p className="hint">אם באתר יש לקוחות מחוברים, אפשר לקשור את הצ׳אט ללקוח. שרת האתר שלכם מחשב חתימה ומעביר אותה לוויגיט, ואז אותו לקוח יראה את אותה שיחה מכל מכשיר. אל תחשבו את החתימה בדפדפן.</p>
        <div className="row"><button type="button" onClick={rotate}>יצירת סוד חדש</button></div>
        {secret && (
          <div role="status">
            <p className="error">שמרו את הסוד עכשיו, הוא לא יוצג שוב:</p>
            <code dir="ltr" style={{ wordBreak: 'break-all' }}>{secret}</code> <button type="button" onClick={() => copy(secret)}>העתקה</button>
          </div>
        )}
        <details>
          <summary>דוגמת קוד</summary>
          <pre dir="ltr" style={{ whiteSpace: 'pre-wrap' }}>{`// SERVER (Node): signature = HMAC-SHA256(secret, customerId)
const signature = crypto.createHmac('sha256', SECRET).update(String(customer.id)).digest('hex');
// PHP:  hash_hmac('sha256', $customerId, $secret)

// PAGE (before widget.js, or later with BotwaChat.identify):
window.botwaChatIdentity = { id: '<customer id>', signature: '<signature>', name: '<optional>', email: '<optional>' };

// Control from your page:
BotwaChat.open(); BotwaChat.close(); BotwaChat.destroy();
BotwaChat.on('newMessage', function (e) { /* e.unread */ });`}</pre>
        </details>
      </section>
    </div>
  );
}

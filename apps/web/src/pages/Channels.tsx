import { Loading } from '../components/Loading';
import { EmptyState, PageTitle } from '../components/Illustration';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, can, CHANNEL_NAMES, type Channel, type ChannelKind, type ChannelHealth, type Me } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { UsageMeter } from '../components/UsageMeter';
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
  daily_cap_near: 'מתקרבים למכסה היומית.', monthly_limit_near: 'מתקרבים למגבלת ההודעות החודשית של המספר הרשמי.', monthly_limit_reached: 'המספר הרשמי הגיע למגבלת ההודעות החודשית.',
  warming_up: 'מכסה מוגדלת בהדרגה ככל שהמספר "מתבגר".',
};

type Pending = { kind: 'logout' | 'delete'; ch: Channel } | null;

export function Channels({ me }: { me: Me }) {
  const isAdmin = can(me, 'channels.manage');
  const [list, setList] = useState<Channel[]>([]);
  const [label, setLabel] = useState('');
  const [type, setType] = useState<ChannelKind>('whatsapp');
  const [metaFor, setMetaFor] = useState<string | null>(null);
  const [mailFor, setMailFor] = useState<string | null>(null);
  const [photoFor, setPhotoFor] = useState<string | null>(null);
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
      <PageTitle art="channels" title="ערוצים" />
      <p role="alert" className="error">{msg}</p>
      <section className="card" aria-labelledby="health-h">
        <h2 id="health-h">בריאות ערוצים והגנה מחסימה</h2>
        {health.length === 0 ? <p>אין ערוצים.</p> : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <caption className="sr-only">מצב ערוצים, כמות הודעות שנשלחו מול המכסה, ואזהרות</caption>
              <thead><tr><th scope="col">ערוץ</th><th scope="col">מצב</th><th scope="col">נשלחו (ב-24 שעות; ברשמי: החודש)</th><th scope="col">סיכון חסימה / מגבלה</th><th scope="col">אזהרות</th><th scope="col">אירועים אחרונים</th></tr></thead>
              <tbody>
                {health.map((h) => (
                  <tr key={h.id}>
                    <th scope="row">{h.label}</th>
                    <td><span className={`badge ${h.status}`}>{t.status[h.status] ?? h.status}</span></td>
                    <td>{h.monthly
                      ? <>החודש: {h.monthly.total.toLocaleString('he-IL')}{h.monthly.limit > 0 ? ` מתוך ${h.monthly.limit.toLocaleString('he-IL')}` : ' (בלי מגבלה)'}<br /><small>מתאפס ב-{new Date(h.monthly.resetsAt).toLocaleDateString('he-IL')}</small></>
                      : <>{h.sentLast24h} / {h.dailyCap}{h.warnings.includes('warming_up') ? ' (חימום מספר חדש)' : ''}</>}</td>
                    <td>
                      {h.monthly ? (
                        <>
                          <strong className={h.monthly.limit > 0 && h.monthly.total >= h.monthly.limit ? 'error' : 'ok'}>{h.monthly.limit === 0 ? 'ספירה בלבד' : h.monthly.total >= h.monthly.limit ? 'הגיע למגבלה החודשית' : `${h.monthly.percent}% מהמגבלה החודשית`}</strong>
                          <div><small>ערוץ רשמי: אין סיכון חסימה כמו בחיבור QR.</small></div>
                        </>
                      ) : (
                        <>
                          <strong className={h.risk.level === 'low' ? 'ok' : 'error'}>{RISK[h.risk.level]}</strong>
                          {h.risk.reasons.length > 0 && <ul style={{ margin: 0, paddingInlineStart: '1rem' }}>{h.risk.reasons.map((r) => <li key={r}><small>{RISK_WHY[r] ?? r}</small></li>)}</ul>}
                        </>
                      )}
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
              <span>{CHANNEL_NAMES[ch.type] ?? ch.type}</span>
              <span className={`badge ${ch.status}`}>{t.status[ch.status] ?? ch.status}</span>
            </div>
            {isAdmin && (
              <div className="row" style={{ marginTop: '.5rem' }}>
                {ch.type === 'webchat' ? (
                  <>
                    <button className="primary" onClick={() => setWebFor(webFor === ch.id ? null : ch.id)} aria-expanded={webFor === ch.id}>הגדרת הוויגיט וקוד ההטמעה</button>
                    <button onClick={() => run(() => api('POST', `/channels/${ch.id}/start`))}>הפעלה</button>
                  </>
                ) : ch.type === 'email' ? (
                  <>
                    <button className="primary" onClick={() => setMailFor(mailFor === ch.id ? null : ch.id)} aria-expanded={mailFor === ch.id}>הגדרת תיבת הדואר</button>
                    <button onClick={() => run(() => api('POST', `/channels/${ch.id}/start`))}>הפעלה</button>
                  </>
                ) : ch.type === 'messenger' || ch.type === 'instagram' ? (
                  <>
                    <button className="primary" onClick={() => setMetaFor(metaFor === ch.id ? null : ch.id)} aria-expanded={metaFor === ch.id}>הגדרת {ch.type === 'instagram' ? 'Instagram' : 'Messenger'}</button>
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
                {(ch.type === 'whatsapp' || ch.type === 'whatsapp_cloud') && (
                  <button onClick={() => setPhotoFor(photoFor === ch.id ? null : ch.id)} aria-expanded={photoFor === ch.id}>תמונת פרופיל</button>
                )}
                <button onClick={() => run(() => api('POST', `/channels/${ch.id}/stop`))}>עצירה</button>
                <button className="danger" onClick={() => setPending({ kind: 'logout', ch })}>ניתוק החשבון</button>
                <button className="danger" onClick={() => setPending({ kind: 'delete', ch })}>מחיקת ערוץ</button>
              </div>
            )}
            {ch.type === 'whatsapp_cloud' && <UsageMeter channelId={ch.id} canEdit={isAdmin} />}
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
            {photoFor === ch.id && <ProfilePhotoPanel channel={ch} />}
            {mailFor === ch.id && <EmailPanel channel={ch} onSaved={() => void reload()} />}
            {metaFor === ch.id && <MetaPanel channel={ch} onSaved={() => void reload()} />}
            {cloudFor === ch.id && <CloudPanel channel={ch} onSaved={() => { setCloudFor(null); void reload(); }} />}
            {linking === ch.id && <LinkPanel channel={ch} onClose={() => setLinking(null)} />}
          </li>
        ))}
        {list.length === 0 && <li><EmptyState art="channels" title="אין עדיין ערוצים">חברו ווצאפ, טלגרם או צ׳אט לאתר בטופס "ערוץ חדש".</EmptyState></li>}
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
            <select id="ch-type" value={type} onChange={(e) => setType(e.target.value as ChannelKind)}>
              <option value="whatsapp">ווצאפ (סריקת QR)</option>
              <option value="whatsapp_cloud">ווצאפ רשמי (WhatsApp Business Cloud API)</option>
              <option value="messenger">Messenger (דף פייסבוק, API רשמי של Meta)</option>
              <option value="instagram">Instagram (הודעות לחשבון עסקי, API רשמי של Meta)</option>
              <option value="webchat">צ׳אט באתר (ויגיט להטמעה באתרים)</option>
              <option value="email">אימייל (תיבת דואר של השירות, IMAP/SMTP)</option>
              <option value="telegram">טלגרם (חשבון משתמש, סריקת QR)</option>
            </select>
            {type === 'webchat' && <p className="hint">ויגיט צ׳אט שמטמיעים באתר שלכם בשורת קוד אחת. הפניות נכנסות לתיבה כמו כל ערוץ, והבוט, תרשים הזרימה ומאגר הידע עובדים גם בו. אין סיכון חסימה, ואין תלות בפלטפורמה חיצונית.</p>}
            {(type === 'messenger' || type === 'instagram') && <p className="hint">הודעות פרטיות לדף הפייסבוק או לחשבון האינסטגרם העסקי, דרך אותה אפליקציית Meta של הווצאפ הרשמי. ללקוחות אמיתיים נדרש אישור של Meta להרשאות ההודעות (App Review). תשובה חופשית אפשרית עד 24 שעות מהודעת הלקוח האחרונה.</p>}
            {type === 'email' && <p className="hint">תיבת דואר כמו support@ נכנסת לתיבת השיחות: כל שולח הוא שיחה, והתשובות יוצאות מאותה כתובת באותו שרשור. רק דואר שמגיע אחרי החיבור נקלט, ותשובות אוטומטיות (מענה חופשה, החזרות, רשימות תפוצה) לא נענות.</p>}
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
  const [info, setInfo] = useState<{ configured: boolean; phoneNumberId?: string; verifyToken?: string; wabaId?: string; webhookUrl: string; lastWebhookAt?: string | null; lastAttempt?: { at: string; outcome: string } | null } | null>(null);
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api<typeof info>('GET', `/channels/${channel.id}/cloud`).then((d) => { setInfo(d); if (d?.phoneNumberId) setPhoneNumberId(d.phoneNumberId); if (d?.wabaId) setWabaId(d.wabaId); }).catch(() => undefined); }, [channel.id]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg('');
    try {
      const r = await api<{ status: string; error?: string; subscribe?: string | null }>('PUT', `/channels/${channel.id}/cloud`, { phoneNumberId, accessToken, appSecret, ...(wabaId.trim() ? { wabaId: wabaId.trim() } : {}) });
      setAccessToken(''); setAppSecret('');
      const sub = r.subscribe === 'ok' ? ' החשבון חובר לאפליקציה לקבלת הודעות.' : r.subscribe ? ` שימו לב: ${errText(r.subscribe)}` : '';
      setMsg(r.status === 'connected' ? `החיבור הצליח.${sub}` : `הפרטים נשמרו, אבל החיבור ל-Meta נכשל: ${errText(r.error ?? 'meta_check_failed')}`);
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
        <div className="field"><label htmlFor={`tk-${channel.id}`}>אסימון גישה (Access token)</label><input id={`tk-${channel.id}`} required type="password" autoComplete="new-password" data-lpignore="true" data-1p-ignore="true" data-form-type="other" spellCheck={false} dir="ltr" minLength={20} value={accessToken} onChange={(e) => setAccessToken(e.target.value.trim())} /></div>
        <div className="field"><label htmlFor={`as-${channel.id}`}>App secret</label><input id={`as-${channel.id}`} required type="password" autoComplete="new-password" data-lpignore="true" data-1p-ignore="true" data-form-type="other" spellCheck={false} dir="ltr" minLength={16} value={appSecret} onChange={(e) => setAppSecret(e.target.value.trim())} /></div>
        <div className="field"><label htmlFor={`wb-${channel.id}`}>WhatsApp Business Account ID (אופציונלי: לתבניות הודעה)</label><input id={`wb-${channel.id}`} inputMode="numeric" dir="ltr" pattern="\d{5,32}" value={wabaId} onChange={(e) => setWabaId(e.target.value)} aria-describedby={`wbh-${channel.id}`} />
          <p id={`wbh-${channel.id}`} className="hint">נדרש כדי לראות תבניות הודעה ולהגיש חדשות. נמצא ב-WhatsApp ← API Setup אצל Meta (שונה מ-Phone number ID). יש לאמת מול התיעוד הרשמי.</p></div>
        <button className="primary" type="submit" disabled={busy}>{info?.configured ? 'עדכון ופתיחת חיבור' : 'שמירה וחיבור'}</button>
        <p role="status" className={msg.startsWith('החיבור הצליח') ? 'ok' : 'error'}>{msg}</p>
      </form>
      {info?.configured && <WebhookCheck channelId={channel.id} connected={channel.status === 'connected'} lastWebhookAt={info.lastWebhookAt ?? null} lastAttempt={info.lastAttempt} />}
      {info?.configured && <TemplatesPanel channelId={channel.id} hasWaba={!!info.wabaId} />}
    </div>
  );
}

/** The WhatsApp profile picture customers see. Checked here for a quick answer; the server checks again (type, size, malware). */
function ProfilePhotoPanel({ channel }: { channel: Channel }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const connected = channel.status === 'connected';
  function pick(f: File | undefined) {
    setMsg(null); setFile(null); setPreview(null);
    if (!f) return;
    if (!/^image\/(png|jpeg)$/.test(f.type)) return setMsg({ ok: false, text: errText('unsupported_image') });
    if (f.size > 5 * 1024 * 1024) return setMsg({ ok: false, text: errText('file_too_large') });
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result);
      const img = new Image();
      img.onload = () => {
        if (img.naturalWidth < 192 || img.naturalHeight < 192) return setMsg({ ok: false, text: errText('profile_photo_too_small') });
        setFile(f); setPreview(url);
      };
      img.onerror = () => setMsg({ ok: false, text: errText('unsupported_image') });
      img.src = url;
    };
    r.readAsDataURL(f);
  }
  async function upload() {
    if (!file) return;
    setBusy(true); setMsg(null);
    try {
      const fd = new FormData(); fd.append('file', file);
      const res = await fetch(`/channels/${channel.id}/profile-photo`, { method: 'POST', credentials: 'same-origin', body: fd });
      const j = (await res.json().catch(() => ({}))) as { result?: string; error?: string; detail?: string };
      if (!res.ok) throw new ApiError(res.status, j.error ?? 'error');
      setMsg(j.result === 'ok' ? { ok: true, text: 'התמונה עודכנה. ייתכן שיעברו כמה דקות עד שלקוחות יראו אותה.' }
        : { ok: false, text: `העדכון נכשל: ${errText(j.result ?? 'profile_photo_failed')}${j.detail ? ` פרטים מ-Meta: ${j.detail}` : ''}` });
      if (j.result === 'ok') { setFile(null); if (input.current) input.current.value = ''; }
    } catch (e) { setMsg({ ok: false, text: errText(e instanceof ApiError ? e.code : 'generic') }); }
    setBusy(false);
  }
  return (
    <section className="card" aria-labelledby={`pp-h-${channel.id}`}>
      <h3 id={`pp-h-${channel.id}`}>תמונת הפרופיל בווצאפ</h3>
      <p className="hint">התמונה שלקוחות רואים ליד שם העסק. PNG או JPEG, לפחות 192×192 פיקסלים (מומלץ 640×640, ריבועית), עד 5MB. ווצאפ חותך אותה לעיגול. {channel.type === 'whatsapp_cloud' ? 'בערוץ הרשמי היא נשמרת בפרופיל העסקי אצל Meta.' : ''}</p>
      {!connected && <p className="error">הערוץ צריך להיות מחובר כדי לעדכן תמונה.</p>}
      <div className="row" style={{ alignItems: 'center' }}>
        <button type="button" onClick={() => input.current?.click()} disabled={!connected}>בחירת תמונה</button>
        <input ref={input} type="file" accept="image/png,image/jpeg" hidden aria-hidden="true" tabIndex={-1} onChange={(e) => pick(e.target.files?.[0])} />
        {preview && <img src={preview} alt="תצוגה מקדימה של תמונת הפרופיל" width={72} height={72} style={{ borderRadius: '50%', objectFit: 'cover' }} />}
        {file && <button type="button" className="primary" disabled={busy || !connected} onClick={() => void upload()}>{busy ? 'מעדכן…' : 'עדכון התמונה בווצאפ'}</button>}
      </div>
      <p role="status" className={msg ? (msg.ok ? 'ok' : 'error') : undefined}>{msg?.text}</p>
    </section>
  );
}

/** E-mail: mailbox settings (the password is write-only) and the result of the IMAP/SMTP check. */
function EmailPanel({ channel, onSaved }: { channel: Channel; onSaved: () => void }) {
  type Cfg = { configured: boolean; imapHost?: string; imapPort?: number; smtpHost?: string; smtpPort?: number; username?: string; fromAddress?: string; fromName?: string; mailbox?: string };
  const [f, setF] = useState({ imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 465, username: '', password: '', fromAddress: '', fromName: '', mailbox: 'INBOX' });
  const [configured, setConfigured] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<Cfg>('GET', `/channels/${channel.id}/email`).then((d) => {
      setConfigured(d.configured);
      if (d.configured) setF((x) => ({ ...x, imapHost: d.imapHost ?? '', imapPort: d.imapPort ?? 993, smtpHost: d.smtpHost ?? '', smtpPort: d.smtpPort ?? 465, username: d.username ?? '', fromAddress: d.fromAddress ?? '', fromName: d.fromName ?? '', mailbox: d.mailbox ?? 'INBOX' }));
    }).catch(() => undefined);
  }, [channel.id]);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: k.endsWith('Port') ? Number(e.target.value) : e.target.value });
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const r = await api<{ status: string; error?: string }>('PUT', `/channels/${channel.id}/email`, { ...f, password: f.password || undefined });
      setF((x) => ({ ...x, password: '' })); setConfigured(true);
      setMsg(r.status === 'connected' ? { ok: true, text: 'החיבור הצליח: השרת קורא את התיבה ויכול לשלוח ממנה.' } : { ok: false, text: `הפרטים נשמרו, אבל החיבור נכשל: ${errText(r.error ?? 'mail_check_failed')}` });
      onSaved();
    } catch (er) { setMsg({ ok: false, text: errText(er instanceof ApiError ? er.code : 'generic') }); }
    setBusy(false);
  }
  const p = `em-${channel.id}`;
  return (
    <div className="card">
      <h3>הגדרת תיבת הדואר</h3>
      <p className="hint">החיבור תמיד מוצפן (TLS) ותעודת השרת נבדקת. יש להשתמש בשם השרת שעל התעודה, למשל <span dir="ltr">mail.example.com</span>. ב-Gmail ו-Microsoft 365 נדרשת לרוב סיסמת אפליקציה (App password), אם הארגון מאפשר. יש לאמת מול התיעוד של ספק הדואר.</p>
      <form onSubmit={save}>
        <fieldset><legend>קבלת דואר (IMAP)</legend>
          <div className="row">
            <div className="field" style={{ flex: '2 1 220px' }}><label htmlFor={`${p}-ih`}>שרת IMAP</label><input id={`${p}-ih`} required dir="ltr" autoComplete="off" spellCheck={false} value={f.imapHost} onChange={set('imapHost')} placeholder="mail.example.com" /></div>
            <div className="field" style={{ flex: '1 1 140px' }}><label htmlFor={`${p}-ip`}>פורט</label><select id={`${p}-ip`} value={f.imapPort} onChange={set('imapPort')}><option value={993}>993 (TLS)</option><option value={143}>143 (STARTTLS)</option></select></div>
          </div>
          <div className="field"><label htmlFor={`${p}-mb`}>תיקייה</label><input id={`${p}-mb`} dir="ltr" value={f.mailbox} onChange={set('mailbox')} /></div>
        </fieldset>
        <fieldset><legend>שליחת דואר (SMTP)</legend>
          <div className="row">
            <div className="field" style={{ flex: '2 1 220px' }}><label htmlFor={`${p}-sh`}>שרת SMTP</label><input id={`${p}-sh`} required dir="ltr" autoComplete="off" spellCheck={false} value={f.smtpHost} onChange={set('smtpHost')} placeholder="mail.example.com" /></div>
            <div className="field" style={{ flex: '1 1 140px' }}><label htmlFor={`${p}-sp`}>פורט</label><select id={`${p}-sp`} value={f.smtpPort} onChange={set('smtpPort')}><option value={465}>465 (TLS)</option><option value={587}>587 (STARTTLS)</option></select></div>
          </div>
        </fieldset>
        <fieldset><legend>חשבון ושולח</legend>
          <div className="field"><label htmlFor={`${p}-u`}>שם משתמש</label><input id={`${p}-u`} required dir="ltr" autoComplete="off" spellCheck={false} value={f.username} onChange={set('username')} placeholder="support@example.com" /></div>
          <div className="field"><label htmlFor={`${p}-pw`}>סיסמה{configured ? ' (השאירו ריק כדי לשמור את הקיימת)' : ''}</label><input id={`${p}-pw`} type="password" required={!configured} dir="ltr" autoComplete="new-password" data-lpignore="true" data-1p-ignore="true" data-form-type="other" value={f.password} onChange={set('password')} /></div>
          <div className="field"><label htmlFor={`${p}-fa`}>כתובת השולח</label><input id={`${p}-fa`} required type="email" dir="ltr" value={f.fromAddress} onChange={set('fromAddress')} placeholder="support@example.com" /></div>
          <div className="field"><label htmlFor={`${p}-fn`}>שם השולח (מה שהלקוח רואה)</label><input id={`${p}-fn`} maxLength={80} value={f.fromName} onChange={set('fromName')} placeholder="שירות הלקוחות" /></div>
        </fieldset>
        <p className="hint">הסיסמה נשמרת מוצפנת ולא מוצגת שוב.</p>
        <button className="primary" type="submit" disabled={busy}>{busy ? 'בודק חיבור…' : configured ? 'עדכון ובדיקת חיבור' : 'שמירה וחיבור'}</button>
        <p role="status" className={msg ? (msg.ok ? 'ok' : 'error') : undefined}>{msg?.text}</p>
      </form>
    </div>
  );
}

/** Messenger / Instagram: Page credentials, the webhook details for Meta's dashboard and the receive check. */
function MetaPanel({ channel, onSaved }: { channel: Channel; onSaved: () => void }) {
  const ig = channel.type === 'instagram';
  const [info, setInfo] = useState<{ configured: boolean; pageId?: string; igAccountId?: string; verifyToken?: string; webhookUrl: string; lastWebhookAt?: string | null; comments?: boolean; lastAttempt?: { at: string; outcome: string } | null } | null>(null);
  const [comments, setComments] = useState(false);
  const [pageId, setPageId] = useState('');
  const [igId, setIgId] = useState('');
  const [token, setToken] = useState('');
  const [secret, setSecret] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api<NonNullable<typeof info>>('GET', `/channels/${channel.id}/meta`).then((d) => { setInfo(d); if (d.pageId) setPageId(d.pageId); if (d.igAccountId) setIgId(d.igAccountId); setComments(!!d.comments); }).catch(() => undefined);
  useEffect(() => { void load(); }, [channel.id]);
  const copy = (v: string) => void navigator.clipboard?.writeText(v).catch(() => undefined);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const r = await api<{ status: string; error?: string; subscribe?: string | null }>('PUT', `/channels/${channel.id}/meta`, { pageId, pageAccessToken: token, appSecret: secret, comments, ...(ig ? { igAccountId: igId } : {}) });
      setToken(''); setSecret('');
      const sub = r.subscribe === 'ok' ? ' הדף נרשם לאפליקציה לקבלת הודעות.' : r.subscribe ? ` שימו לב: ${errText(r.subscribe)}` : '';
      setMsg(r.status === 'connected' ? { ok: true, text: `החיבור הצליח.${sub}` } : { ok: false, text: `הפרטים נשמרו, אבל החיבור ל-Meta נכשל: ${errText(r.error ?? 'meta_check_failed')}` });
      onSaved(); void load();
    } catch (er) { setMsg({ ok: false, text: errText(er instanceof ApiError ? er.code : 'generic') }); }
    setBusy(false);
  }
  const p = `mt-${channel.id}`;
  return (
    <div className="card">
      <h3>הגדרת {ig ? 'Instagram' : 'Messenger'}</h3>
      <ol>
        <li>באפליקציית Meta (אפשר את זו של הווצאפ הרשמי) הוסיפו את המוצר {ig ? 'Instagram (דרך Messenger API)' : 'Messenger'}.</li>
        <li>חברו את דף הפייסבוק{ig ? ' (שאליו מקושר חשבון האינסטגרם העסקי)' : ''}, וצרו <strong>Page access token</strong> קבוע (System User עם הרשאה לדף).</li>
        <li>העתיקו את <strong>Page ID</strong>{ig ? <>, את <strong>Instagram account ID</strong></> : ''} ואת <strong>App secret</strong> (הגדרות האפליקציה ← Basic).</li>
        <li>בהגדרות ה-Webhook של המוצר הדביקו את הכתובת ואת ה-Verify token שלמטה, וסמנו את <span dir="ltr">messages</span> ו-<span dir="ltr">messaging_postbacks</span>.</li>
        <li>ללקוחות אמיתיים: הגישו ל-Meta בקשת App Review להרשאות <span dir="ltr">{ig ? 'instagram_manage_messages' : 'pages_messaging'}</span> ו-<span dir="ltr">pages_manage_metadata</span>. עד האישור רק מנהלי האפליקציה ובודקים יכולים לכתוב.</li>
      </ol>
      <p className="hint">שמות המסכים וההרשאות אצל Meta משתנים מעת לעת. יש לאמת מול התיעוד הרשמי.</p>
      {info && (
        <dl>
          <dt>כתובת Webhook (Callback URL)</dt>
          <dd dir="ltr"><code>{info.webhookUrl}</code> <button type="button" onClick={() => copy(info.webhookUrl)}>העתקה</button></dd>
          {info.verifyToken && (<><dt>Verify token</dt><dd dir="ltr"><code>{info.verifyToken}</code> <button type="button" onClick={() => copy(info.verifyToken!)}>העתקה</button></dd></>)}
        </dl>
      )}
      <form onSubmit={save}>
        <div className="field"><label htmlFor={`${p}-pg`}>Page ID</label><input id={`${p}-pg`} required inputMode="numeric" dir="ltr" pattern="\d{5,32}" value={pageId} onChange={(e) => setPageId(e.target.value.replace(/\D/g, ''))} /></div>
        {ig && <div className="field"><label htmlFor={`${p}-ig`}>Instagram account ID</label><input id={`${p}-ig`} required inputMode="numeric" dir="ltr" pattern="\d{5,32}" value={igId} onChange={(e) => setIgId(e.target.value.replace(/\D/g, ''))} /></div>}
        <div className="field"><label htmlFor={`${p}-tk`}>Page access token</label><input id={`${p}-tk`} required type="password" autoComplete="new-password" data-lpignore="true" data-1p-ignore="true" data-form-type="other" spellCheck={false} dir="ltr" minLength={20} value={token} onChange={(e) => setToken(e.target.value.trim())} /></div>
        <div className="field"><label htmlFor={`${p}-as`}>App secret</label><input id={`${p}-as`} required type="password" autoComplete="new-password" data-lpignore="true" data-1p-ignore="true" data-form-type="other" spellCheck={false} dir="ltr" minLength={16} value={secret} onChange={(e) => setSecret(e.target.value.trim())} /></div>
        <div className="field"><label><input type="checkbox" role="switch" checked={comments} onChange={(e) => setComments(e.target.checked)} aria-describedby={`${p}-cmh`} /> קליטת תגובות על פוסטים</label>
          <p id={`${p}-cmh`} className="hint">תגובות על הפוסטים נכנסות לתיבה כשיחה נפרדת לכל כותב/ת. הבוט לא עונה עליהן. הנציג/ה בוחר/ת בכל פעם אם לענות בפרטי או בפומבי, ויכול/ה להסתיר תגובה. דורש הרשאות נוספות ב-App Review ({ig ? <span dir="ltr">instagram_manage_comments</span> : <><span dir="ltr">pages_read_user_content</span>, <span dir="ltr">pages_manage_engagement</span></>}) ואת שדה ה-Webhook {ig ? <span dir="ltr">comments</span> : <span dir="ltr">feed</span>}. יש לאמת מול התיעוד הרשמי.</p></div>
        <p className="hint">הערכים נשמרים מוצפנים ולא יוצגו שוב.</p>
        <button className="primary" type="submit" disabled={busy}>{info?.configured ? 'עדכון ופתיחת חיבור' : 'שמירה וחיבור'}</button>
        <p role="status" className={msg ? (msg.ok ? 'ok' : 'error') : undefined}>{msg?.text}</p>
      </form>
      {info?.configured && <WebhookCheck kind="meta" channelId={channel.id} connected={channel.status === 'connected'} lastWebhookAt={info.lastWebhookAt ?? null} lastAttempt={info.lastAttempt} />}
    </div>
  );
}

/** "No messages arrive": link the business account to the app again and show whether Meta delivers to us at all. */
const ATTEMPT: Record<string, { ok: boolean; text: string }> = {
  ok: { ok: true, text: 'הודעה חתומה התקבלה ועובדה.' },
  handshake_ok: { ok: true, text: 'Meta אימתה את כתובת ה-Webhook (Verify token תקין). עכשיו צריך שהשדה messages יהיה מסומן ב-Subscribe, ואז לשלוח הודעת ניסיון.' },
  handshake_bad_token: { ok: false, text: 'Meta ניסתה לאמת את הכתובת, אבל ה-Verify token שהוזן אצל Meta לא תואם לזה שמוצג כאן. העתיקו אותו שוב בדיוק.' },
  bad_signature: { ok: false, text: 'הגיעה בקשה מ-Meta, אבל החתימה לא תואמת. כמעט תמיד זה App secret שגוי: העתיקו אותו מחדש מהגדרות האפליקציה ← Basic ושמרו כאן.' },
  unsigned: { ok: false, text: 'הגיעה בקשה בלי חתימה, כלומר לא מ-Meta (או דרך שרת ביניים שמסיר כותרות). הבקשה נדחתה.' },
  not_running: { ok: false, text: 'Meta פנתה לשרת בזמן שהערוץ לא היה פעיל, ולכן הבקשה נדחתה. ודאו שהערוץ מחובר. Meta תנסה שוב.' },
};
function WebhookCheck({ channelId, connected, lastWebhookAt, lastAttempt, kind = 'cloud' }: { channelId: string; connected: boolean; lastWebhookAt: string | null; lastAttempt?: { at: string; outcome: string } | null; kind?: 'cloud' | 'meta' }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [ok, setOk] = useState(false);
  type Hook = { application?: string; whatsapp_business_account?: string; phone_number?: string; effective: string | null; ours: string; matches: boolean };
  const [hook, setHook] = useState<Hook | null>(null);
  type AppFields = { appId: string; callbackUrl: string | null; fields: string[]; messages: boolean; urlMatches: boolean };
  const [app, setApp] = useState<AppFields | null | undefined>(undefined);
  const [fieldsMsg, setFieldsMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function subscribeFields() {
    setFieldsMsg(null);
    try {
      const r = await api<{ result: string }>('POST', `/channels/${channelId}/cloud/subscribe-fields`);
      setFieldsMsg(r.result === 'ok' ? { ok: true, text: 'Meta אישרה: האפליקציה רשומה לשדה messages עם הכתובת של השרת הזה.' } : { ok: false, text: errText(r.result) });
      if (r.result === 'ok') void check();
    } catch (er) { setFieldsMsg({ ok: false, text: errText(er instanceof ApiError ? er.code : 'generic') }); }
  }
  const [routeMsg, setRouteMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmRoute, setConfirmRoute] = useState(false);
  async function routeHere() {
    setRouteMsg(null);
    try {
      const r = await api<{ result: string }>('POST', `/channels/${channelId}/cloud/route-here`);
      setRouteMsg(r.result === 'ok' ? { ok: true, text: 'Meta אישרה: הודעות המספר יישלחו מעכשיו לשרת הזה. שלחו הודעת ניסיון מטלפון אחר.' } : { ok: false, text: errText(r.result) });
      if (r.result === 'ok') void check();
    } catch (er) { setRouteMsg({ ok: false, text: errText(er instanceof ApiError ? er.code : 'generic') }); }
  }
  async function check() {
    setBusy(true); setMsg('');
    try {
      const r = await api<{ result: string; subscribed: boolean | null; webhook?: Hook | null; appFields?: AppFields | null }>('POST', `/channels/${channelId}/${kind}/subscribe`);
      setHook(r.webhook ?? null);
      setApp(kind === 'cloud' ? (r.appFields ?? null) : undefined);
      const good = r.result === 'ok' && r.subscribed !== false;
      setOk(good);
      setMsg(good ? (kind === 'meta' ? 'הדף רשום לאפליקציה. אם עדיין לא מגיעות הודעות, ודאו שבהגדרות ה-Webhook של האפליקציה מסומנים messages ו-messaging_postbacks.' : 'החשבון העסקי מחובר לאפליקציה. אם עדיין לא מגיעות הודעות, ודאו שהשדה messages מסומן ב-Subscribe בהגדרות ה-Webhook אצל Meta.') : errText(r.result === 'ok' ? 'meta_check_failed' : r.result));
    } catch (er) { setOk(false); setMsg(errText(er instanceof ApiError ? er.code : 'generic')); }
    setBusy(false);
  }
  const when = lastWebhookAt ? new Date(lastWebhookAt).toLocaleString('he-IL') : null;
  return (
    <section aria-labelledby={`whk-${channelId}`} className="fieldset">
      <h4 id={`whk-${channelId}`}>קבלת הודעות מ-Meta</h4>
      <p>{when ? <>ההודעה האחרונה מ-Meta התקבלה ב-<time dateTime={lastWebhookAt!}>{when}</time>.</> : 'עוד לא התקבלה הודעה מ-Meta מאז שהשרת עלה. שלחו הודעת ניסיון למספר העסקי מטלפון אחר.'}</p>
      {lastAttempt && ATTEMPT[lastAttempt.outcome] && (
        <p className={ATTEMPT[lastAttempt.outcome]!.ok ? 'ok' : 'error'}>
          <strong>הפנייה האחרונה לכתובת ה-Webhook (<time dateTime={lastAttempt.at}>{new Date(lastAttempt.at).toLocaleString('he-IL')}</time>):</strong> {ATTEMPT[lastAttempt.outcome]!.text}
        </p>
      )}
      {!lastAttempt && <p className="hint">אף בקשה לא הגיעה לכתובת ה-Webhook מאז שהשרת עלה. אם Meta כבר שלחה, היא לא מגיעה לשרת: בדקו את כתובת ה-Callback URL אצל Meta, ושהאתר נגיש מבחוץ ב-HTTPS עם תעודה תקפה.</p>}
      {kind === 'meta'
        ? <p className="hint">כדי שהודעות יגיעו צריך שני דברים: (1) הדף רשום לאפליקציה. הכפתור עושה זאת. (2) בהגדרות ה-Webhook של האפליקציה (Messenger או Instagram) מסומנים השדות <span dir="ltr">messages</span> ו-<span dir="ltr">messaging_postbacks</span>. יש לאמת מול התיעוד הרשמי.</p>
        : <p className="hint">כדי שהודעות יגיעו צריך שני דברים: (1) האפליקציה רשומה לחשבון העסקי (WABA). הכפתור עושה זאת. (2) ב-WhatsApp ← Configuration ← Webhook fields, השדה <span dir="ltr">messages</span> מסומן ב-Subscribe. עדכוני סטטוס (נשלח / נמסר / נקרא) מגיעים בתוך אותו שדה. יש לאמת מול התיעוד הרשמי.</p>}
      <button type="button" onClick={() => void check()} disabled={busy || !connected} aria-describedby={connected ? undefined : `whn-${channelId}`}>חיבור ובדיקה</button>
      {!connected && <p id={`whn-${channelId}`} className="hint">זמין רק כשהערוץ מחובר.</p>}
      <p role="status" className={msg ? (ok ? 'ok' : 'error') : undefined}>{msg}</p>
      {hook && (
        <div className={hook.matches ? 'ok' : 'error'} role="status">
          {hook.matches
            ? <p><strong>Meta שולחת את הודעות המספר לשרת הזה.</strong></p>
            : <>
                <p><strong>{hook.effective ? 'Meta שולחת את הודעות המספר לכתובת אחרת:' : 'אצל Meta לא מוגדרת כתובת Webhook למספר הזה.'}</strong></p>
                {hook.effective && <p dir="ltr"><code>{hook.effective}</code></p>}
                <p className="hint">{hook.phone_number ? 'הכתובת מוגדרת על המספר עצמו (Override), למשל על ידי ספק אחר, והיא גוברת על הגדרת האפליקציה.' : hook.whatsapp_business_account ? 'הכתובת מוגדרת על החשבון העסקי (Override) וגוברת על הגדרת האפליקציה.' : 'זו הכתובת שמוגדרת באפליקציה (WhatsApp ← Configuration).'}</p>
                <button type="button" className="primary" onClick={() => setConfirmRoute(true)}>להפנות את הודעות המספר לשרת הזה</button>
              </>}
        </div>
      )}
      {routeMsg && <p role="status" className={routeMsg.ok ? 'ok' : 'error'}>{routeMsg.text}</p>}
      {app === null && <p className="error" role="status">לא ניתן לבדוק את רישום ה-Webhook של האפליקציה. בדרך כלל זה App secret שגוי, או אסימון ששייך לאפליקציה אחרת.</p>}
      {app && (app.messages && app.urlMatches
        ? <div className="ok" role="status">
            <p><strong>האפליקציה (App ID <span dir="ltr">{app.appId}</span>) רשומה לשדה messages, עם הכתובת של השרת הזה.</strong></p>
            <p>אם עדיין לא מגיעות הודעות, כמעט בטוח שהאפליקציה עוד במצב פיתוח (Development). כך Meta שולחת רק הודעות בדיקה מהלוח ולא הודעות אמיתיות. כדי לעבור ל-Live: ב-developers.facebook.com ← My Apps ← האפליקציה, ובראש העמוד App Mode ← Live. Meta תבקש כתובת למדיניות הפרטיות, למשל <span dir="ltr">{location.origin}/legal/privacy</span>. יש לאמת מול התיעוד של Meta.</p>
          </div>
        : <div className="error" role="status">
            <p><strong>{!app.messages ? 'האפליקציה לא רשומה לשדה messages, ולכן Meta לא שולחת הודעות.' : 'האפליקציה רשומה לשדה messages, אבל עם כתובת אחרת:'}</strong></p>
            {app.callbackUrl && !app.urlMatches && <p dir="ltr"><code>{app.callbackUrl}</code></p>}
            <button type="button" className="primary" onClick={() => void subscribeFields()}>רישום האפליקציה לשדה messages עם הכתובת של השרת הזה</button>
          </div>)}
      {app && /^\d{5,32}$/.test(app.appId) && (
        <p><a href={`https://developers.facebook.com/apps/${app.appId}/`} target="_blank" rel="noopener noreferrer">פתיחת לוח הבקרה של האפליקציה ב-Meta (App ID <span dir="ltr">{app.appId}</span>)<span className="sr-only"> (נפתח בחלון חדש)</span></a>. שם: WhatsApp ← Configuration ← Webhook fields ← messages.</p>
      )}
      {fieldsMsg && <p role="status" className={fieldsMsg.ok ? 'ok' : 'error'}>{fieldsMsg.text}</p>}
      <ConfirmDialog open={confirmRoute} title="הפניית ההודעות לשרת הזה"
        message={`Meta תשלח את הודעות המספר הזה לכתובת ${hook?.ours ?? ''} במקום ${hook?.effective ?? 'הכתובת הנוכחית'}. אם ספק אחר מקבל היום את ההודעות, הוא יפסיק לקבל אותן.`}
        confirmLabel="הפניה לכאן" onCancel={() => setConfirmRoute(false)}
        onConfirm={() => { setConfirmRoute(false); void routeHere(); }} />
    </section>
  );
}


type Level = 'off' | 'optional' | 'required';
interface WebCfg {
  design: { title: string; subtitle: string; welcome: string; color: string; position: 'left' | 'right'; launcherLabel: string; launcherIcon: 'chat' | 'help' | 'message'; language: 'he' | 'en' };
  behavior: { askName: Level; askEmail: Level; askPhone: Level; popupText: string; popupDelaySec: number; autoOpenSec: number; showAgentName: boolean; consentText: string; consentLink: string; offlineMessage: string; maxLength: number; suggestions?: boolean; socialLinks?: SocialLink[] };
  allowedOrigins: string[]; allowAnyOrigin: boolean; publicKey: string; embedCode: string; previewUrl: string; status: string;
}
const LEVELS: [Level, string][] = [['off', 'לא לבקש'], ['optional', 'לא חובה'], ['required', 'חובה']];
type SocialNet = 'whatsapp' | 'messenger' | 'instagram' | 'telegram' | 'email' | 'phone';
interface SocialLink { network: SocialNet; handle: string }
const NETS: { id: SocialNet; label: string; hint: string; ltr: boolean; placeholder: string }[] = [
  { id: 'whatsapp', label: 'WhatsApp', hint: 'מספר בפורמט בינלאומי, ספרות בלבד', ltr: true, placeholder: '972501234567' },
  { id: 'messenger', label: 'Messenger', hint: 'שם המשתמש של דף הפייסבוק', ltr: true, placeholder: 'mybusiness' },
  { id: 'instagram', label: 'Instagram', hint: 'שם המשתמש באינסטגרם', ltr: true, placeholder: 'mybusiness' },
  { id: 'telegram', label: 'Telegram', hint: 'שם משתמש או בוט, בלי @', ltr: true, placeholder: 'mybusiness_bot' },
  { id: 'email', label: 'אימייל', hint: 'כתובת אימייל', ltr: true, placeholder: 'support@example.com' },
  { id: 'phone', label: 'טלפון', hint: 'מספר טלפון', ltr: true, placeholder: '+97231234567' },
];

/** "You can also reach us on…" buttons in the widget. */
function SocialLinksEditor({ links, onChange, idp }: { links: SocialLink[]; onChange: (l: SocialLink[]) => void; idp: string }) {
  const set = (i: number, patch: Partial<SocialLink>) => onChange(links.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <fieldset>
      <legend>כפתורי "אפשר גם לכתוב לנו ב…"</legend>
      <p className="hint">מוצגים בפתיחת הצ׳אט, כקישורים רגילים לאפליקציות. אין סקריפט של צד שלישי ואין עוגיות. עד 6 כפתורים, בסדר שבו הם מופיעים כאן.</p>
      {links.length === 0 && <p>אין כפתורים.</p>}
      {links.map((l, i) => {
        const n = NETS.find((x) => x.id === l.network)!;
        return (
          <div className="row" key={i} style={{ alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: '0 1 160px' }}><label htmlFor={`${idp}-sn-${i}`}>רשת {i + 1}</label>
              <select id={`${idp}-sn-${i}`} value={l.network} onChange={(e) => set(i, { network: e.target.value as SocialNet })}>
                {NETS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
              </select></div>
            <div className="field" style={{ flex: '1 1 200px' }}><label htmlFor={`${idp}-sh-${i}`}>{n.hint}</label>
              <input id={`${idp}-sh-${i}`} required dir={n.ltr ? 'ltr' : 'auto'} maxLength={200} value={l.handle} placeholder={n.placeholder} onChange={(e) => set(i, { handle: e.target.value })} /></div>
            <button type="button" onClick={() => onChange(links.filter((_, j) => j !== i))}>הסרה<span className="sr-only"> של {n.label}</span></button>
          </div>
        );
      })}
      <button type="button" disabled={links.length >= 6} onClick={() => onChange([...links, { network: links.some((l) => l.network === 'whatsapp') ? 'messenger' : 'whatsapp', handle: '' }])}>הוספת כפתור</button>
    </fieldset>
  );
}

/** Settings of a website-chat channel: look, behaviour, which sites may embed it, the embed code and the identity secret. */
function WebChatPanel({ channel, onSaved }: { channel: Channel; onSaved: () => void }) {
  const [c, setC] = useState<WebCfg | null>(null);
  const [origins, setOrigins] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [secret, setSecret] = useState('');
  const [preview, setPreview] = useState(0);
  const [busy, setBusy] = useState(false);
  // a (late or repeated) load never overwrites what the admin already typed in the sites field
  const originsTouched = useRef(false);
  useEffect(() => { void api<WebCfg>('GET', `/channels/${channel.id}/webchat`).then((d) => { setC((cur) => cur ?? d); if (!originsTouched.current) setOrigins(d.allowedOrigins.join('\n')); }).catch(() => undefined); }, [channel.id]);
  if (!c) return <Loading lines={4} />;
  const d = (p: Partial<WebCfg['design']>) => setC({ ...c, design: { ...c.design, ...p } });
  const b = (p: Partial<WebCfg['behavior']>) => setC({ ...c, behavior: { ...c.behavior, ...p } });
  const id = (k: string) => `wc-${k}-${channel.id}`;
  const copy = (v: string) => void navigator.clipboard?.writeText(v).then(() => setMsg({ ok: true, text: 'הועתק.' })).catch(() => undefined);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const r = await api<WebCfg>('PUT', `/channels/${channel.id}/webchat`, { design: c!.design, behavior: c!.behavior, allowedOrigins: origins.split('\n').map((x) => x.trim()).filter(Boolean), allowAnyOrigin: c!.allowAnyOrigin });
      setC(r); setOrigins(r.allowedOrigins.join('\n')); originsTouched.current = false; setPreview((n) => n + 1); onSaved();
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
        <div className="card">
          <h5 style={{ margin: '0 0 .4rem' }}>אתר וורדפרס?</h5>
          <p className="hint">אפשר להתקין תוסף שמוסיף את הצ׳אט בלי לגעת בקוד: הורידו את התוסף (כבר מוגדר עם כתובת השרת ומפתח האתר של הצ׳אט הזה), בוורדפרס: תוספים ← הוספת תוסף ← העלאה, והפעילו. אל תשכחו להוסיף את כתובת האתר ל"אתרים מורשים" למטה. פירוט: docs/WORDPRESS.he.md.</p>
          <a className="btn" href={`/channels/${channel.id}/webchat/wordpress-plugin.zip`} download>הורדת תוסף וורדפרס</a>
        </div>
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
        <div className="field"><label><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={c.behavior.suggestions !== false} onChange={(e) => b({ suggestions: e.target.checked })} /> השלמה אוטומטית: בזמן שהגולש מקליד, להציע שאלות נפוצות ממאגר הידע עם תשובה מיידית</label>
          <p className="hint">מוצגות רק שאלות ותשובות (FAQ) שסומנו לבוט. התשובה מוצגת לגולש בלבד ולא נשלחת לתיבת השיחות; אם לא עזרה, הוא כותב כרגיל.</p></div>
        <SocialLinksEditor idp={id('soc')} links={c.behavior.socialLinks ?? []} onChange={(socialLinks) => b({ socialLinks })} />
        <div className="field"><label htmlFor={id('off')}>הודעה מחוץ לשעות הפעילות</label><textarea id={id('off')} rows={2} maxLength={300} value={c.behavior.offlineMessage} onChange={(e) => b({ offlineMessage: e.target.value })} /></div>
        <div className="field"><label htmlFor={id('cons')}>הצהרת הסכמה לפני תחילת שיחה (אופציונלי)</label><input id={id('cons')} maxLength={300} value={c.behavior.consentText} onChange={(e) => b({ consentText: e.target.value })} placeholder="קראתי ואני מסכים/ה למדיניות הפרטיות" /><p className="hint">אם מוגדרת, הגולש חייב לסמן אותה, והאישור נרשם בשיחה. מומלץ לכלול קישור למדיניות. ניסוח ההצהרה דורש בדיקה משפטית.</p></div>
        <div className="field"><label htmlFor={id('cl')}>קישור למדיניות הפרטיות (https)</label><input id={id('cl')} dir="ltr" maxLength={300} value={c.behavior.consentLink} onChange={(e) => b({ consentLink: e.target.value })} placeholder="https://example.com/privacy" /></div>

        <h4>3. אתרים מורשים</h4>
        <div className="field">
          <label htmlFor={id('org')}>כתובות האתרים שמותר להם להציג את הצ׳אט (שורה לכל אתר)</label>
          <textarea id={id('org')} dir="ltr" rows={3} value={origins} onChange={(e) => { originsTouched.current = true; setOrigins(e.target.value); }} placeholder={'https://www.example.com\nhttps://*.example.co.il'} />
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


interface Tpl { name: string; language: string; status: string; category: string; body: string; params: number; rejectedReason: string | null }
const TPL_STATUS: Record<string, string> = { APPROVED: 'מאושרת', PENDING: 'ממתינה לאישור', REJECTED: 'נדחתה', PAUSED: 'מושהית', DISABLED: 'מושבתת' };
const TPL_CAT: Record<string, string> = { UTILITY: 'שירותית', MARKETING: 'שיווקית', AUTHENTICATION: 'אימות' };

/** Message templates of the official channel: the list with their approval status, and a form to submit a new one for Meta's approval. */
function TemplatesPanel({ channelId, hasWaba }: { channelId: string; hasWaba: boolean }) {
  const [list, setList] = useState<Tpl[] | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [f, setF] = useState({ name: '', language: 'he', category: 'UTILITY', body: '', examples: '' });
  const [busy, setBusy] = useState(false);
  const fail = (e: unknown) => setMsg({ ok: false, text: e instanceof ApiError && e.code === 'template_rejected' ? `Meta דחתה את הבקשה${e.detail ? `: ${e.detail}` : ''}.` : errText(e instanceof ApiError ? e.code : 'generic') });
  async function load(refresh = false) { setMsg(null); try { setList(await api<Tpl[]>('GET', `/channels/${channelId}/templates${refresh ? '?refresh=1' : ''}`)); } catch (e) { setList(null); fail(e); } }
  useEffect(() => { if (hasWaba) void load(); }, [channelId, hasWaba]); // eslint-disable-line react-hooks/exhaustive-deps
  async function create(e: FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    try {
      await api('POST', `/channels/${channelId}/templates`, { name: f.name.trim(), language: f.language, category: f.category, body: f.body.trim(), examples: f.examples.split('\n').map((x) => x.trim()).filter(Boolean) });
      setMsg({ ok: true, text: 'התבנית הוגשה לאישור של Meta. בדרך כלל התשובה מגיעה תוך דקות עד שעות; רעננו את הרשימה.' });
      setF({ name: '', language: 'he', category: 'UTILITY', body: '', examples: '' }); await load(true);
    } catch (er) { fail(er); }
    setBusy(false);
  }
  return (
    <section aria-labelledby={`tp-h-${channelId}`}>
      <h3 id={`tp-h-${channelId}`}>תבניות הודעה</h3>
      <p className="hint">תבנית היא הודעה שאושרה מראש על ידי Meta. רק בעזרתה אפשר לכתוב ללקוח אחרי שעברו 24 שעות מהודעתו האחרונה (בשיחה: "שליחת תבנית"). הגשת תבנית חדשה כפופה לאישור של Meta, והמחיר והמדיניות שלה (שיווקית או שירותית) נקבעים אצלם. יש לאמת את הכללים מול התיעוד הרשמי.</p>
      {!hasWaba ? <p className="hint">כדי לראות ולהגיש תבניות, הוסיפו למעלה את WhatsApp Business Account ID ושמרו.</p> : (
        <>
          <div className="row"><button type="button" onClick={() => void load(true)}>רענון הרשימה</button></div>
          {list && (list.length === 0 ? <p className="empty">אין תבניות בחשבון.</p> : (
            <table>
              <caption className="sr-only">תבניות ההודעה של החשבון</caption>
              <thead><tr><th scope="col">שם</th><th scope="col">שפה</th><th scope="col">סוג</th><th scope="col">מצב</th><th scope="col">נוסח</th></tr></thead>
              <tbody>{list.map((t) => <tr key={`${t.name}-${t.language}`}><th scope="row" dir="ltr">{t.name}</th><td>{t.language}</td><td>{TPL_CAT[t.category] ?? t.category}</td>
                <td>{TPL_STATUS[t.status] ?? t.status}{t.rejectedReason ? ` (${t.rejectedReason})` : ''}</td><td style={{ whiteSpace: 'pre-wrap' }}>{t.body}</td></tr>)}</tbody>
            </table>
          ))}
          <form onSubmit={create}>
            <h4>הגשת תבנית חדשה</h4>
            <div className="row">
              <div className="field"><label htmlFor={`tn-${channelId}`}>שם (אותיות אנגליות קטנות, מספרים וקו תחתון)</label><input id={`tn-${channelId}`} required dir="ltr" maxLength={60} pattern="[a-z0-9_]+" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
              <div className="field"><label htmlFor={`tl-${channelId}`}>שפה</label><select id={`tl-${channelId}`} value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })}><option value="he">עברית</option><option value="en">אנגלית</option><option value="ar">ערבית</option><option value="ru">רוסית</option></select></div>
              <div className="field"><label htmlFor={`tc-${channelId}`}>סוג</label><select id={`tc-${channelId}`} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="UTILITY">שירותית (עדכון על פנייה או הזמנה)</option><option value="MARKETING">שיווקית</option></select></div>
            </div>
            <div className="field"><label htmlFor={`tb-${channelId}`}>נוסח ההודעה (אפשר {'{{1}}'}, {'{{2}}'} למשתנים, לא בתחילת הנוסח ולא בסופו)</label><textarea id={`tb-${channelId}`} required rows={3} maxLength={1024} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></div>
            <div className="field"><label htmlFor={`te-${channelId}`}>דוגמה לכל משתנה (שורה לכל משתנה, לפי הסדר)</label><textarea id={`te-${channelId}`} rows={2} value={f.examples} onChange={(e) => setF({ ...f, examples: e.target.value })} /></div>
            <button className="primary" type="submit" disabled={busy}>הגשה לאישור</button>
          </form>
        </>
      )}
      <p role="status" className={msg?.ok ? 'ok' : 'error'}>{msg?.text}</p>
    </section>
  );
}

import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { usePoll } from '../hooks';
import { errText } from '../strings';

interface Key { id: string; name: string; prefix: string; scopes: string[]; createdAt: string; lastUsedAt: string | null; revokedAt: string | null; createdBy: string | null }
interface Hook { id: string; name: string; url: string; events: string[]; includeText: boolean; enabled: boolean; failures: number; disabledReason: string | null; pending: number }
interface Delivery { id: string; event: string; status: string; attempts: number; responseCode: number | null; lastError: string | null; createdAt: string }

const SCOPE_LABEL: Record<string, string> = { read: 'קריאה (שיחות, הודעות, תגיות)', send: 'שליחת תשובות בשיחות קיימות', manage: 'ניהול (סטטוס, שיוך, תגיות)' };
const EVENT_LABEL: Record<string, string> = { 'message.received': 'הודעה נכנסת מלקוח', 'message.sent': 'הודעה יוצאת (נציג, בוט או API)', 'conversation.status_changed': 'שינוי סטטוס שיחה', 'conversation.sla_breached': 'חריגה מיעד זמן המענה (SLA)', 'conversation.assigned': 'שיוך שיחה' };
const DELIVERY_ERR: Record<string, string> = {
  dns_failed: 'הכתובת לא נמצאה (בעיית DNS). בדקו את שם האתר, ושהשרת של Botwa מגיע לאינטרנט.',
  connection_refused: 'השרת המקבל סירב לחיבור (הפורט סגור או השירות כבוי).',
  timeout: 'השרת המקבל לא ענה בזמן (8 שניות).',
  connection_reset: 'החיבור נותק על ידי השרת המקבל.',
  tls_error: 'בעיה בתעודת ה-HTTPS של השרת המקבל (פגה, לא מהימנה או לא תואמת לשם).',
  unreachable: 'אין ניתוב לשרת המקבל מהשרת של Botwa.',
  blocked_address: 'הכתובת חסומה מטעמי אבטחה (כתובת פנימית).',
  https_required: 'נדרשת כתובת https.',
  fetch_failed: 'לא ניתן להתחבר לכתובת. בדקו שהיא נכונה ופתוחה מהאינטרנט.',
  webhook_disabled: 'ה-Webhook מושבת.',
};
const deliveryError = (e: string | null) => (!e ? '' : DELIVERY_ERR[e] ?? (/^http_3\d\d$/.test(e) ? 'השרת המקבל ביקש הפניה (' + e.slice(5) + '). הפניות אינן נתמכות: השתמשו בכתובת הסופית.' : /^http_\d+$/.test(e) ? 'השרת המקבל ענה ' + e.slice(5) + ' (נדרש קוד 2xx).' : e));
const fmt = (s: string | null) => (s ? new Date(s).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : '—');

export function Integrations() {
  const [tab, setTab] = useState<'keys' | 'hooks' | 'docs'>('keys');
  return (
    <>
      <h1 tabIndex={-1}>אינטגרציות</h1>
      <p className="hint">חיבור מערכות חיצוניות: מפתחות API לקריאה ושליחה, ו-Webhooks שמעדכנים מערכת אחרת על אירועים. כל פעולה נרשמת ביומן הביקורת.</p>
      <div className="chips" role="group" aria-label="חלקי האינטגרציות">
        {([['keys', 'מפתחות API'], ['hooks', 'Webhooks'], ['docs', 'תיעוד']] as const).map(([k, l]) => <button key={k} className="chip" aria-pressed={tab === k} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'keys' && <Keys />}
      {tab === 'hooks' && <Hooks />}
      {tab === 'docs' && <Docs />}
    </>
  );
}

function Keys() {
  const [list, setList] = useState<Key[]>([]);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['read']);
  const [created, setCreated] = useState('');
  const [msg, setMsg] = useState('');
  const [revoke, setRevoke] = useState<Key | null>(null);
  const load = async () => setList(await api<Key[]>('GET', '/integrations/keys').catch(() => []));
  usePoll(load, 15000);
  async function create(e: FormEvent) {
    e.preventDefault(); setMsg('');
    try { const r = await api<{ key: string }>('POST', '/integrations/keys', { name, scopes }); setCreated(r.key); setName(''); await load(); } catch (er) { setMsg(errText(er instanceof ApiError ? er.code : 'generic')); }
  }
  return (
    <>
      <section className="card" aria-labelledby="pa-h">
        <h2 id="pa-h">Power Apps, Power Automate ו-Power BI</h2>
        <p className="hint">משיכת נתונים (שיחות, הודעות, אנשי קשר, סטטיסטיקה, שאלות ותשובות) ושליחת תשובות דרך מחבר מותאם (Custom connector).</p>
        <ol>
          <li>צרו כאן מפתח עם הרשאת <strong>read</strong> (ו-<strong>send</strong> אם האפליקציה תשלח תשובות).</li>
          <li>הורידו את קובץ ההגדרות: <a className="btn" href="/api/v1/openapi.json" download="botwa-openapi.json">botwa-openapi.json</a></li>
          <li>ב-Power Apps: Custom connectors ← New ← Import an OpenAPI file ← בחרו את הקובץ.</li>
          <li>באימות בחרו API Key, שם הפרמטר <code dir="ltr">Authorization</code>, מיקום Header. בחיבור הדביקו <code dir="ltr">Bearer bk_...</code> (המילה Bearer, רווח, והמפתח).</li>
          <li>באפליקציה: <code dir="ltr">Botwa.ListConversations().items</code>, <code dir="ltr">Botwa.GetStats({'{'}days: 30{'}'})</code> וכו'.</li>
        </ol>
        <p className="hint">כל קריאה של רשימת אנשי הקשר נרשמת ביומן הביקורת. את המפתח שומרים רק בחיבור של Power Apps, לא בתוך האפליקציה עצמה. מדריך מלא: docs/POWER_APPS.he.md.</p>
      </section>
      <section className="card" aria-labelledby="k-new">
        <h2 id="k-new">מפתח חדש</h2>
        <form onSubmit={create}>
          <div className="field"><label htmlFor="k-name">שם (למשל "מערכת ה-CRM")</label><input id="k-name" required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} /></div>
          <fieldset className="field"><legend>הרשאות</legend>
            {Object.entries(SCOPE_LABEL).map(([s, l]) => <label key={s} style={{ fontWeight: 400 }}><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={scopes.includes(s)} onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))} /> {l}</label>)}
            <p className="hint">תנו למפתח רק מה שהוא צריך. אין דרך לשלוח הודעה ללקוח שלא פנה אליכם: שליחה אפשרית רק בשיחות קיימות ובכפוף לכללי החסימה וחלון התגובה.</p>
          </fieldset>
          <button className="primary" type="submit" disabled={scopes.length === 0}>יצירת מפתח</button>
          <p role="alert" className="error">{msg}</p>
        </form>
        {created && (
          <div role="status" className="card">
            <p className="error">שמרו את המפתח עכשיו, הוא לא יוצג שוב:</p>
            <code dir="ltr" style={{ wordBreak: 'break-all' }}>{created}</code>{' '}
            <button type="button" onClick={() => void navigator.clipboard?.writeText(created)}>העתקה</button>
          </div>
        )}
      </section>
      <section className="card" aria-labelledby="k-list" style={{ overflowX: 'auto' }} tabIndex={0}>
        <h2 id="k-list">מפתחות קיימים</h2>
        <table>
          <caption className="sr-only">מפתחות API</caption>
          <thead><tr><th scope="col">שם</th><th scope="col">מזהה</th><th scope="col">הרשאות</th><th scope="col">שימוש אחרון</th><th scope="col">מצב</th><th scope="col">פעולות</th></tr></thead>
          <tbody>
            {list.length === 0 && <tr><td colSpan={6}>אין מפתחות.</td></tr>}
            {list.map((k) => (
              <tr key={k.id}>
                <th scope="row">{k.name}</th><td dir="ltr"><code>bk_{k.prefix}_…</code></td><td>{k.scopes.map((s) => SCOPE_LABEL[s]?.split(' (')[0]).join(', ')}</td><td>{fmt(k.lastUsedAt)}</td>
                <td>{k.revokedAt ? <span className="error">בוטל</span> : <span className="ok">פעיל</span>}</td>
                <td>{!k.revokedAt && <button className="danger" onClick={() => setRevoke(k)}>ביטול<span className="sr-only"> {k.name}</span></button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <ConfirmDialog open={!!revoke} danger title="ביטול מפתח" message={`המפתח "${revoke?.name}" יפסיק לעבוד מיד. מערכות שמשתמשות בו יקבלו שגיאה.`} onCancel={() => setRevoke(null)}
        onConfirm={() => { const k = revoke!; setRevoke(null); void api('DELETE', `/integrations/keys/${k.id}`).then(load).catch(() => undefined); }} />
    </>
  );
}

function Hooks() {
  const [list, setList] = useState<Hook[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [form, setForm] = useState({ name: '', url: '', includeText: true, ev: ['message.received'] as string[] });
  const [secret, setSecret] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [del, setDel] = useState<Hook | null>(null);
  const [log, setLog] = useState<{ id: string; rows: Delivery[] } | null>(null);
  const load = async () => { const d = await api<{ events: string[]; items: Hook[] }>('GET', '/integrations/webhooks').catch(() => null); if (d) { setList(d.items); setEvents(d.events); } };
  usePoll(load, 10000);
  const fail = (er: unknown) => setMsg({ ok: false, text: er instanceof ApiError && ['https_required', 'blocked_address', 'bad_url'].includes(er.code) ? (er.code === 'https_required' ? 'נדרשת כתובת https.' : er.code === 'blocked_address' ? 'הכתובת חסומה מטעמי אבטחה (כתובת פנימית).' : 'כתובת לא תקינה.') : errText(er instanceof ApiError ? er.code : 'generic') });
  async function create(e: FormEvent) {
    e.preventDefault(); setMsg(null);
    try { const r = await api<{ secret: string }>('POST', '/integrations/webhooks', { name: form.name, url: form.url, events: form.ev, includeText: form.includeText }); setSecret(r.secret); setForm({ ...form, name: '', url: '' }); await load(); } catch (er) { fail(er); }
  }
  return (
    <>
      <section className="card" aria-labelledby="h-new">
        <h2 id="h-new">Webhook חדש</h2>
        <form onSubmit={create}>
          <div className="field"><label htmlFor="h-name">שם</label><input id="h-name" required maxLength={60} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div className="field"><label htmlFor="h-url">כתובת (https)</label><input id="h-url" required dir="ltr" inputMode="url" placeholder="https://example.com/botwa-hook" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} /></div>
          <fieldset className="field"><legend>אירועים</legend>
            {events.map((ev) => <label key={ev} style={{ fontWeight: 400 }}><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={form.ev.includes(ev)} onChange={(e) => setForm({ ...form, ev: e.target.checked ? [...form.ev, ev] : form.ev.filter((x) => x !== ev) })} /> {EVENT_LABEL[ev] ?? ev}</label>)}
          </fieldset>
          <div className="field"><label><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={form.includeText} onChange={(e) => setForm({ ...form, includeText: e.target.checked })} /> לכלול את טקסט ההודעות באירוע</label>
            <p className="hint">בלי הטקסט נשלחים רק מזהים ופרטים בסיסיים. הטקסט יכול להכיל מידע אישי של לקוחות: שלחו אותו רק למערכת שמורשית לקבל אותו, והוסיפו אותה למפת המידע ולמדיניות הפרטיות.</p></div>
          <button className="primary" type="submit" disabled={form.ev.length === 0}>יצירה</button>
          <p role="alert" className={msg?.ok ? 'ok' : 'error'}>{msg?.text}</p>
        </form>
        {secret && (
          <div role="status" className="card"><p className="error">סוד החתימה, מוצג פעם אחת. המערכת המקבלת צריכה אותו כדי לאמת שהאירוע הגיע מכאן:</p>
            <code dir="ltr" style={{ wordBreak: 'break-all' }}>{secret}</code> <button type="button" onClick={() => void navigator.clipboard?.writeText(secret)}>העתקה</button></div>
        )}
      </section>
      <section className="card" aria-labelledby="h-list" style={{ overflowX: 'auto' }} tabIndex={0}>
        <h2 id="h-list">Webhooks קיימים</h2>
        <table>
          <caption className="sr-only">Webhooks</caption>
          <thead><tr><th scope="col">שם</th><th scope="col">כתובת</th><th scope="col">אירועים</th><th scope="col">מצב</th><th scope="col">פעולות</th></tr></thead>
          <tbody>
            {list.length === 0 && <tr><td colSpan={5}>אין Webhooks.</td></tr>}
            {list.map((h) => (
              <tr key={h.id}>
                <th scope="row">{h.name}{!h.includeText && <div className="hint">בלי טקסט הודעות</div>}</th>
                <td dir="ltr" style={{ wordBreak: 'break-all' }}>{h.url}</td>
                <td>{h.events.map((e) => EVENT_LABEL[e] ?? e).join(', ')}</td>
                <td>{h.enabled ? <span className="ok">פעיל</span> : <span className="error">מושבת{h.disabledReason === 'too_many_failures' ? ' (יותר מדי כשלונות)' : ''}</span>}{h.pending > 0 && <div className="hint">{h.pending} ממתינים</div>}</td>
                <td><div className="row">
                  <button onClick={async () => { setMsg(null); try { const r = await api<{ status: string; responseCode: number | null; lastError: string | null }>('POST', `/integrations/webhooks/${h.id}/test`); setMsg({ ok: r.status === 'delivered', text: r.status === 'delivered' ? `נשלח בהצלחה (${r.responseCode}).` : `השליחה נכשלה: ${deliveryError(r.lastError)} (הניסיון יחזור אוטומטית)` }); await load(); } catch (er) { fail(er); } }}>בדיקה<span className="sr-only"> {h.name}</span></button>
                  <button onClick={async () => setLog({ id: h.id, rows: await api<Delivery[]>('GET', `/integrations/webhooks/${h.id}/deliveries`).catch(() => []) })}>יומן שליחות<span className="sr-only"> {h.name}</span></button>
                  <button onClick={async () => { await api('PATCH', `/integrations/webhooks/${h.id}`, { enabled: !h.enabled }).catch(() => undefined); await load(); }}>{h.enabled ? 'השבתה' : 'הפעלה'}<span className="sr-only"> {h.name}</span></button>
                  <button onClick={async () => { const r = await api<{ secret: string }>('POST', `/integrations/webhooks/${h.id}/rotate-secret`).catch(() => null); if (r) setSecret(r.secret); }}>סוד חדש<span className="sr-only"> {h.name}</span></button>
                  <button className="danger" onClick={() => setDel(h)}>מחיקה<span className="sr-only"> {h.name}</span></button>
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
        {log && (
          <div className="card">
            <h3>יומן שליחות אחרונות</h3>
            <table><caption className="sr-only">שליחות אחרונות</caption>
              <thead><tr><th scope="col">אירוע</th><th scope="col">מצב</th><th scope="col">ניסיונות</th><th scope="col">תגובה</th><th scope="col">זמן</th></tr></thead>
              <tbody>{log.rows.length === 0 && <tr><td colSpan={5}>אין שליחות.</td></tr>}{log.rows.map((d) => <tr key={d.id}><th scope="row" dir="ltr">{d.event}</th><td>{d.status === 'delivered' ? 'נמסר' : d.status === 'failed' ? 'נכשל' : 'ממתין'}</td><td>{d.attempts}</td><td>{d.responseCode ?? (deliveryError(d.lastError) || '—')}</td><td>{fmt(d.createdAt)}</td></tr>)}</tbody></table>
          </div>
        )}
      </section>
      <ConfirmDialog open={!!del} danger title="מחיקת Webhook" message={`"${del?.name}" ויומן השליחות שלו יימחקו.`} onCancel={() => setDel(null)}
        onConfirm={() => { const h = del!; setDel(null); void api('DELETE', `/integrations/webhooks/${h.id}`).then(load).catch(() => undefined); }} />
    </>
  );
}

function Docs() {
  const base = location.origin;
  return (
    <section className="card" aria-labelledby="d-h">
      <h2 id="d-h">תיעוד קצר</h2>
      <h3>REST API</h3>
      <p className="hint">הרשאה: כותרת <span dir="ltr">Authorization: Bearer bk_…</span>. כל התשובות ב-JSON. הגבלת קצב לכל מפתח.</p>
      <pre dir="ltr" style={{ whiteSpace: 'pre-wrap' }}>{`# read
GET  ${base}/api/v1/conversations?status=open&limit=50
GET  ${base}/api/v1/conversations/{id}
GET  ${base}/api/v1/conversations/{id}/messages?after_seq=0
GET  ${base}/api/v1/tags        GET ${base}/api/v1/users
# send (existing conversations only; blocked / opted-out / outside reply window are refused)
POST ${base}/api/v1/conversations/{id}/messages   {"text":"..."}
# manage
POST ${base}/api/v1/conversations/{id}/status     {"status":"closed"}
POST ${base}/api/v1/conversations/{id}/assign     {"userId":"<uuid>"|null}
POST ${base}/api/v1/conversations/{id}/tags       {"names":["vip"]}

curl -H "Authorization: Bearer $KEY" ${base}/api/v1/conversations?status=open`}</pre>
      <h3>Webhooks</h3>
      <p className="hint">כל אירוע נשלח ב-POST עם גוף JSON וכותרות <span dir="ltr">X-Botwa-Event</span>, <span dir="ltr">X-Botwa-Delivery</span>, <span dir="ltr">X-Botwa-Signature</span>. החזירו קוד 2xx תוך 8 שניות. אחרת נשלח שוב (עד 7 ניסיונות, מדקה ועד יממה), ואחרי 20 כשלונות רצופים ה-Webhook מושבת.</p>
      <pre dir="ltr" style={{ whiteSpace: 'pre-wrap' }}>{`// Verify (Node): header = "t=<unix>,v1=<hex>"
const [t, v1] = header.match(/t=(\\d+),v1=([0-9a-f]+)/).slice(1);
if (Math.abs(Date.now() / 1000 - Number(t)) > 300) throw new Error('too old');
const expected = crypto.createHmac('sha256', SECRET).update(t + '.' + rawBody).digest('hex');
if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1))) throw new Error('bad signature');

// Event
{ "id": "<uuid>", "type": "message.received", "createdAt": "...",
  "data": { "conversation": { "id", "status", "assignedTo", "channelType" },
            "contact": { "id", "name" },
            "message": { "id", "direction": "in", "text", "auto": false, "createdAt" } } }`}</pre>
      <p className="hint">אירועים עשויים להגיע יותר מפעם אחת: השתמשו ב-<span dir="ltr">id</span> כדי להתעלם מכפילויות.</p>
    </section>
  );
}

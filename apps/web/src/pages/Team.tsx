import { PageTitle } from '../components/Illustration';
import { Avatar, AvatarEditor, AvatarGalleryAdmin } from '../components/Avatar';
import { useRef, useState, type FormEvent } from 'react';
import { api, ApiError, can, type Me, type RoleRow, type UserRow } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { usePoll } from '../hooks';
import { errText, t } from '../strings';

export function Team({ me }: { me: Me }) {
  const meId = me.id;
  const isAdmin = can(me, 'users.manage');
  const [users, setUsers] = useState<UserRow[]>([]);
  const [msg, setMsg] = useState('');
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [f, setF] = useState({ name: '', email: '', role: 'agent', password: '', username: '' });
  const [unFor, setUnFor] = useState<{ id: string; name: string; value: string } | null>(null);
  const [jtFor, setJtFor] = useState<{ id: string; value: string } | null>(null);
  const [heFor, setHeFor] = useState<{ id: string; value: string } | null>(null);
  // you can only hand out roles whose permissions you hold yourself
  const assignable = roles.filter((r) => r.permissions.every((p) => me.permissions.includes(p)));
  usePoll(async () => { const r = await api<{ roles: RoleRow[] }>('GET', '/roles').catch(() => null); if (r) setRoles(r.roles); }, 60000);
  const [resetFor, setResetFor] = useState<UserRow | null>(null);
  const [pwFor, setPwFor] = useState<UserRow | null>(null);
  const [pwOwn, setPwOwn] = useState(false);
  const [pwVal, setPwVal] = useState('');
  const [pwRes, setPwRes] = useState<string | null>(null);
  const [pwDone, setPwDone] = useState(false);
  const [delFor, setDelFor] = useState<UserRow | null>(null);
  const [delEmail, setDelEmail] = useState('');
  const [panelMsg, setPanelMsg] = useState('');
  const panel = useRef<HTMLHeadingElement>(null);
  const openPw = (u: UserRow) => { setPwFor(u); setDelFor(null); setPwOwn(false); setPwVal(''); setPwRes(null); setPwDone(false); setPanelMsg(''); setTimeout(() => panel.current?.focus(), 0); };
  const openDel = (u: UserRow) => { setDelFor(u); setPwFor(null); setDelEmail(''); setPanelMsg(''); setTimeout(() => panel.current?.focus(), 0); };
  async function doReset(e: FormEvent) {
    e.preventDefault(); setPanelMsg('');
    try {
      const r = await api<{ temporaryPassword?: string }>('POST', `/users/${pwFor!.id}/reset-password`, pwOwn ? { password: pwVal } : {});
      setPwRes(r.temporaryPassword ?? null); setPwDone(true); setPwVal(''); await reload();
    } catch (er) { setPanelMsg(errText(er instanceof ApiError ? er.code : 'generic')); }
  }
  async function doDelete(e: FormEvent) {
    e.preventDefault(); setPanelMsg('');
    try { await api('DELETE', `/users/${delFor!.id}`, { email: delEmail.trim() }); setDelFor(null); await reload(); } catch (er) { setPanelMsg(errText(er instanceof ApiError ? er.code : 'generic')); }
  }

  const reload = async () => setUsers(await api<UserRow[]>('GET', '/users').catch(() => []));
  usePoll(reload, 15000);
  const run = async (fn: () => Promise<unknown>) => {
    setMsg('');
    try { await fn(); await reload(); } catch (e) { setMsg(errText(e instanceof ApiError ? e.code : 'generic')); }
  };

  async function create(e: FormEvent) {
    e.preventDefault();
    await run(() => api('POST', '/users', { ...f, username: f.username.trim() || undefined }));
    setF({ name: '', email: '', role: 'agent', password: '', username: '' });
  }

  return (
    <>
      <PageTitle art="team" title="צוות" />
      <p role="alert" className="error">{msg}</p>
      <div className="card" style={{ overflowX: 'auto' }}>
        <table>
          <caption className="sr-only">רשימת משתמשי המערכת</caption>
          <thead>
            <tr><th scope="col">שם</th><th scope="col">שם משתמש</th><th scope="col">אימייל</th><th scope="col">תפקיד</th><th scope="col">MFA</th><th scope="col">סטטוס</th>{isAdmin && <th scope="col">פעולות</th>}</tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <th scope="row"><span className="row" style={{ flexWrap: 'nowrap' }}><Avatar userId={u.id} name={u.name} v={u.avatarV} size={32} />{u.name}</span>
                  {isAdmin && assignable.some((r) => r.key === u.role) && <AvatarEditor compact userId={u.id} name={u.name} v={u.avatarV} uploadUrl={`/users/${u.id}/avatar`} onChanged={reload} />}
                  {heFor?.id === u.id ? (
                    <form className="row" onSubmit={async (e) => { e.preventDefault(); await run(() => api('PATCH', `/users/${u.id}`, { nameHe: heFor.value.trim() })); setHeFor(null); }}>
                      <label htmlFor={`he-${u.id}`} className="sr-only">השם בעברית של {u.name}</label>
                      <input id={`he-${u.id}`} maxLength={100} lang="he" style={{ maxWidth: 220 }} value={heFor.value} onChange={(e) => setHeFor({ ...heFor, value: e.target.value })} placeholder="למשל: דנה כהן" />
                      <button type="submit">שמירה</button><button type="button" onClick={() => setHeFor(null)}>ביטול</button>
                    </form>
                  ) : (
                    <small className="hint" style={{ display: 'block', fontWeight: 400 }}>{u.nameHe ? `בעברית: ${u.nameHe}` : 'בלי שם בעברית'}
                      {isAdmin && assignable.some((r) => r.key === u.role) && <button type="button" style={{ minHeight: 32, marginInlineStart: '.4rem' }} onClick={() => setHeFor({ id: u.id, value: u.nameHe ?? '' })}>שינוי<span className="sr-only"> השם בעברית של {u.name}</span></button>}</small>
                  )}
                  {jtFor?.id === u.id ? (
                    <form className="row" onSubmit={async (e) => { e.preventDefault(); await run(() => api('PATCH', `/users/${u.id}`, { jobTitle: jtFor.value })); setJtFor(null); }}>
                      <label htmlFor={`jt-${u.id}`} className="sr-only">התפקיד ש{u.name} מוצג/ת בו ללקוחות</label>
                      <input id={`jt-${u.id}`} maxLength={80} style={{ maxWidth: 220 }} value={jtFor.value} onChange={(e) => setJtFor({ ...jtFor, value: e.target.value })} placeholder="למשל: ממונה בטיחות" />
                      <button type="submit">שמירה</button><button type="button" onClick={() => setJtFor(null)}>ביטול</button>
                    </form>
                  ) : (
                    <small className="hint" style={{ display: 'block', fontWeight: 400 }}>{u.jobTitle || 'בלי תפקיד מוצג'}
                      {isAdmin && assignable.some((r) => r.key === u.role) && <button type="button" style={{ minHeight: 32, marginInlineStart: '.4rem' }} onClick={() => setJtFor({ id: u.id, value: u.jobTitle ?? '' })}>שינוי<span className="sr-only"> התפקיד המוצג של {u.name}</span></button>}</small>
                  )}</th>
                <td dir="ltr">
                  {unFor?.id === u.id ? (
                    <form className="row" onSubmit={async (e) => { e.preventDefault(); await run(() => api('PATCH', `/users/${u.id}`, { username: unFor.value })); setUnFor(null); }}>
                      <label htmlFor={`un-${u.id}`} className="sr-only">שם משתמש עבור {u.name}</label>
                      <input id={`un-${u.id}`} dir="ltr" required pattern="@?[A-Za-z0-9][A-Za-z0-9._\-]{1,28}[A-Za-z0-9]" style={{ maxWidth: 170 }} value={unFor.value} onChange={(e) => setUnFor({ ...unFor, value: e.target.value })} />
                      <button type="submit">שמירה</button><button type="button" onClick={() => setUnFor(null)}>ביטול</button>
                    </form>
                  ) : (
                    <>@{u.username}{isAdmin && assignable.some((r) => r.key === u.role) && <button type="button" style={{ minHeight: 32, marginInlineStart: '.4rem' }} onClick={() => setUnFor({ id: u.id, name: u.name, value: u.username ?? '' })}>שינוי<span className="sr-only"> שם המשתמש של {u.name}</span></button>}</>
                  )}
                </td>
                <td dir="ltr">{u.email}</td>
                <td>
                  {isAdmin ? (
                    <select aria-label={`תפקיד עבור ${u.name}`} value={u.role} disabled={u.id === meId || !assignable.some((r) => r.key === u.role)}
                      onChange={(e) => run(() => api('PATCH', `/users/${u.id}`, { role: e.target.value }))}>
                      {assignable.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
                    </select>
                  ) : (roles.find((r) => r.key === u.role)?.name ?? u.role)}
                </td>
                <td>{u.mfaEnabled ? 'פעיל' : 'כבוי'}</td>
                <td>{u.active ? 'פעיל' : 'מושבת'}</td>
                {isAdmin && (
                  <td>
                    <div className="row">
                      <button disabled={u.id === meId || !assignable.some((r) => r.key === u.role)} onClick={() => run(() => api('PATCH', `/users/${u.id}`, { active: !u.active }))}>
                        {u.active ? 'השבתה' : 'הפעלה'}<span className="sr-only"> {u.name}</span>
                      </button>
                      {u.mfaEnabled && <button onClick={() => setResetFor(u)}>איפוס MFA<span className="sr-only"> {u.name}</span></button>}
                      <button disabled={u.id === meId || !assignable.some((r) => r.key === u.role)} onClick={() => openPw(u)}>איפוס סיסמה<span className="sr-only"> {u.name}</span></button>
                      <button className="danger" disabled={u.id === meId || !assignable.some((r) => r.key === u.role)} onClick={() => openDel(u)}>מחיקה<span className="sr-only"> {u.name}</span></button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {isAdmin && <AvatarGalleryAdmin />}

      {pwFor && (
        <section className="card" aria-labelledby="pw-h">
          <h2 id="pw-h" ref={panel} tabIndex={-1}>איפוס סיסמה: {pwFor.name}</h2>
          {!pwDone ? (
            <form onSubmit={doReset}>
              <p className="hint">הסיסמה הנוכחית תתבטל והמשתמש ינותק מכל המכשירים. אם החשבון נעול בגלל ניסיונות כושלים, הנעילה תוסר. בכניסה הבאה יידרש לבחור סיסמה חדשה משלו.</p>
              <div className="field"><label><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={pwOwn} onChange={(e) => setPwOwn(e.target.checked)} /> אבחר את הסיסמה הזמנית בעצמי (אחרת תיווצר אוטומטית)</label></div>
              {pwOwn && <div className="field"><label htmlFor="pw-own">סיסמה זמנית (לפחות 12 תווים)</label><input id="pw-own" type="password" required minLength={12} maxLength={256} autoComplete="new-password" dir="ltr" value={pwVal} onChange={(e) => setPwVal(e.target.value)} /></div>}
              <div className="row"><button className="primary" type="submit">איפוס</button><button type="button" onClick={() => setPwFor(null)}>ביטול</button></div>
            </form>
          ) : (
            <div role="status">
              <p>הסיסמה אופסה והמשתמש נותק.</p>
              {pwRes ? (
                <>
                  <p>סיסמה זמנית (מוצגת פעם אחת בלבד, מסרו אותה בערוץ מאובטח):</p>
                  <p><code dir="ltr" style={{ fontSize: '1.2rem', userSelect: 'all' }}>{pwRes}</code> <button type="button" onClick={() => void navigator.clipboard?.writeText(pwRes)}>העתקה</button></p>
                </>
              ) : <p>הסיסמה שבחרתם נשמרה. מסרו אותה בערוץ מאובטח.</p>}
              <button type="button" onClick={() => { setPwFor(null); setPwRes(null); }}>סגירה</button>
            </div>
          )}
          <p role="alert" className="error">{panelMsg}</p>
        </section>
      )}

      {delFor && (
        <section className="card" aria-labelledby="del-h">
          <h2 id="del-h" ref={panel} tabIndex={-1}>מחיקת משתמש: {delFor.name}</h2>
          <form onSubmit={doDelete}>
            <p>החשבון יימחק לצמיתות. השיחות שלו יישארו (בלי שיוך), וההערות וההודעות שכתב יישארו בלי שם. אי אפשר לשחזר. אם רק רוצים להפסיק את הגישה, "השבתה" מספיקה וניתנת לביטול.</p>
            <div className="field"><label htmlFor="del-em">לאישור, הקלידו את האימייל <span dir="ltr">{delFor.email}</span></label><input id="del-em" required dir="ltr" autoComplete="off" value={delEmail} onChange={(e) => setDelEmail(e.target.value)} /></div>
            <div className="row"><button className="danger" type="submit" disabled={delEmail.trim().toLowerCase() !== delFor.email.toLowerCase()}>מחיקה לצמיתות</button><button type="button" onClick={() => setDelFor(null)}>ביטול</button></div>
          </form>
          <p role="alert" className="error">{panelMsg}</p>
        </section>
      )}

      {isAdmin && (
        <form className="card" onSubmit={create}>
          <h2>משתמש חדש</h2>
          <div className="field"><label htmlFor="u-name">שם</label><input id="u-name" required maxLength={100} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div className="field"><label htmlFor="u-un">שם משתמש (אופציונלי; אם ריק נוצר מהאימייל)</label><input id="u-un" dir="ltr" pattern="@?[A-Za-z0-9][A-Za-z0-9._\-]{1,28}[A-Za-z0-9]" aria-describedby="u-un-h" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /><p id="u-un-h" className="hint">אותיות באנגלית, ספרות, נקודה, מקף או קו תחתון. משמש לבחירת ממונים ובתרשימים, למשל @dana.</p></div>
          <div className="field"><label htmlFor="u-email">אימייל</label><input id="u-email" type="email" required dir="ltr" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
          <div className="field">
            <label htmlFor="u-role">תפקיד</label>
            <select id="u-role" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
              {assignable.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="u-pw">סיסמה ראשונית</label>
            <input id="u-pw" type="password" required minLength={12} autoComplete="new-password" dir="ltr" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} aria-describedby="u-pw-h" />
            <p id="u-pw-h" className="hint">לפחות 12 תווים. מסרו אותה בערוץ מאובטח ובקשו מהמשתמש להחליף אותה.</p>
          </div>
          <button className="primary" type="submit">יצירת משתמש</button>
        </form>
      )}

      <ConfirmDialog open={!!resetFor} danger title="איפוס אימות דו-שלבי"
        message={`האימות הדו-שלבי של ${resetFor?.name ?? ''} יבוטל והמשתמש ינותק מכל המכשירים.`}
        onCancel={() => setResetFor(null)}
        onConfirm={() => { const u = resetFor!; setResetFor(null); void run(() => api('POST', `/users/${u.id}/reset-mfa`)); }} />
    </>
  );
}

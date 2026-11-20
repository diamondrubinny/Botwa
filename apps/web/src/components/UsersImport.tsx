import { useState } from 'react';
import { ApiError, api, type RoleRow } from '../api';
import { errText } from '../strings';

interface PRow { row: number; name: string; email: string; jobTitle: string | null; role: string | null; roleText: string | null; exists: boolean; pick: boolean }
interface Preview { rows: PRow[]; invalid: { row: number; reason: string; value: string }[]; columns: Record<string, string | null>; headerFound: boolean }
const WHY: Record<string, string> = { missing_name: 'חסר שם', missing_email: 'חסר אימייל', bad_email: 'אימייל לא תקין', duplicate: 'אימייל שמופיע פעמיים' };

/** A strong first password that is still easy to dictate: four groups of letters and digits, no look-alike characters. */
export function strongPassword(): string {
  const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const r = crypto.getRandomValues(new Uint32Array(16));
  const s = [...r].map((x) => abc[x % abc.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}`;
}

/** Many people at once from a workbook: preview, choose, one first password for all (changed at the first sign-in), create. */
export function UsersImport({ assignable, onDone }: { assignable: RoleRow[]; onDone: () => void }) {
  const [pv, setPv] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pw, setPw] = useState('');
  const [show, setShow] = useState(false);
  const [defRolePick, setDefRole] = useState('');
  // the roles arrive after the first render: fall back to "agent" (or the first role I may hand out) until one is chosen
  const defRole = assignable.some((r) => r.key === defRolePick) ? defRolePick : assignable.find((r) => r.key === 'agent')?.key ?? assignable[0]?.key ?? '';
  const [updateExisting, setUpdateExisting] = useState(false);
  const roleOk = (k: string | null) => !k || assignable.some((r) => r.key === k);
  const chosen = pv?.rows.filter((r) => r.pick && (!r.exists || updateExisting)) ?? [];

  async function read(f: File) {
    setBusy(true); setMsg(null); setPv(null);
    try {
      const fd = new FormData(); fd.append('file', f);
      const res = await fetch('/users/import/preview', { method: 'POST', credentials: 'same-origin', body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(res.status, (j as { error?: string }).error ?? 'error');
      const p = j as Omit<Preview, 'rows'> & { rows: Omit<PRow, 'pick'>[] };
      setPv({ ...p, rows: p.rows.map((r) => ({ ...r, role: roleOk(r.role) ? r.role : null, pick: !r.exists })) });
    } catch (e) { setMsg({ ok: false, text: errText(e instanceof ApiError ? e.code : 'generic') }); }
    finally { setBusy(false); }
  }

  async function create() {
    if (!pv || !chosen.length || pw.length < 12) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api<{ created: number; updated: number; skipped: { email: string }[] }>('POST', '/users/import', {
        password: pw, defaultRole: defRole, updateExisting,
        rows: chosen.map((x) => ({ name: x.name, email: x.email, jobTitle: x.jobTitle, role: x.role })),
      });
      setMsg({ ok: true, text: `נוצרו ${r.created} משתמשים${r.updated ? `, עודכן התפקיד של ${r.updated} קיימים` : ''}${r.skipped.length ? `, ${r.skipped.length} דולגו (כבר קיימים)` : ''}. כולם יתבקשו להחליף את הסיסמה בכניסה הראשונה.` });
      setPv(null); onDone();
    } catch (e) { setMsg({ ok: false, text: errText(e instanceof ApiError ? e.code : 'generic') }); }
    finally { setBusy(false); }
  }

  const setRow = (i: number, p: Partial<PRow>) => setPv((v) => (v ? { ...v, rows: v.rows.map((r, k) => (k === i ? { ...r, ...p } : r)) } : v));

  return (
    <section className="card" aria-labelledby="ui-h">
      <h2 id="ui-h">יצירת משתמשים מקובץ אקסל</h2>
      <p className="hint">העלו קובץ xlsx עם עמודות שם, אימייל ותפקיד, ואם רוצים גם עמודת הרשאה (נציג, מפקח או מנהל). המערכת מזהה את העמודות לבד, בעברית או באנגלית, גם בלי שורת כותרת. אפשר להתחיל מ<a href="/users/import/template.xlsx" download>קובץ הדוגמה</a>.</p>
      <div className="field"><label htmlFor="ui-file">קובץ אקסל (xlsx)</label>
        <input id="ui-file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) void read(f); e.target.value = ''; }} /></div>
      {busy && !pv && <p role="status">קורא את הקובץ…</p>}

      {pv && (
        <>
          <p role="status">נמצאו {pv.rows.length} אנשים{pv.invalid.length ? `, ו-${pv.invalid.length} שורות שלא ניתן לייבא` : ''}. עמודות שזוהו: שם: {pv.columns.name ?? '—'}, אימייל: {pv.columns.email ?? '—'}, תפקיד: {pv.columns.title ?? '—'}{pv.columns.role ? `, הרשאה: ${pv.columns.role}` : ''}.</p>
          <div style={{ overflowX: 'auto' }}>
            <table>
              <caption className="sr-only">האנשים שנמצאו בקובץ</caption>
              <thead><tr><th scope="col">ליצור</th><th scope="col">שם</th><th scope="col">אימייל</th><th scope="col">תפקיד</th><th scope="col">הרשאה</th><th scope="col">מצב</th></tr></thead>
              <tbody>
                {pv.rows.map((r, i) => (
                  <tr key={r.email}>
                    <td><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={r.pick} disabled={r.exists && !updateExisting} onChange={(e) => setRow(i, { pick: e.target.checked })} aria-label={`ליצור את ${r.name}`} /></td>
                    <th scope="row">{r.name}</th>
                    <td dir="ltr">{r.email}</td>
                    <td>{r.jobTitle ?? '—'}</td>
                    <td><select aria-label={`הרשאה עבור ${r.name}`} value={r.role ?? ''} onChange={(e) => setRow(i, { role: e.target.value || null })}>
                      <option value="">ברירת המחדל</option>{assignable.map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}</select>
                      {r.roleText && !r.role && <small className="hint" style={{ display: 'block' }}>"{r.roleText}" לא זוהה</small>}</td>
                    <td>{r.exists ? 'כבר קיים' : 'חדש'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pv.invalid.length > 0 && (
            <details><summary>שורות שלא ייובאו ({pv.invalid.length})</summary>
              <ul>{pv.invalid.map((x) => <li key={`${x.row}-${x.value}`}>שורה {x.row}: {WHY[x.reason] ?? x.reason} <span dir="ltr">{x.value}</span></li>)}</ul></details>
          )}
          <div className="grid2">
            <div className="field"><label htmlFor="ui-role">הרשאת ברירת מחדל</label>
              <select id="ui-role" value={defRole} onChange={(e) => setDefRole(e.target.value)}>{assignable.map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}</select></div>
            <div className="field"><label htmlFor="ui-pw">סיסמה ראשונית אחת לכולם (לפחות 12 תווים)</label>
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <input id="ui-pw" type={show ? 'text' : 'password'} dir="ltr" minLength={12} maxLength={256} autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} aria-describedby="ui-pw-h" />
                <button type="button" onClick={() => setShow(!show)} aria-pressed={show}>{show ? 'הסתרה' : 'הצגה'}</button>
                <button type="button" onClick={() => { setPw(strongPassword()); setShow(true); }}>סיסמה חזקה</button>
              </div>
              <p id="ui-pw-h" className="hint">כל משתמש חייב להחליף אותה בכניסה הראשונה. מסרו אותה בערוץ נפרד מהאימייל (למשל בטלפון), לא בקובץ ולא בהודעה קבוצתית.</p></div>
          </div>
          <label className="row" style={{ fontWeight: 400 }}><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={updateExisting} onChange={(e) => setUpdateExisting(e.target.checked)} /> לעדכן את התפקיד של משתמשים שכבר קיימים (בלי לשנות את הסיסמה או ההרשאה שלהם)</label>
          <div className="row">
            <button className="primary" type="button" disabled={busy || !chosen.length || pw.length < 12 || !defRole} onClick={() => void create()}>{busy ? 'יוצר…' : `יצירת ${chosen.length} משתמשים`}</button>
            <button type="button" onClick={() => setPv(null)}>ביטול</button>
          </div>
        </>
      )}
      {msg && <p role="status" className={msg.ok ? 'ok' : 'error'}>{msg.text}</p>}
    </section>
  );
}

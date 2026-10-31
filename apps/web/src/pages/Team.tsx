import { useState, type FormEvent } from 'react';
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
  const [f, setF] = useState({ name: '', email: '', role: 'agent', password: '' });
  // you can only hand out roles whose permissions you hold yourself
  const assignable = roles.filter((r) => r.permissions.every((p) => me.permissions.includes(p)));
  usePoll(async () => { const r = await api<{ roles: RoleRow[] }>('GET', '/roles').catch(() => null); if (r) setRoles(r.roles); }, 60000);
  const [resetFor, setResetFor] = useState<UserRow | null>(null);

  const reload = async () => setUsers(await api<UserRow[]>('GET', '/users').catch(() => []));
  usePoll(reload, 15000);
  const run = async (fn: () => Promise<unknown>) => {
    setMsg('');
    try { await fn(); await reload(); } catch (e) { setMsg(errText(e instanceof ApiError ? e.code : 'generic')); }
  };

  async function create(e: FormEvent) {
    e.preventDefault();
    await run(() => api('POST', '/users', f));
    setF({ name: '', email: '', role: 'agent', password: '' });
  }

  return (
    <>
      <h1 tabIndex={-1}>צוות</h1>
      <p role="alert" className="error">{msg}</p>
      <div className="card" style={{ overflowX: 'auto' }}>
        <table>
          <caption className="sr-only">רשימת משתמשי המערכת</caption>
          <thead>
            <tr><th scope="col">שם</th><th scope="col">אימייל</th><th scope="col">תפקיד</th><th scope="col">MFA</th><th scope="col">סטטוס</th>{isAdmin && <th scope="col">פעולות</th>}</tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <th scope="row">{u.name}</th>
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
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {isAdmin && (
        <form className="card" onSubmit={create}>
          <h2>משתמש חדש</h2>
          <div className="field"><label htmlFor="u-name">שם</label><input id="u-name" required maxLength={100} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
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

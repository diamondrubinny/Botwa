import { PageTitle } from '../components/Illustration';
import { useState, type FormEvent } from 'react';
import { api, ApiError, type Me, type RoleRow } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Icon } from '../components/Icon';
import { usePoll } from '../hooks';
import { PERM_GROUPS } from '../permLabels';
import { errText } from '../strings';

interface Draft { key: string | null; name: string; permissions: string[]; mfaRequired: boolean }
const EMPTY: Draft = { key: null, name: '', permissions: [], mfaRequired: false };

export function Roles({ me }: { me: Me }) {
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [msg, setMsg] = useState('');
  const [del, setDel] = useState<RoleRow | null>(null);
  const reload = async () => { const r = await api<{ roles: RoleRow[] }>('GET', '/roles').catch(() => null); if (r) setRoles(r.roles); };
  usePoll(reload, 30000);
  const run = async (fn: () => Promise<unknown>) => { setMsg(''); try { await fn(); await reload(); } catch (e) { setMsg(errText(e instanceof ApiError ? e.code : 'generic')); } };

  const toggle = (p: string) => draft && setDraft({ ...draft, permissions: draft.permissions.includes(p) ? draft.permissions.filter((x) => x !== p) : [...draft.permissions, p] });
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    const body = { name: draft.name, permissions: draft.permissions, mfaRequired: draft.mfaRequired };
    await run(() => (draft.key ? api('PATCH', `/roles/${draft.key}`, body) : api('POST', '/roles', body)));
    setDraft(null);
  }

  return (
    <>
      <PageTitle art="safety" title="תפקידים והרשאות" />
      <p className="hint">תפקיד הוא קבוצת הרשאות. התפקידים המובנים (מנהל, מפקח, נציג) קבועים; אפשר ליצור תפקידים משלכם. אי אפשר להעניק הרשאה שאינה בידיכם.</p>
      <p role="alert" className="error">{msg}</p>

      <div className="card" style={{ overflowX: 'auto' }}>
        <table>
          <caption className="sr-only">תפקידים במערכת</caption>
          <thead><tr><th scope="col">תפקיד</th><th scope="col">הרשאות</th><th scope="col">משתמשים</th><th scope="col">אימות דו-שלבי</th><th scope="col">פעולות</th></tr></thead>
          <tbody>
            {roles.map((r) => (
              <tr key={r.key}>
                <th scope="row">{r.name}{r.builtin && <small className="hint"> (מובנה)</small>}</th>
                <td>{r.permissions.length === 0 ? 'ללא הרשאות מיוחדות' : `${r.permissions.length} הרשאות`}</td>
                <td>{r.userCount}</td>
                <td>{r.mfaRequired ? 'נדרש' : 'לא נדרש'}</td>
                <td>
                  <div className="row">
                    {!r.builtin && <button onClick={() => setDraft({ key: r.key, name: r.name, permissions: r.permissions, mfaRequired: r.mfaRequired })}>עריכה<span className="sr-only"> {r.name}</span></button>}
                    {!r.builtin && <button className="danger" onClick={() => setDel(r)}>מחיקה<span className="sr-only"> {r.name}</span></button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!draft && <button className="primary" onClick={() => setDraft({ ...EMPTY })}><Icon name="plus" size={18} />תפקיד חדש</button>}

      {draft && (
        <form className="card" onSubmit={save} aria-labelledby="role-form-h">
          <h2 id="role-form-h">{draft.key ? 'עריכת תפקיד' : 'תפקיד חדש'}</h2>
          <div className="field">
            <label htmlFor="r-name">שם התפקיד</label>
            <input id="r-name" required maxLength={40} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </div>
          {PERM_GROUPS.map((g) => (
            <fieldset key={g.title} style={{ border: '1px solid var(--border)', borderRadius: 10, marginBottom: '.75rem' }}>
              <legend>{g.title}</legend>
              <div className="perm-grid">
                {g.items.map(([k, label]) => {
                  const mine = me.permissions.includes(k);
                  return (
                    <label key={k}>
                      <input type="checkbox" checked={draft.permissions.includes(k)} onChange={() => toggle(k)} disabled={!mine && !draft.permissions.includes(k)} />
                      <span>{label}{!mine && <small className="hint"> (אינה בידיכם)</small>}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}
          <div className="field">
            <label><input type="checkbox" style={{ width: 'auto', minHeight: 0, marginInlineEnd: '.5rem' }} checked={draft.mfaRequired} onChange={(e) => setDraft({ ...draft, mfaRequired: e.target.checked })} />לחייב אימות דו-שלבי או Passkey לתפקיד הזה</label>
          </div>
          <div className="row"><button className="primary" type="submit">שמירה</button><button type="button" onClick={() => setDraft(null)}>ביטול</button></div>
        </form>
      )}

      <ConfirmDialog open={!!del} danger title="מחיקת תפקיד" message={`התפקיד "${del?.name ?? ''}" יימחק. אי אפשר למחוק תפקיד שיש בו משתמשים.`} onCancel={() => setDel(null)}
        onConfirm={() => { const r = del!; setDel(null); void run(() => api('DELETE', `/roles/${r.key}`)); }} />
    </>
  );
}

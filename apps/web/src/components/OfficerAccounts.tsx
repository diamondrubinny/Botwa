import { useEffect, useState } from 'react';
import { ApiError, api, type RoleRow } from '../api';
import { errText } from '../strings';
import { strongPassword } from './UsersImport';

interface Plan { create: { name: string; email: string }[]; link: { name: string; email: string }[]; noEmail: { name: string }[]; inactive: { name: string; email: string }[] }

/**
 * One click: an account for every active officer who has an e-mail and no account yet, all with the same first password
 * (changed at the first sign-in); an officer whose e-mail already has an account is linked to it.
 */
export function OfficerAccounts({ me, onDone }: { me: { permissions: string[] }; onDone: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [role, setRole] = useState('');
  const [pw, setPw] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const assignable = roles.filter((r) => r.permissions.every((p) => me.permissions.includes(p)));
  const chosenRole = assignable.some((r) => r.key === role) ? role : assignable.find((r) => r.key === 'agent')?.key ?? assignable[0]?.key ?? '';

  async function load() {
    try { setPlan(await api<Plan>('GET', '/safety/officers/accounts')); } catch (e) { setMsg({ ok: false, text: errText(e instanceof ApiError ? e.code : 'generic') }); }
  }
  useEffect(() => {
    if (!open) return;
    void load();
    void api<{ roles: RoleRow[] }>('GET', '/roles').then((r) => setRoles(r.roles)).catch(() => setRoles([]));
  }, [open]);

  async function run() {
    if (!plan || pw.length < 12 || !chosenRole) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api<{ created: number; linked: number; noEmail: string[]; inactive: string[] }>('POST', '/safety/officers/accounts', { password: pw, role: chosenRole });
      const extra = [
        r.noEmail.length ? `בלי אימייל ולכן בלי חשבון: ${r.noEmail.join(', ')}.` : '',
        r.inactive.length ? `יש חשבון מושבת לאימייל: ${r.inactive.join(', ')} (מפעילים אותו בעמוד הצוות).` : '',
      ].filter(Boolean).join(' ');
      setMsg({ ok: true, text: `נוצרו ${r.created} חשבונות${r.linked ? `, ו-${r.linked} ממונים קושרו לחשבון שכבר היה להם` : ''}. כל אחד נכנס עם האימייל שלו והסיסמה הראשונית, ויתבקש להחליף אותה מיד.${extra ? ` ${extra}` : ''}` });
      setPw('');
      await onDone();
      await load();
    } catch (e) { setMsg({ ok: false, text: errText(e instanceof ApiError ? e.code : 'generic') }); }
    setBusy(false);
  }

  const total = (plan?.create.length ?? 0) + (plan?.link.length ?? 0);
  return (
    <section className="card" aria-labelledby="oa-h" style={{ marginTop: '.75rem' }}>
      <h3 id="oa-h">חשבונות לממונים</h3>
      <p className="hint">בקליק אחד: כל ממונה פעיל שיש לו אימייל ועוד אין לו חשבון מקבל חשבון במערכת, וכולם עם אותה סיסמה ראשונית שחייבים להחליף בכניסה הראשונה. ממונה שכבר יש חשבון עם האימייל שלו מקושר אליו. מרגע זה השיחות בנושאים שלו משויכות אליו.</p>
      {!open ? <button type="button" onClick={() => setOpen(true)} aria-expanded={false}>יצירת חשבונות לממונים בלי חשבון</button> : (
        <>
          {!plan ? <p role="status">בודק…</p> : (
            <>
              {total === 0 ? <p className="ok">לכל הממונים הפעילים שיש להם אימייל כבר יש חשבון.</p> : (
                <>
                  {plan.create.length > 0 && <><p>ייווצרו {plan.create.length} חשבונות חדשים:</p><ul>{plan.create.map((o) => <li key={o.email}>{o.name} (<bdi dir="ltr">{o.email}</bdi>)</li>)}</ul></>}
                  {plan.link.length > 0 && <><p>יקושרו לחשבון שכבר קיים ({plan.link.length}):</p><ul>{plan.link.map((o, i) => <li key={`${o.email}-${i}`}>{o.name} (<bdi dir="ltr">{o.email}</bdi>)</li>)}</ul></>}
                </>
              )}
              {plan.noEmail.length > 0 && <p className="hint">בלי אימייל (אי אפשר ליצור להם חשבון, מוסיפים אימייל בעריכה): {plan.noEmail.map((o) => o.name).join(', ')}.</p>}
              {plan.inactive.length > 0 && <p className="hint">יש חשבון מושבת לאימייל של: {plan.inactive.map((o) => o.name).join(', ')}. מפעילים אותו בעמוד הצוות ומקשרים בעריכה.</p>}
              {total > 0 && (
                <form onSubmit={(e) => { e.preventDefault(); void run(); }}>
                  <div className="field"><label htmlFor="oa-pw">סיסמה ראשונית אחת לכולם (לפחות 12 תווים)</label>
                    <div className="row">
                      <input id="oa-pw" type={show ? 'text' : 'password'} dir="ltr" minLength={12} maxLength={256} required autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} aria-describedby="oa-pw-h" />
                      <button type="button" onClick={() => setShow(!show)} aria-pressed={show}>{show ? 'הסתרה' : 'הצגה'}</button>
                      <button type="button" onClick={() => { setPw(strongPassword()); setShow(true); }}>יצירת סיסמה</button>
                    </div>
                    <p id="oa-pw-h" className="hint">כל אחד חייב להחליף אותה בכניסה הראשונה. מסרו אותה בערוץ נפרד מהאימייל (למשל בטלפון), לא בהודעה קבוצתית.</p></div>
                  <div className="field"><label htmlFor="oa-role">תפקיד במערכת</label>
                    <select id="oa-role" value={chosenRole} onChange={(e) => setRole(e.target.value)}>{assignable.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}</select></div>
                  <div className="row">
                    <button className="primary" type="submit" disabled={busy || pw.length < 12 || !chosenRole}>{busy ? 'יוצר…' : plan.create.length ? `יצירת ${plan.create.length} חשבונות` : 'קישור לחשבונות הקיימים'}</button>
                    <button type="button" onClick={() => { setOpen(false); setMsg(null); }}>סגירה</button>
                  </div>
                </form>
              )}
            </>
          )}
        </>
      )}
      <p role="status" className={msg ? (msg.ok ? 'ok' : 'error') : undefined}>{msg?.text}</p>
    </section>
  );
}

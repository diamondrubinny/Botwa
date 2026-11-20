import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, personLabel } from '../api';
import { usePoll } from '../hooks';
import { errText } from '../strings';

/**
 * Periodic inspections ("בדיקת מטפים בבניין X כל חצי שנה"): what, where, every how many days, who is responsible, when it is due.
 * "בוצע" logs it and moves the due date on. Reminders go to the person responsible a week before and while overdue.
 */
export interface Inspection { id: string; title: string; place: string; intervalDays: number; nextDue: string; assignee: string | null; assigneeName: string | null; notes: string; active: boolean; lastDoneAt: string | null; lastDoneBy: string | null; status: 'overdue' | 'soon' | 'ok' | 'off'; daysLeft: number }
const STATUS: Record<Inspection['status'], string> = { overdue: '⚠️ באיחור', soon: '⏳ מתקרבת', ok: '✅ בזמן', off: 'מושבתת' };
const when = (i: Inspection) => (i.status === 'off' ? '—' : i.daysLeft < 0 ? `באיחור של ${-i.daysLeft} ימים` : i.daysLeft === 0 ? 'היום' : `בעוד ${i.daysLeft} ימים`);
const dmy = (d: string) => d.split('-').reverse().join('/');
const EVERY: [number, string][] = [[7, 'כל שבוע'], [30, 'כל חודש'], [90, 'כל רבעון'], [182, 'כל חצי שנה'], [365, 'כל שנה']];

function DoneButton({ i, onDone }: { i: Inspection; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  if (!open) return <button type="button" className="sm" onClick={() => setOpen(true)}>בוצע<span className="sr-only"> – {i.title}</span></button>;
  return (
    <form onSubmit={async (e) => { e.preventDefault(); try { await api('POST', `/inspections/${i.id}/done`, { note }); setOpen(false); setNote(''); onDone(); } catch (x) { setErr(errText(x instanceof ApiError ? x.code : 'generic')); } }}>
      <label className="sr-only" htmlFor={`dn-${i.id}`}>הערה לביצוע (אופציונלי)</label>
      <input id={`dn-${i.id}`} placeholder="הערה (אופציונלי)" maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
      <button type="submit" className="primary sm">שמירת ביצוע</button> <button type="button" className="ghost sm" onClick={() => setOpen(false)}>ביטול</button>
      {err && <span role="alert" className="error"> {err}</span>}
    </form>
  );
}

export function Inspections({ canEdit }: { canEdit: boolean }) {
  const [list, setList] = useState<Inspection[] | null>(null);
  const [users, setUsers] = useState<{ id: string; name: string; username?: string }[]>([]);
  const [edit, setEdit] = useState<Partial<Inspection> | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = async () => { setList(await api<Inspection[]>('GET', '/inspections').catch(() => [])); };
  usePoll(async () => { await load(); if (canEdit && !users.length) setUsers((await api<{ users: { id: string; name: string; username?: string }[] }>('GET', '/flow/refs').catch(() => ({ users: [] }))).users); }, 60000);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!edit) return;
    const body = { title: edit.title ?? '', place: edit.place ?? '', intervalDays: Number(edit.intervalDays) || 182, nextDue: edit.nextDue ?? '', assignee: edit.assignee || null, notes: edit.notes ?? '', active: edit.active ?? true };
    try {
      if (edit.id) await api('PUT', `/inspections/${edit.id}`, body); else await api('POST', '/inspections', body);
      setEdit(null); setMsg({ ok: true, text: 'הבדיקה נשמרה.' }); await load();
    } catch (x) { setMsg({ ok: false, text: errText(x instanceof ApiError ? x.code : 'generic') }); }
  };
  const del = async (i: Inspection) => { if (!confirm(`למחוק את הבדיקה "${i.title}" ואת היומן שלה?`)) return; await api('DELETE', `/inspections/${i.id}`).catch(() => undefined); await load(); };
  const overdue = (list ?? []).filter((i) => i.status === 'overdue').length;
  // opened by itself once when something is overdue; after that the person decides
  const box = useRef<HTMLDetailsElement>(null);
  const autoOpened = useRef(false);
  useEffect(() => { if (overdue > 0 && box.current && !autoOpened.current) { box.current.open = true; autoOpened.current = true; } }, [overdue]);

  return (
    <details className="card" id="insp" style={{ marginTop: '1rem' }} ref={box}>
      <summary><h2 id="insp-h" style={{ display: 'inline' }}>בדיקות תקופתיות</h2>{overdue > 0 && <span className="badge"> {overdue} באיחור</span>}</summary>
      <p className="hint">בדיקות שחוזרות על עצמן, למשל מטפים, מקלחות חירום, ארונות כימיקלים או סולמות. כל אחראי מקבל תזכורת שבוע לפני מועד הבדיקה וכל יום שהיא באיחור: התראה, והודעה בווצאפ אם קישר אותו לבטי. "בוצע" רושם מי ביצע ומתי, ומחשב את המועד הבא.</p>
      {!list ? <p className="hint">טוען…</p> : list.length === 0 ? <p className="hint">אין עדיין בדיקות תקופתיות.</p> : (
        <table>
          <caption className="sr-only">בדיקות תקופתיות</caption>
          <thead><tr><th scope="col">בדיקה</th><th scope="col">מיקום</th><th scope="col">תדירות</th><th scope="col">מועד</th><th scope="col">מצב</th><th scope="col">אחראי</th><th scope="col">בוצע לאחרונה</th><th scope="col">פעולות</th></tr></thead>
          <tbody>{list.map((i) => (
            <tr key={i.id}>
              <th scope="row">{i.title}{i.notes && <div className="hint">{i.notes}</div>}</th>
              <td>{i.place || '—'}</td>
              <td>{EVERY.find(([d]) => d === i.intervalDays)?.[1] ?? `כל ${i.intervalDays} ימים`}</td>
              <td>{dmy(i.nextDue)}<div className="hint">{when(i)}</div></td>
              <td>{STATUS[i.status]}</td>
              <td>{i.assigneeName ?? <span className="hint">בלי אחראי</span>}</td>
              <td>{i.lastDoneAt ? `${new Date(i.lastDoneAt).toLocaleDateString('he-IL')}${i.lastDoneBy ? `, ${i.lastDoneBy}` : ''}` : '—'}</td>
              <td>
                {i.active && <DoneButton i={i} onDone={() => void load()} />}
                {canEdit && <> <button type="button" className="ghost sm" onClick={() => setEdit(i)}>עריכה<span className="sr-only"> – {i.title}</span></button> <button type="button" className="ghost sm" onClick={() => void del(i)}>מחיקה<span className="sr-only"> – {i.title}</span></button></>}
              </td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {canEdit && !edit && <p><button type="button" onClick={() => setEdit({ intervalDays: 182, nextDue: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10), active: true })}>+ בדיקה חדשה</button></p>}
      {canEdit && edit && (
        <form className="card" onSubmit={save} aria-labelledby="insp-f">
          <h3 id="insp-f">{edit.id ? 'עריכת בדיקה' : 'בדיקה חדשה'}</h3>
          <div className="field"><label htmlFor="in-t">מה בודקים</label><input id="in-t" required minLength={2} maxLength={120} value={edit.title ?? ''} onChange={(e) => setEdit({ ...edit, title: e.target.value })} placeholder="בדיקת מטפים" /></div>
          <div className="field"><label htmlFor="in-p">בניין / מיקום</label><input id="in-p" maxLength={120} value={edit.place ?? ''} onChange={(e) => setEdit({ ...edit, place: e.target.value })} /></div>
          <div className="field"><label htmlFor="in-i">כל כמה זמן</label>
            <select id="in-i" value={EVERY.some(([d]) => d === edit.intervalDays) ? String(edit.intervalDays) : 'other'} onChange={(e) => setEdit({ ...edit, intervalDays: e.target.value === 'other' ? 60 : Number(e.target.value) })}>
              {EVERY.map(([d, l]) => <option key={d} value={d}>{l}</option>)}<option value="other">אחר (בימים)</option>
            </select>
          </div>
          {!EVERY.some(([d]) => d === edit.intervalDays) && <div className="field"><label htmlFor="in-d">כל כמה ימים</label><input id="in-d" type="number" min={1} max={3650} value={edit.intervalDays ?? 60} onChange={(e) => setEdit({ ...edit, intervalDays: Number(e.target.value) })} /></div>}
          <div className="field"><label htmlFor="in-n">מועד הבדיקה הבא</label><input id="in-n" type="date" required value={edit.nextDue ?? ''} onChange={(e) => setEdit({ ...edit, nextDue: e.target.value })} /></div>
          <div className="field"><label htmlFor="in-a">אחראי</label>
            <select id="in-a" value={edit.assignee ?? ''} onChange={(e) => setEdit({ ...edit, assignee: e.target.value || null })}><option value="">בלי אחראי</option>{users.map((u) => <option key={u.id} value={u.id}>{personLabel(u)}</option>)}</select>
          </div>
          <div className="field"><label htmlFor="in-o">הערות</label><textarea id="in-o" rows={2} maxLength={1000} value={edit.notes ?? ''} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></div>
          <div className="field"><label><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={edit.active ?? true} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> פעילה (מקבלת תזכורות)</label></div>
          <button type="submit" className="primary">שמירה</button> <button type="button" className="ghost" onClick={() => setEdit(null)}>ביטול</button>
        </form>
      )}
      <p role="status" className={msg?.ok ? 'ok' : 'error'}>{msg?.text}</p>
    </details>
  );
}

/** My account: the inspections I am responsible for (also for people without the SafetyBoard), with "בוצע". */
export function MyInspections({ userId }: { userId: string }) {
  const [list, setList] = useState<Inspection[] | null>(null);
  const load = async () => { setList((await api<Inspection[]>('GET', '/inspections').catch(() => [])).filter((i) => i.assignee === userId && i.active)); };
  usePoll(load, 60000);
  if (!list || list.length === 0) return null;
  return (
    <section className="card" aria-labelledby="my-insp">
      <h2 id="my-insp">הבדיקות שלי</h2>
      <ul style={{ listStyle: 'none', padding: 0 }}>{list.map((i) => (
        <li key={i.id} style={{ borderTop: '1px solid var(--border)', padding: '.5rem 0' }}>
          <strong>{i.title}</strong>{i.place && `, ${i.place}`} · {STATUS[i.status]} · {dmy(i.nextDue)} ({when(i)})
          <div><DoneButton i={i} onDone={() => void load()} /></div>
        </li>
      ))}</ul>
    </section>
  );
}

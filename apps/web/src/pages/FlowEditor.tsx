import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, can, type Me } from '../api';
import { errText } from '../strings';

type Id = string | undefined;
type Opt = { label: string; next?: string; examples: string[] };
type Check = { kind: 'hours' } | { kind: 'variable'; name: 'name' | 'phone' | 'email' | 'text'; contains: string } | { kind: 'channel'; is: 'whatsapp' | 'whatsapp_cloud' | 'telegram' };
type Node = { id: string; label?: string } & (
  | { type: 'message'; text: string; next?: Id }
  | { type: 'menu'; text: string; options: Opt[]; kbOnFreeText: boolean }
  | { type: 'question'; text: string; save: 'name' | 'phone' | 'email' | 'text'; retryText: string; next?: Id }
  | { type: 'condition'; check: Check; yes?: Id; no?: Id }
  | { type: 'kb'; intro: string; found?: Id; notFound?: Id }
  | { type: 'referral'; text: string; contactName: string; phone: string; message: string; next?: Id }
  | { type: 'tag'; tagId: string; next?: Id }
  | { type: 'handoff'; text: string; userId?: string }
  | { type: 'end'; text: string }
);
interface Flow { start: string; nodes: Node[] }
interface FState { node: string | null; vars: Record<string, string>; invalid: number; done: boolean; endedAt?: number }
interface Refs { users: { id: string; name: string }[]; tags: { id: string; name: string }[] }

const TYPE_LABEL: Record<Node['type'], string> = { message: 'הודעה', menu: 'תפריט', question: 'שאלה (איסוף פרט)', condition: 'תנאי', kb: 'מאגר ידע', referral: 'הפניה לווצאפ אישי', tag: 'הוספת תגית', handoff: 'העברה לנציג', end: 'סיום' };
const TYPE_CLASS: Record<Node['type'], string> = { message: 'muted', menu: 'accent', question: 'accent', condition: 'warn', kb: 'ok', referral: 'ok', tag: 'muted', handoff: 'danger', end: 'muted' };
const SAVE_LABEL = { name: 'שם', phone: 'טלפון', email: 'אימייל', text: 'טקסט חופשי' } as const;

function edges(n: Node): { to: string; label: string }[] {
  const out: { to: string; label: string }[] = [];
  const add = (to: Id, label: string) => { if (to) out.push({ to, label }); };
  switch (n.type) {
    case 'menu': n.options.forEach((o, i) => add(o.next, `${i + 1}`)); break;
    case 'condition': add(n.yes, 'כן'); add(n.no, 'לא'); break;
    case 'kb': add(n.found, 'נמצא'); add(n.notFound, 'לא נמצא'); break;
    case 'handoff': case 'end': break;
    default: add(n.next, '');
  }
  return out;
}
const summary = (n: Node) => ('text' in n && n.text ? n.text : n.type === 'condition' ? (n.check.kind === 'hours' ? 'בשעות הפעילות?' : n.check.kind === 'channel' ? `ערוץ ${n.check.is}` : `${SAVE_LABEL[n.check.name]} מכיל "${n.check.contains}"`) : n.type === 'kb' ? 'מענה ממאגר הידע' : n.type === 'tag' ? 'הוספת תגית' : '');
const nodeName = (n: Node) => n.label || `${TYPE_LABEL[n.type]}: ${summary(n).slice(0, 24)}`;

function blank(type: Node['type'], id: string): Node {
  switch (type) {
    case 'message': return { id, type, text: 'טקסט ההודעה' };
    case 'menu': return { id, type, text: 'במה אפשר לעזור?', options: [{ label: 'אפשרות 1', examples: [] }], kbOnFreeText: true };
    case 'question': return { id, type, text: 'מה שמך?', save: 'name', retryText: 'לא הצלחתי להבין, אפשר לנסות שוב?' };
    case 'condition': return { id, type, check: { kind: 'hours' } };
    case 'kb': return { id, type, intro: '' };
    case 'referral': return { id, type, text: 'לשאלות בנושא פנו אל:', contactName: '', phone: '', message: '' };
    case 'tag': return { id, type, tagId: '' };
    case 'handoff': return { id, type, text: '' };
    default: return { id, type: 'end', text: 'תודה ולהתראות!' };
  }
}

/** Layered auto layout, first node on the right (reading direction of the UI). */
function layout(flow: Flow) {
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const layer = new Map<string, number>();
  const queue = [flow.start];
  layer.set(flow.start, 0);
  for (let i = 0; i < queue.length; i++) {
    const n = byId.get(queue[i]!);
    if (!n) continue;
    for (const e of edges(n)) if (byId.has(e.to) && !layer.has(e.to)) { layer.set(e.to, layer.get(queue[i]!)! + 1); queue.push(e.to); }
  }
  let extra = Math.max(0, ...layer.values()) + 1;
  for (const n of flow.nodes) if (!layer.has(n.id)) layer.set(n.id, extra); // unreachable nodes go in a last column
  const cols = new Map<number, string[]>();
  for (const n of flow.nodes) { const l = layer.get(n.id)!; cols.set(l, [...(cols.get(l) ?? []), n.id]); }
  const W = 190, H = 62, GX = 70, GY = 26;
  const maxL = Math.max(...cols.keys());
  const pos = new Map<string, { x: number; y: number }>();
  for (const [l, ids] of cols) ids.forEach((id, i) => pos.set(id, { x: (maxL - l) * (W + GX) + 10, y: i * (H + GY) + 10 }));
  const rows = Math.max(...[...cols.values()].map((c) => c.length));
  extra = 0;
  return { pos, W, H, width: (maxL + 1) * (W + GX) + 10, height: rows * (H + GY) + 30 };
}

export function FlowEditor({ me }: { me: Me }) {
  const canEdit = can(me, 'bot.manage');
  const [flow, setFlow] = useState<Flow | null>(null);
  const [saved, setSaved] = useState('');
  const [mode, setMode] = useState<'menu' | 'flow'>('menu');
  const [refs, setRefs] = useState<Refs>({ users: [], tags: [] });
  const [problems, setProblems] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [tab, setTab] = useState<'edit' | 'test'>('edit');
  const [addType, setAddType] = useState<Node['type']>('message');
  const loaded = useRef(false);

  useEffect(() => {
    void (async () => {
      const d = await api<{ mode: 'menu' | 'flow'; flow: Flow | null; problems: string[] }>('GET', '/flow').catch(() => null);
      if (d) { setMode(d.mode); setFlow(d.flow); setSaved(JSON.stringify(d.flow)); setProblems(d.problems); }
      setRefs(await api<Refs>('GET', '/flow/refs').catch(() => ({ users: [], tags: [] })));
      loaded.current = true;
    })();
  }, []);

  const dirty = JSON.stringify(flow) !== saved;
  const fail = (e: unknown) => {
    if (e instanceof ApiError) { setProblems(e.problems ?? []); setMsg({ ok: false, text: errText(e.code) }); } else setMsg({ ok: false, text: errText('generic') });
  };

  async function save() {
    setMsg(null);
    try { await api('PUT', '/flow', { flow }); setSaved(JSON.stringify(flow)); setProblems([]); setMsg({ ok: true, text: 'התרשים נשמר.' }); } catch (e) { fail(e); }
  }
  async function fromMenu() {
    if (flow && !confirm('להחליף את התרשים הנוכחי בתרשים שנוצר מהתפריט הקיים?')) return;
    const d = await api<{ flow: Flow }>('POST', '/flow/from-menu').catch(() => null);
    if (d) { setFlow(d.flow); setOpen(null); setMsg({ ok: true, text: 'נוצר תרשים מהתפריט. בדקו ושמרו.' }); }
  }
  async function setBotMode(m: 'menu' | 'flow') {
    setMsg(null);
    try { await api('PUT', '/flow/mode', { mode: m }); setMode(m); setMsg({ ok: true, text: m === 'flow' ? 'הבוט עובד כעת לפי התרשים.' : 'הבוט עובד כעת לפי התפריט הממוספר.' }); } catch (e) { fail(e); }
  }

  const upd = (id: string, patch: Partial<Node>) => setFlow((f) => f && { ...f, nodes: f.nodes.map((n) => (n.id === id ? ({ ...n, ...patch } as Node) : n)) });
  const del = (id: string) => setFlow((f) => {
    if (!f || f.nodes.length <= 1) return f;
    const clear = (v: Id) => (v === id ? undefined : v);
    const nodes = f.nodes.filter((n) => n.id !== id).map((n) => {
      const c = { ...n } as Record<string, unknown>;
      for (const k of ['next', 'yes', 'no', 'found', 'notFound']) if (k in c) c[k] = clear(c[k] as Id);
      if (n.type === 'menu') c.options = n.options.map((o) => ({ ...o, next: clear(o.next) }));
      return c as unknown as Node;
    });
    return { start: f.start === id ? nodes[0]!.id : f.start, nodes };
  });
  const add = () => {
    setFlow((f) => {
      const base: Flow = f ?? { start: '', nodes: [] };
      let i = base.nodes.length + 1;
      while (base.nodes.some((n) => n.id === `${addType}${i}`)) i++;
      const id = `${addType}${i}`;
      setOpen(id);
      return { start: base.start || id, nodes: [...base.nodes, blank(addType, id)] };
    });
  };

  const layoutInfo = useMemo(() => (flow && flow.nodes.length ? layout(flow) : null), [flow]);

  return (
    <>
      <h1 tabIndex={-1}>תרשים זרימה של הבוט</h1>
      <p className="hint">בונים שיחה עם הלקוח כתרשים: הודעות, תפריטים, שאלות לאיסוף פרטים, תנאים (שעות פעילות, ערוץ), מענה ממאגר הידע, הפניה לווצאפ אישי, תגיות והעברה לנציג. הבוט מבין גם ניסוח חופשי ("אני צריך משהו עם פיגומים") ולא רק מספרים.</p>
      <div className="card">
        <div className="row">
          <strong>מצב הבוט כעת: {mode === 'flow' ? 'תרשים זרימה' : 'תפריט ממוספר'}</strong>
          {canEdit && mode !== 'flow' && <button className="primary" disabled={!flow || dirty || problems.length > 0} onClick={() => setBotMode('flow')}>הפעלת התרשים כמצב הבוט</button>}
          {canEdit && mode === 'flow' && <button onClick={() => setBotMode('menu')}>חזרה לתפריט הממוספר</button>}
        </div>
        <p className="hint">הבוט עצמו מופעל ב<a href="#/bot">עמוד הבוט</a>. כדי להפעיל את התרשים יש לשמור אותו קודם ושיהיה תקין.</p>
      </div>
      <div className="chips" role="group" aria-label="תצוגה">
        <button className="chip" aria-pressed={tab === 'edit'} onClick={() => setTab('edit')}>תרשים ועריכה</button>
        <button className="chip" aria-pressed={tab === 'test'} onClick={() => setTab('test')}>בדיקה בשיחה</button>
      </div>
      <p role="status" className={msg?.ok ? 'ok' : 'error'}>{msg?.text}</p>
      {problems.length > 0 && <ul className="error" aria-label="בעיות בתרשים">{problems.map((p) => <li key={p}>{problemText(p)}</li>)}</ul>}

      {tab === 'test' && <Simulator flow={flow} />}

      {tab === 'edit' && (
        <>
          {canEdit && (
            <div className="row" style={{ marginBottom: '.75rem' }}>
              <button className="primary" onClick={save} disabled={!flow || !dirty}>שמירה</button>
              <button onClick={() => { setFlow(saved ? (JSON.parse(saved) as Flow) : null); setMsg(null); }} disabled={!dirty}>ביטול שינויים</button>
              <button onClick={fromMenu}>יצירה מהתפריט הממוספר הקיים</button>
              {dirty && <span className="hint">יש שינויים שלא נשמרו.</span>}
            </div>
          )}
          {!flow && <p className="empty">עוד אין תרשים. אפשר ליצור מהתפריט הקיים, או להוסיף צומת ראשון.</p>}

          {flow && layoutInfo && (
            <section className="card" aria-labelledby="fd-h">
              <h2 id="fd-h">התרשים</h2>
              <p className="hint">הזרימה מתחילה בצומת המסומן "התחלה" (מימין). לחיצה או Enter על צומת פותחת אותו לעריכה למטה.</p>
              <div className="flow-scroll" role="group" aria-label="תרשים הזרימה">
                <svg width={layoutInfo.width} height={layoutInfo.height} viewBox={`0 0 ${layoutInfo.width} ${layoutInfo.height}`} className="flow-svg">
                  <defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" className="flow-arrow" /></marker></defs>
                  {flow.nodes.flatMap((n) => edges(n).map((e, i) => {
                    const a = layoutInfo.pos.get(n.id), b = layoutInfo.pos.get(e.to);
                    if (!a || !b) return null;
                    const back = b.x >= a.x;                       // target is in the same or an earlier column: loop around below
                    const x1 = back ? a.x + layoutInfo.W / 2 : a.x, y1 = back ? a.y + layoutInfo.H : a.y + layoutInfo.H / 2;
                    const x2 = back ? b.x + layoutInfo.W / 2 : b.x + layoutInfo.W, y2 = back ? b.y + layoutInfo.H : b.y + layoutInfo.H / 2;
                    const d = back ? `M${x1} ${y1} C${x1} ${y1 + 36} ${x2} ${y2 + 36} ${x2} ${y2}` : `M${x1} ${y1} C${x1 - 40} ${y1} ${x2 + 40} ${y2} ${x2} ${y2}`;
                    const lx = (x1 + x2) / 2, ly = back ? Math.max(y1, y2) + 30 : (y1 + y2) / 2 - 4;
                    return (
                      <g key={`${n.id}-${i}`} aria-hidden="true">
                        <path d={d} className="flow-edge" markerEnd="url(#arr)" />
                        {e.label && <text x={lx} y={ly} textAnchor="middle" className="flow-edge-label">{e.label}</text>}
                      </g>
                    );
                  }))}
                  {flow.nodes.map((n) => {
                    const p = layoutInfo.pos.get(n.id)!;
                                    return (
                      <g key={n.id} className={`flow-node ${TYPE_CLASS[n.type]}${open === n.id ? ' sel' : ''}`} role="button" tabIndex={0}
                        aria-describedby={`fd-${n.id}`}
                        onClick={() => { setOpen(n.id); document.getElementById(`fn-${n.id}`)?.scrollIntoView({ block: 'nearest' }); }}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(n.id); document.getElementById(`fn-${n.id}`)?.scrollIntoView({ block: 'nearest' }); } }}>
                        <desc id={`fd-${n.id}`}>{edges(n).length ? `ממשיך אל ${edges(n).map((e) => nodeName(flow.nodes.find((x) => x.id === e.to) ?? n)).join(', ')}` : 'סוף הענף'}</desc>
                        <rect x={p.x} y={p.y} width={layoutInfo.W} height={layoutInfo.H} rx="10" />
                        <text x={p.x + layoutInfo.W - 10} y={p.y + 22} textAnchor="start" className="flow-type" direction="rtl" transform={`translate(0 0)`}>{TYPE_LABEL[n.type]}{flow.start === n.id ? ' · התחלה' : ''}</text>
                        <text x={p.x + layoutInfo.W - 10} y={p.y + 44} className="flow-text" direction="rtl">{(n.label || summary(n)).slice(0, 26)}</text>
                      </g>
                    );
                  })}
                </svg>
              </div>
            </section>
          )}

          {flow && (
            <section aria-labelledby="fn-h">
              <h2 id="fn-h">צמתים ({flow.nodes.length})</h2>
              {flow.nodes.map((n) => (
                <details key={n.id} id={`fn-${n.id}`} className="card flow-form" open={open === n.id} onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) setOpen(n.id); else if (open === n.id) setOpen(null); }}>
                  <summary><strong>{TYPE_LABEL[n.type]}</strong>: {nodeName(n)}{flow.start === n.id ? ' (התחלה)' : ''}</summary>
                  {open === n.id && <NodeForm n={n} flow={flow} refs={refs} canEdit={canEdit} upd={(p) => upd(n.id, p)} del={() => del(n.id)} makeStart={() => setFlow({ ...flow, start: n.id })} />}
                </details>
              ))}
            </section>
          )}

          {canEdit && (
            <div className="card row">
              <label htmlFor="fl-add">הוספת צומת</label>
              <select id="fl-add" value={addType} onChange={(e) => setAddType(e.target.value as Node['type'])} style={{ maxWidth: 260 }}>
                {(Object.keys(TYPE_LABEL) as Node['type'][]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
              </select>
              <button onClick={add}>הוספה</button>
            </div>
          )}
        </>
      )}
    </>
  );
}

function problemText(p: string): string {
  const [code, rest] = p.split(':');
  return ({ missing_start: 'צומת ההתחלה לא קיים.', duplicate_id: `מזהה כפול: ${rest}`, missing_target: `צומת מצביע על צומת שנמחק (${rest}).`, loop: 'יש מעגל של צמתים שלא ממתינים ללקוח (הוסיפו תפריט או שאלה בתוכו).' } as Record<string, string>)[code!] ?? p;
}

function TargetSelect({ id, label, value, flow, onChange, disabled }: { id: string; label: string; value: Id; flow: Flow; onChange: (v: Id) => void; disabled?: boolean }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">סיום השיחה עם הבוט</option>
        {flow.nodes.map((n) => <option key={n.id} value={n.id}>{nodeName(n)}</option>)}
      </select>
    </div>
  );
}

function NodeForm({ n, flow, refs, canEdit, upd, del, makeStart }: { n: Node; flow: Flow; refs: Refs; canEdit: boolean; upd: (p: Partial<Node>) => void; del: () => void; makeStart: () => void }) {
  const f = (k: string) => `${k}-${n.id}`;
  const set = (p: Record<string, unknown>) => upd(p as Partial<Node>);
  const dis = !canEdit;
  return (
    <fieldset disabled={dis} style={{ border: 0, padding: 0, margin: 0 }}>
      <div className="field"><label htmlFor={f('lb')}>שם בתרשים (אופציונלי)</label><input id={f('lb')} maxLength={60} value={n.label ?? ''} onChange={(e) => set({ label: e.target.value || undefined })} /></div>
      {'text' in n && n.type !== 'end' && n.type !== 'handoff' && <div className="field"><label htmlFor={f('tx')}>{n.type === 'menu' ? 'טקסט מעל התפריט' : 'ההודעה ללקוח'}</label><textarea id={f('tx')} rows={3} maxLength={1500} value={n.text} onChange={(e) => set({ text: e.target.value })} /></div>}
      {(n.type === 'end' || n.type === 'handoff') && <div className="field"><label htmlFor={f('tx')}>{n.type === 'end' ? 'הודעת סיום' : 'הודעה לפני ההעברה (ריק = ההודעה הכללית של הבוט)'}</label><textarea id={f('tx')} rows={2} maxLength={500} value={n.text} onChange={(e) => set({ text: e.target.value })} /></div>}

      {n.type === 'menu' && (
        <>
          <h3>אפשרויות</h3>
          {n.options.map((o, i) => (
            <div key={i} className="card" style={{ marginBottom: '.5rem' }}>
              <div className="field"><label htmlFor={f(`ol${i}`)}>אפשרות {i + 1}</label><input id={f(`ol${i}`)} required maxLength={60} value={o.label} onChange={(e) => set({ options: n.options.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)) })} /></div>
              <div className="field"><label htmlFor={f(`oe${i}`)}>ניסוחים נוספים שלקוח עשוי לכתוב (שורה לכל ניסוח, אופציונלי)</label><textarea id={f(`oe${i}`)} rows={2} value={o.examples.join('\n')} onChange={(e) => set({ options: n.options.map((x, k) => (k === i ? { ...x, examples: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 8) } : x)) })} /></div>
              <TargetSelect id={f(`on${i}`)} label="ממשיך אל" value={o.next} flow={flow} onChange={(v) => set({ options: n.options.map((x, k) => (k === i ? { ...x, next: v } : x)) })} />
              <button type="button" className="danger" disabled={n.options.length <= 1} onClick={() => set({ options: n.options.filter((_, k) => k !== i) })}>הסרת אפשרות {i + 1}</button>
            </div>
          ))}
          {n.options.length < 9 && <button type="button" onClick={() => set({ options: [...n.options, { label: '', examples: [] }] })}>הוספת אפשרות</button>}
          <div className="field"><label><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={n.kbOnFreeText} onChange={(e) => set({ kbOnFreeText: e.target.checked })} /> אם הלקוח כותב שאלה במקום לבחור, לנסות לענות ממאגר הידע</label></div>
        </>
      )}
      {n.type === 'question' && (
        <>
          <div className="field"><label htmlFor={f('sv')}>איזה פרט לשמור</label>
            <select id={f('sv')} value={n.save} onChange={(e) => set({ save: e.target.value })}>{(Object.keys(SAVE_LABEL) as (keyof typeof SAVE_LABEL)[]).map((k) => <option key={k} value={k}>{SAVE_LABEL[k]}</option>)}</select>
            <p className="hint">הפרט נבדק (אימייל/טלפון), נשמר כהערה פנימית בשיחה, ושם שנאסף משמש כשם איש הקשר.</p></div>
          <div className="field"><label htmlFor={f('rt')}>הודעה כשהתשובה לא תקינה</label><input id={f('rt')} maxLength={300} value={n.retryText} onChange={(e) => set({ retryText: e.target.value })} /></div>
        </>
      )}
      {n.type === 'condition' && (
        <>
          <div className="field"><label htmlFor={f('ck')}>התנאי</label>
            <select id={f('ck')} value={n.check.kind} onChange={(e) => set({ check: e.target.value === 'hours' ? { kind: 'hours' } : e.target.value === 'channel' ? { kind: 'channel', is: 'whatsapp' } : { kind: 'variable', name: 'text', contains: '' } })}>
              <option value="hours">עכשיו בשעות הפעילות</option><option value="channel">הלקוח פנה דרך ערוץ מסוים</option><option value="variable">פרט שנאסף מכיל טקסט</option>
            </select></div>
          {n.check.kind === 'channel' && <div className="field"><label htmlFor={f('ch')}>ערוץ</label><select id={f('ch')} value={n.check.is} onChange={(e) => set({ check: { kind: 'channel', is: e.target.value } })}><option value="whatsapp">ווצאפ (QR)</option><option value="whatsapp_cloud">ווצאפ רשמי</option><option value="telegram">טלגרם</option></select></div>}
          {n.check.kind === 'variable' && (
            <div className="row">
              <div className="field"><label htmlFor={f('vn')}>הפרט</label><select id={f('vn')} value={n.check.name} onChange={(e) => set({ check: { ...(n.check as Extract<Check, { kind: 'variable' }>), name: e.target.value } })}>{(Object.keys(SAVE_LABEL) as (keyof typeof SAVE_LABEL)[]).map((k) => <option key={k} value={k}>{SAVE_LABEL[k]}</option>)}</select></div>
              <div className="field"><label htmlFor={f('vc')}>מכיל</label><input id={f('vc')} maxLength={60} value={n.check.contains} onChange={(e) => set({ check: { ...(n.check as Extract<Check, { kind: 'variable' }>), contains: e.target.value } })} /></div>
            </div>
          )}
          <TargetSelect id={f('yes')} label="אם כן, ממשיך אל" value={n.yes} flow={flow} onChange={(v) => set({ yes: v })} />
          <TargetSelect id={f('no')} label="אם לא, ממשיך אל" value={n.no} flow={flow} onChange={(v) => set({ no: v })} />
        </>
      )}
      {n.type === 'kb' && (
        <>
          <div className="field"><label htmlFor={f('in')}>פתיח לפני התשובה (אופציונלי)</label><input id={f('in')} maxLength={120} value={n.intro} onChange={(e) => set({ intro: e.target.value })} /></div>
          <p className="hint">מחפש במאגר הידע לפי ההודעה האחרונה של הלקוח.</p>
          <TargetSelect id={f('fd')} label="אם נמצאה תשובה, ממשיך אל" value={n.found} flow={flow} onChange={(v) => set({ found: v })} />
          <TargetSelect id={f('nf')} label="אם לא נמצאה, ממשיך אל" value={n.notFound} flow={flow} onChange={(v) => set({ notFound: v })} />
        </>
      )}
      {n.type === 'referral' && (
        <>
          <div className="field"><label htmlFor={f('cn')}>שם ותפקיד (יוצג ללקוח)</label><input id={f('cn')} required maxLength={60} value={n.contactName} onChange={(e) => set({ contactName: e.target.value })} /></div>
          <div className="field"><label htmlFor={f('ph')}>מספר ווצאפ</label><input id={f('ph')} required dir="ltr" inputMode="tel" value={n.phone} onChange={(e) => set({ phone: e.target.value })} placeholder="0501234567" /></div>
          <div className="field"><label htmlFor={f('ms')}>הודעה שתוכתב מראש</label><input id={f('ms')} maxLength={200} value={n.message} onChange={(e) => set({ message: e.target.value })} /></div>
          <p className="hint">המספר יוצג ללקוחות: יש לקבל את הסכמת האדם.</p>
        </>
      )}
      {n.type === 'tag' && <div className="field"><label htmlFor={f('tg')}>תגית</label><select id={f('tg')} value={n.tagId} onChange={(e) => set({ tagId: e.target.value })}><option value="">בחרו תגית</option>{refs.tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>}
      {n.type === 'handoff' && <div className="field"><label htmlFor={f('us')}>נציג אחראי</label><select id={f('us')} value={n.userId ?? ''} onChange={(e) => set({ userId: e.target.value || undefined })}><option value="">לפי הקצאה רגילה</option>{refs.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>}
      {'next' in n && n.type !== 'tag' ? <TargetSelect id={f('nx')} label="ממשיך אל" value={n.next} flow={flow} onChange={(v) => set({ next: v })} /> : null}
      {n.type === 'tag' && <TargetSelect id={f('nx')} label="ממשיך אל" value={n.next} flow={flow} onChange={(v) => set({ next: v })} />}

      {canEdit && (
        <div className="row">
          {flow.start !== n.id && <button type="button" onClick={makeStart}>הגדרה כצומת התחלה</button>}
          <button type="button" className="danger" disabled={flow.nodes.length <= 1} onClick={() => { if (confirm(`למחוק את הצומת "${nodeName(n)}"?`)) del(); }}>מחיקת צומת</button>
        </div>
      )}
    </fieldset>
  );
}

function Simulator({ flow }: { flow: Flow | null }) {
  const [log, setLog] = useState<{ who: 'user' | 'bot' | 'sys'; text: string }[]>([]);
  const [state, setState] = useState<FState | null>(null);
  const [text, setText] = useState('');
  const [openNow, setOpenNow] = useState(true);
  const [channel, setChannel] = useState<'whatsapp' | 'whatsapp_cloud' | 'telegram'>('whatsapp');
  const [err, setErr] = useState('');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [log]);

  async function send(t: string | null) {
    setErr('');
    try {
      const r = await api<{ replies: string[]; state: FState; effects: { kind: string; [k: string]: unknown }[] }>('POST', '/flow/simulate', { flow: flow ?? undefined, state, text: t, open: openNow, channel });
      setState(r.state);
      setLog((l) => [...l, ...(t !== null ? [{ who: 'user' as const, text: t }] : []), ...r.replies.map((x) => ({ who: 'bot' as const, text: x })),
        ...r.effects.map((e) => ({ who: 'sys' as const, text: e.kind === 'handoff' ? `⇢ העברה לנציג${e.userId ? ' (נציג מסוים)' : ''}` : e.kind === 'tag' ? '⇢ נוספה תגית' : e.kind === 'note' ? `⇢ הערה פנימית: ${String(e.text)}` : e.kind === 'name' ? `⇢ שם איש הקשר: ${String(e.value)}` : '' }))]);
    } catch (e) { setErr(errText(e instanceof ApiError ? e.code : 'generic')); }
  }
  return (
    <section className="card" aria-labelledby="sim-h">
      <h2 id="sim-h">בדיקה בשיחה</h2>
      <p className="hint">מדמה לקוח מול התרשים (גם אם עוד לא נשמר). לא נשלחות הודעות אמיתיות ולא נוצרות שיחות. מאגר הידע והבנת המשמעות פועלים כמו בשיחה אמיתית.</p>
      <div className="row">
        <label><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={openNow} onChange={(e) => setOpenNow(e.target.checked)} /> עכשיו בשעות הפעילות</label>
        <label htmlFor="sim-ch" className="sr-only">ערוץ</label>
        <select id="sim-ch" value={channel} onChange={(e) => setChannel(e.target.value as 'whatsapp')} style={{ maxWidth: 200 }}><option value="whatsapp">ווצאפ</option><option value="whatsapp_cloud">ווצאפ רשמי</option><option value="telegram">טלגרם</option></select>
        <button onClick={() => { setLog([]); setState(null); }}>התחלה מחדש</button>
      </div>
      <div className="sim-log" role="log" aria-live="polite" aria-label="שיחת הבדיקה">
        {log.length === 0 && <p className="hint">כתבו הודעה ראשונה כמו לקוח.</p>}
        {log.filter((m) => m.text).map((m, i) => <div key={i} className={`sim-msg ${m.who}`}><span className="sr-only">{m.who === 'user' ? 'לקוח: ' : m.who === 'bot' ? 'בוט: ' : 'מערכת: '}</span><span style={{ whiteSpace: 'pre-wrap' }}>{m.text}</span></div>)}
        <div ref={end} />
      </div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); const t = text; setText(''); void send(t); }}>
        <label htmlFor="sim-in" className="sr-only">הודעת לקוח</label>
        <input id="sim-in" required maxLength={500} value={text} onChange={(e) => setText(e.target.value)} placeholder="הודעת לקוח…" style={{ flex: 1, minWidth: 160 }} />
        <button className="primary" type="submit" disabled={!flow}>שליחה</button>
      </form>
      <p role="alert" className="error">{err}</p>
      {state && <p className="hint">מצב: {state.done ? 'הסתיים' : state.node ? `ממתין בצומת ${state.node}` : '—'}{Object.keys(state.vars).length ? ` · נאסף: ${Object.entries(state.vars).map(([k, v]) => `${SAVE_LABEL[k as keyof typeof SAVE_LABEL]}=${v}`).join(', ')}` : ''}</p>}
    </section>
  );
}

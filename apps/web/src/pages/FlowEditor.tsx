import { PageTitle } from '../components/Illustration';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, can, personLabel, type Me } from '../api';
import { autoLayout, FlowCanvas, type CanvasNode, type Pos } from '../components/FlowCanvas';
import { errText } from '../strings';

type Id = string | undefined;
type Opt = { label: string; next?: string; examples: string[] };
type Check = { kind: 'hours' } | { kind: 'variable'; name: string; contains: string } | { kind: 'has'; name: string } | { kind: 'channel'; is: 'whatsapp' | 'whatsapp_cloud' | 'telegram' | 'webchat' | 'messenger' | 'instagram' | 'email' };
type Node = { id: string; label?: string } & (
  | { type: 'message'; text: string; next?: Id }
  | { type: 'menu'; text: string; options: Opt[]; kbOnFreeText: boolean; save?: string }
  | { type: 'question'; text: string; save: string; kind?: 'text' | 'name' | 'phone' | 'email'; optional?: boolean; retryText: string; next?: Id }
  | { type: 'media'; text: string; save?: string; allowText: boolean; optional: boolean; retryText: string; next?: Id }
  | { type: 'list'; text: string; save: string; max: number; moreText: string; optional: boolean; next?: Id }
  | { type: 'remember'; vars: string[]; next?: Id }
  | { type: 'condition'; check: Check; yes?: Id; no?: Id }
  | { type: 'kb'; intro: string; found?: Id; notFound?: Id }
  | { type: 'referral'; text: string; contactName: string; phone: string; message: string; next?: Id }
  | { type: 'tag'; tagId: string; next?: Id }
  | { type: 'handoff'; text: string; userId?: string; areaVars?: string[]; officerTopic?: string; showContact?: boolean }
  | { type: 'end'; text: string }
);
interface Flow { start: string; nodes: Node[]; labels?: Record<string, string>; kbFirst?: boolean; layout?: Record<string, Pos>; mainMenu?: string }
interface FState { node: string | null; vars: Record<string, string>; invalid: number; done: boolean; endedAt?: number; files?: number; list?: string[] }
interface Refs { users: { id: string; name: string; username?: string }[]; tags: { id: string; name: string }[]; officers?: { id: string; name: string; active: boolean; hasAccount: boolean; topics: string[] }[]; topics?: string[] }

const TYPE_LABEL: Record<Node['type'], string> = { message: 'הודעה', menu: 'תפריט', question: 'שאלה (איסוף פרט)', media: 'קובץ, תמונה או טקסט', list: 'רשימה (הוסף עוד)', remember: 'שמירה בכרטיס איש הקשר', condition: 'תנאי', kb: 'מאגר ידע', referral: 'הפניה לווצאפ אישי', tag: 'הוספת תגית', handoff: 'העברה לנציג', end: 'סיום' };
const TYPE_CLASS: Record<Node['type'], string> = { message: 'muted', menu: 'accent', question: 'accent', media: 'accent', list: 'accent', remember: 'muted', condition: 'warn', kb: 'ok', referral: 'ok', tag: 'muted', handoff: 'danger', end: 'muted' };
const KIND_LABEL = { text: 'טקסט חופשי', name: 'שם (ישמש כשם איש הקשר)', phone: 'טלפון', email: 'אימייל' } as const;
const VAR_RE = /^[a-z][a-zA-Z0-9_]{0,23}$/;
const varsOf = (flow: Flow): string[] => [...new Set(flow.nodes.flatMap((n) => (n.type === 'question' || n.type === 'list' || n.type === 'menu' && n.save || n.type === 'media' && n.save ? [(n as { save?: string }).save!] : [])).filter(Boolean))];

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
const summary = (n: Node) => ('text' in n && n.text ? n.text : n.type === 'condition' ? (n.check.kind === 'hours' ? 'בשעות הפעילות?' : n.check.kind === 'channel' ? `ערוץ ${n.check.is}` : n.check.kind === 'has' ? `${n.check.name} נאסף?` : `${n.check.name} מכיל "${n.check.contains}"`) : n.type === 'kb' ? 'מענה ממאגר הידע' : n.type === 'tag' ? 'הוספת תגית' : n.type === 'remember' ? `שמירת ${n.vars.join(', ')}` : '');
const nodeName = (n: Node) => n.label || `${TYPE_LABEL[n.type]}: ${summary(n).slice(0, 24)}`;
function portsOf(n: Node): CanvasNode['ports'] {
  switch (n.type) {
    case 'menu': return n.options.map((o, i) => ({ key: `opt:${i}`, label: `${i + 1}. ${o.label}`, to: o.next }));
    case 'condition': return [{ key: 'yes', label: 'כן', to: n.yes }, { key: 'no', label: 'לא', to: n.no }];
    case 'kb': return [{ key: 'found', label: 'נמצא', to: n.found }, { key: 'notFound', label: 'לא נמצא', to: n.notFound }];
    case 'handoff': case 'end': return [];
    default: return [{ key: 'next', label: '', to: n.next }];
  }
}
const toCanvas = (flow: Flow): CanvasNode[] => flow.nodes.map((n) => ({ id: n.id, kind: n.type, typeLabel: TYPE_LABEL[n.type], title: nodeName(n), subtitle: n.label || summary(n), cls: TYPE_CLASS[n.type], ports: portsOf(n) }));
/** Connect one way out of a node (next / yes / no / found / notFound / a menu option) to another node. */
function connect(n: Node, port: string, to: string): Node {
  if (port.startsWith('opt:') && n.type === 'menu') { const i = Number(port.slice(4)); return { ...n, options: n.options.map((o, k) => (k === i ? { ...o, next: to } : o)) }; }
  if (port in n || ['next', 'yes', 'no', 'found', 'notFound'].includes(port)) return { ...n, [port]: to } as Node;
  return n;
}

function blank(type: Node['type'], id: string): Node {
  switch (type) {
    case 'message': return { id, type, text: 'טקסט ההודעה' };
    case 'menu': return { id, type, text: 'במה אפשר לעזור?', options: [{ label: 'אפשרות 1', examples: [] }], kbOnFreeText: true };
    case 'question': return { id, type, text: 'מה שמך?', save: 'name', kind: 'name', optional: false, retryText: 'לא הצלחתי להבין, אפשר לנסות שוב?' };
    case 'condition': return { id, type, check: { kind: 'hours' } };
    case 'kb': return { id, type, intro: '' };
    case 'referral': return { id, type, text: 'לשאלות בנושא פנו אל:', contactName: '', phone: '', message: '' };
    case 'tag': return { id, type, tagId: '' };
    case 'media': return { id, type, text: 'שלחו תמונה או תארו בכתב:', allowText: true, optional: true, retryText: 'אפשר לשלוח כאן תמונה, קובץ או הסבר בכתב.' };
    case 'list': return { id, type, text: 'מה להוסיף לרשימה?', save: 'items', max: 10, moreText: 'להוסיף עוד?', optional: false };
    case 'remember': return { id, type, vars: ['fullName'] };
    case 'handoff': return { id, type, text: '' };
    default: return { id, type: 'end', text: 'תודה ולהתראות!' };
  }
}

export function FlowEditor({ me }: { me: Me }) {
  const canEdit = can(me, 'bot.manage');
  const [flow, setFlow] = useState<Flow | null>(null);
  const [saved, setSaved] = useState('');
  const [mode, setMode] = useState<'menu' | 'flow'>('menu');
  const [refs, setRefs] = useState<Refs>({ users: [], tags: [] });
  const [problems, setProblems] = useState<string[]>([]);
  const [unfin, setUnfin] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [tab, setTab] = useState<'edit' | 'test'>('edit');
  const [addType, setAddType] = useState<Node['type']>('message');
  const loaded = useRef(false);
  // undo / redo: snapshots of the flow; typing in one field within a second is one step
  const past = useRef<string[]>([]);
  const future = useRef<string[]>([]);
  const lastRec = useRef<{ at: number; key: string }>({ at: 0, key: '' });
  const [, bump] = useState(0);
  const change = (fn: (f: Flow | null) => Flow | null, record: boolean | string = true) => setFlow((prev) => {
    const next = fn(prev);
    if (record && prev && next !== prev) {
      const key = typeof record === 'string' ? record : '';
      const now = Date.now();
      if (!(key && lastRec.current.key === key && now - lastRec.current.at < 1000)) {
        past.current.push(JSON.stringify(prev));
        if (past.current.length > 100) past.current.shift();
        future.current = [];
        setTimeout(() => bump((x) => x + 1), 0);
      }
      lastRec.current = { at: now, key };
    }
    return next;
  });
  const undo = () => { const p = past.current.pop(); if (p === undefined) return; setFlow((cur) => { if (cur) future.current.push(JSON.stringify(cur)); return JSON.parse(p) as Flow; }); bump((x) => x + 1); };
  const redo = () => { const n = future.current.pop(); if (n === undefined) return; setFlow((cur) => { if (cur) past.current.push(JSON.stringify(cur)); return JSON.parse(n) as Flow; }); bump((x) => x + 1); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest('input, textarea, select, [contenteditable=true]'))) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); } else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void (async () => {
      const d = await api<{ mode: 'menu' | 'flow'; flow: Flow | null; problems: string[]; unfinished?: string[] }>('GET', '/flow').catch(() => null);
      if (d) { setMode(d.mode); setFlow(d.flow); setSaved(JSON.stringify(d.flow)); setProblems(d.problems); setUnfin(d.unfinished ?? []); }
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
    try { await api('PUT', '/flow', { flow }); setSaved(JSON.stringify(flow)); setProblems([]); setUnfin(flow ? flow.nodes.filter((n) => JSON.stringify(n).includes('[להשלים')).map((n) => n.id) : []); setMsg({ ok: true, text: 'התרשים נשמר.' }); } catch (e) { fail(e); }
  }
  async function fromMenu() {
    if (flow && !confirm('להחליף את התרשים הנוכחי בתרשים שנוצר מהתפריט הקיים?')) return;
    const d = await api<{ flow: Flow }>('POST', '/flow/from-menu').catch(() => null);
    if (d) { change(() => d.flow); setOpen(null); setMsg({ ok: true, text: 'נוצר תרשים מהתפריט. בדקו ושמרו.' }); }
  }
  const [tplLinks, setTplLinks] = useState<Record<string, string>>({});
  async function safetyTemplate() {
    if (flow && !confirm('להחליף את התרשים הנוכחי בתבנית יחידת הבטיחות? (לא נשמר עד שתלחצו על שמירה)')) return;
    setMsg(null);
    try {
      const d = await api<{ flow: Flow }>('POST', '/flow/templates/safety', { links: tplLinks });
      change(() => d.flow); setOpen(null);
      setMsg({ ok: true, text: 'נוצרה תבנית יחידת הבטיחות. בדקו את הטקסטים, בחרו ממונים בצמתי ההעברה ושמרו.' });
      refreshRefs();
    } catch (e) { fail(e); }
  }
  async function fillPlaceholders() {
    if (!flow || !confirm('להחליף כל "[להשלים ...]" בנוסח "פנו ליחידת הבטיחות לקבלת הקישור" ולשמור? אפשר לערוך את הנוסח אחר כך בכל צומת.')) return;
    const next = JSON.parse(JSON.stringify(flow).replace(/\[להשלים[^\]"\\]*\]/g, 'פנו ליחידת הבטיחות לקבלת הקישור')) as Flow;
    setMsg(null);
    try { await api('PUT', '/flow', { flow: next }); setFlow(next); setSaved(JSON.stringify(next)); setProblems([]); setUnfin([]); setMsg({ ok: true, text: 'הטקסטים הושלמו והתרשים נשמר. אפשר להפעיל אותו.' }); } catch (e) { fail(e); }
  }
  const refreshRefs = () => { void api<Refs>('GET', '/flow/refs').then(setRefs).catch(() => undefined); };
  async function setBotMode(m: 'menu' | 'flow') {
    setMsg(null);
    try { await api('PUT', '/flow/mode', { mode: m }); setMode(m); setMsg({ ok: true, text: m === 'flow' ? 'הבוט עובד כעת לפי התרשים.' : 'הבוט עובד כעת לפי התפריט הממוספר.' }); } catch (e) { fail(e); }
  }

  const upd = (id: string, patch: Partial<Node>) => change((f) => f && { ...f, nodes: f.nodes.map((n) => (n.id === id ? ({ ...n, ...patch } as Node) : n)) }, `edit:${id}:${Object.keys(patch).join(',')}`);
  const del = (id: string) => change((f) => {
    if (!f || f.nodes.length <= 1) return f;
    const clear = (v: Id) => (v === id ? undefined : v);
    const nodes = f.nodes.filter((n) => n.id !== id).map((n) => {
      const c = { ...n } as Record<string, unknown>;
      for (const k of ['next', 'yes', 'no', 'found', 'notFound']) if (k in c) c[k] = clear(c[k] as Id);
      if (n.type === 'menu') c.options = n.options.map((o) => ({ ...o, next: clear(o.next) }));
      return c as unknown as Node;
    });
    const layout = f.layout ? Object.fromEntries(Object.entries(f.layout).filter(([k]) => k !== id)) : undefined;
    return { ...f, start: f.start === id ? nodes[0]!.id : f.start, nodes, layout };
  });
  const add = () => {
    change((f) => {
      const base: Flow = f ?? { start: '', nodes: [] };
      let i = base.nodes.length + 1;
      while (base.nodes.some((n) => n.id === `${addType}${i}`)) i++;
      const id = `${addType}${i}`;
      setOpen(id);
      let nodes = [...base.nodes, blank(addType, id)];
      // a new node continues from the selected one when that one has a free single exit
      const sel = open ? base.nodes.find((n) => n.id === open) : undefined;
      if (connectNew && sel && portsOf(sel).length === 1 && portsOf(sel)[0]!.key === 'next' && !portsOf(sel)[0]!.to) nodes = nodes.map((n) => (n.id === sel.id ? connect(n, 'next', id) : n));
      let layout = base.layout;
      if (layout) {
        const sp = sel ? layout[sel.id] : undefined;
        layout = { ...layout, [id]: sp ? { x: Math.max(0, sp.x - 300), y: sp.y } : { x: 30, y: Math.max(20, ...Object.values(layout).map((p) => p.y + 100)) } };
      }
      return { ...base, start: base.start || id, nodes, layout };
    });
  };
  const [connectNew, setConnectNew] = useState(true);
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!full) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as HTMLElement)?.closest('input, textarea, select')) setFull(false); };
    document.addEventListener('keydown', esc);
    return () => { document.body.style.overflow = prev; document.removeEventListener('keydown', esc); };
  }, [full]);
  const canvasNodes = useMemo(() => (flow ? toCanvas(flow) : []), [flow]);
  const moveNode = (id: string, p: Pos, record: boolean) => change((f) => {
    if (!f) return f;
    const base = f.layout ?? autoLayout(toCanvas(f), f.start);   // the first move fixes everyone else where they are
    return { ...f, layout: { ...base, [id]: p } };
  }, record ? `move:${id}` : false);
  const link = (from: string, port: string, to: string) => change((f) => f && { ...f, nodes: f.nodes.map((n) => (n.id === from ? connect(n, port, to) : n)) });
  const arrange = () => { if (confirm('לסדר את כל הצמתים מחדש אוטומטית? (אפשר לבטל ב-Ctrl+Z)')) change((f) => f && { ...f, layout: undefined }); };
  const selectNode = (id: string) => { setOpen(id); };
  const selNode = flow && open ? flow.nodes.find((n) => n.id === open) : undefined;


  return (
    <>
      <PageTitle art="flow" title="תרשים זרימה של הבוט" />
      <p className="hint">בונים שיחה עם הלקוח כתרשים: הודעות, תפריטים, שאלות לאיסוף פרטים, תנאים (שעות פעילות, ערוץ), מענה ממאגר הידע, הפניה לווצאפ אישי, תגיות והעברה לנציג. הבוט מבין גם ניסוח חופשי ("אני צריך משהו עם פיגומים") ולא רק מספרים.</p>
      <div className="card">
        <div className="row">
          <strong>מצב הבוט כעת: {mode === 'flow' ? 'תרשים זרימה' : 'תפריט ממוספר'}</strong>
          {canEdit && mode !== 'flow' && <button className="primary" disabled={!flow || dirty || problems.length > 0 || unfin.length > 0} onClick={() => setBotMode('flow')}>הפעלת התרשים כמצב הבוט</button>}
          {canEdit && mode === 'flow' && <button onClick={() => setBotMode('menu')}>חזרה לתפריט הממוספר</button>}
        </div>
        {canEdit && mode !== 'flow' && (!flow || dirty || problems.length > 0 || unfin.length > 0) && (
          <p role="status" className="error">
            ההפעלה חסומה כי: {!flow ? 'אין תרשים. ' : ''}{dirty ? 'יש שינויים שלא נשמרו (לחצו "שמירה"). ' : ''}{problems.length > 0 ? 'יש בעיות בתרשים (מפורטות מתחת). ' : ''}{unfin.length > 0 ? `נשארו טקסטים עם "[להשלים" בצמתים: ${unfin.join(', ')}.` : ''}
          </p>
        )}
        <p className="hint">הבוט עצמו מופעל ב<a href="#/bot">עמוד הבוט</a>. כדי להפעיל את התרשים יש לשמור אותו קודם ושיהיה תקין.</p>
      </div>
      <div className="chips tabs" role="group" aria-label="תצוגה">
        <button className="chip" aria-pressed={tab === 'edit'} onClick={() => setTab('edit')}>תרשים ועריכה</button>
        <button className="chip" aria-pressed={tab === 'test'} onClick={() => setTab('test')}>בדיקה בשיחה</button>
      </div>
      <p role="status" className={msg?.ok ? 'ok' : 'error'}>{msg?.text}</p>
      {flow && flow.nodes.some((n) => JSON.stringify(n).includes('[להשלים')) && (
        <div className="card" role="note"><strong>יש טקסטים שטרם הושלמו</strong>
          <p className="hint">בצמתים הבאים מופיע "[להשלים" (למשל כתובת טופס). אי אפשר להפעיל את התרשים כמצב הבוט עד שישלימו אותם ויישמרו:</p>
          {canEdit && <button type="button" onClick={fillPlaceholders}>השלמה אוטומטית בנוסח ניטרלי ושמירה</button>}
          <ul>{flow.nodes.filter((n) => JSON.stringify(n).includes('[להשלים')).map((n) => <li key={n.id}><button type="button" className="linklike" onClick={() => { setTab('edit'); setOpen(n.id); setTimeout(() => document.getElementById(`fn-${n.id}`)?.scrollIntoView({ block: 'nearest' }), 0); }}>{nodeName(n)}</button></li>)}</ul>
        </div>
      )}
      {problems.length > 0 && <ul className="error" aria-label="בעיות בתרשים">{problems.map((p) => <li key={p}>{problemText(p)}</li>)}</ul>}

      {tab === 'test' && <Simulator flow={flow} />}

      {tab === 'edit' && (
        <>
          {canEdit && (
            <div className="row" style={{ marginBottom: '.75rem' }}>
              <button className="primary" onClick={save} disabled={!flow || !dirty}>שמירה</button>
              <button onClick={() => { change(() => (saved ? (JSON.parse(saved) as Flow) : null)); setMsg(null); }} disabled={!dirty}>ביטול כל השינויים שלא נשמרו</button>
              <button onClick={fromMenu}>יצירה מהתפריט הממוספר הקיים</button>
              <button onClick={safetyTemplate}>יצירת תרשים בטיחות לפי האפיון</button>
              {dirty && <span className="hint">יש שינויים שלא נשמרו.</span>}
            </div>
          )}
          {canEdit && (
            <details className="card">
              <summary><strong>קישורים לתבנית הבטיחות</strong> (אופציונלי, יוכנסו להודעות כשתיצרו את התבנית)</summary>
              <p className="hint">כתובות https של הטפסים של היחידה. נושא בלי קישור יאמר ללקוח לפנות ליחידה. אפשר גם להוסיף או לערוך קישור בכל צומת אחר כך.</p>
              {([['waste', 'טופס פינוי פסולת כימית'], ['accident', 'טופס דיווח תאונה / כמעט-ונפגע'], ['event', 'טופס אישור אירוע'], ['offsite', 'טופס ניסוי מחוץ לקמפוס'], ['training', 'הרשמה להדרכות'], ['privacy', 'מדיניות הפרטיות']] as const).map(([k, label]) => (
                <div className="field" key={k}><label htmlFor={`tl-${k}`}>{label}</label><input id={`tl-${k}`} type="url" dir="ltr" maxLength={500} placeholder="https://" value={tplLinks[k] ?? ''} onChange={(e) => setTplLinks({ ...tplLinks, [k]: e.target.value })} /></div>
              ))}
            </details>
          )}
          {!flow && <p className="empty">עוד אין תרשים. אפשר ליצור מהתפריט הקיים, או להוסיף צומת ראשון.</p>}

          {flow && flow.nodes.length > 0 && (
            <section className="card" aria-labelledby="fd-h">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <h2 id="fd-h" style={{ margin: 0 }}>התרשים</h2>
                {canEdit && <div className="row">
                  <button type="button" onClick={undo} disabled={past.current.length === 0} aria-keyshortcuts="Control+Z">ביטול פעולה</button>
                  <button type="button" onClick={redo} disabled={future.current.length === 0} aria-keyshortcuts="Control+Shift+Z">חזרה על פעולה</button>
                </div>}
              </div>
              <div className={`flow-work${full ? ' full' : ''}`} role={full ? 'dialog' : undefined} aria-modal={full ? true : undefined} aria-label={full ? 'עורך התרשים במסך מלא' : undefined}>
                <FlowCanvas nodes={canvasNodes} start={flow.start} layout={flow.layout} selected={open} canEdit={canEdit}
                  onSelect={selectNode} onMove={moveNode} onConnect={link} onArrange={arrange} full={full} onToggleFull={() => setFull((f) => !f)} />
                <aside className="flow-side" aria-labelledby="fs-h">
                  {selNode ? (
                    <>
                      <h3 id="fs-h">{TYPE_LABEL[selNode.type]}{flow.start === selNode.id ? ' (התחלה)' : ''}</h3>
                      <NodeForm key={selNode.id} n={selNode} flow={flow} refs={refs} canEdit={canEdit} upd={(p) => upd(selNode.id, p)} del={() => { del(selNode.id); setOpen(null); }} makeStart={() => change((f) => f && { ...f, start: selNode.id })} makeMain={() => change((f) => f && { ...f, mainMenu: selNode.id })} />
                    </>
                  ) : (
                    <>
                      <h3 id="fs-h">עריכת צומת</h3>
                      <p className="hint">בחרו צומת בתרשים (לחיצה, או Tab ואז Enter) כדי לערוך אותו כאן.</p>
                    </>
                  )}
                  {canEdit && (
                    <div className="flow-add">
                      <label htmlFor="fl-add">הוספת צומת</label>
                      <div className="row">
                        <select id="fl-add" value={addType} onChange={(e) => setAddType(e.target.value as Node['type'])} style={{ flex: 1, minWidth: 0 }}>
                          {(Object.keys(TYPE_LABEL) as Node['type'][]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                        </select>
                        <button type="button" onClick={add}>הוספה</button>
                      </div>
                      <label style={{ fontWeight: 400 }}><input type="checkbox" style={{ width: 'auto', minHeight: 0, marginInlineEnd: '.4rem' }} checked={connectNew} onChange={(e) => setConnectNew(e.target.checked)} />לחבר אחרי הצומת הנבחר</label>
                    </div>
                  )}
                </aside>
              </div>
            </section>
          )}

          {flow && (
            <details className="card">
              <summary><strong>כל הצמתים ({flow.nodes.length})</strong>, רשימה לקריאה ולניווט במקלדת</summary>
              <ul className="plain">
                {flow.nodes.map((n) => (
                  <li key={n.id} id={`fn-${n.id}`}>
                    <button type="button" className="linklike" aria-current={open === n.id} onClick={() => { setOpen(n.id); document.getElementById('fd-h')?.scrollIntoView({ block: 'start' }); }}>
                      <strong>{TYPE_LABEL[n.type]}</strong>: {nodeName(n)}{flow.start === n.id ? ' (התחלה)' : ''}
                    </button>
                    <span className="hint"> {edges(n).length ? `← ${edges(n).map((e) => `${e.label ? `${e.label}: ` : ''}${nodeName(flow.nodes.find((x) => x.id === e.to) ?? n)}`).join(' | ')}` : '· סוף הענף'}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {!flow?.nodes.length && canEdit && (
            <div className="card row">
              <label htmlFor="fl-add0">הוספת צומת ראשון</label>
              <select id="fl-add0" value={addType} onChange={(e) => setAddType(e.target.value as Node['type'])} style={{ maxWidth: 260 }}>
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
  return ({ missing_start: 'צומת ההתחלה לא קיים.', unfinished_flow: 'יש טקסטים שטרם הושלמו.', duplicate_id: `מזהה כפול: ${rest}`, missing_target: `צומת מצביע על צומת שנמחק (${rest}).`, loop: 'יש מעגל של צמתים שלא ממתינים ללקוח (הוסיפו תפריט או שאלה בתוכו).' } as Record<string, string>)[code!] ?? p;
}

function VarInput({ id, label, value, onChange, flow, optional }: { id: string; label: string; value: string; onChange: (v: string) => void; flow: Flow; optional?: boolean }) {
  const list = `${id}-dl`;
  const bad = value !== '' && !VAR_RE.test(value);
  return (
    <div className="field"><label htmlFor={id}>{label}</label>
      <input id={id} dir="ltr" list={list} maxLength={24} required={!optional} aria-invalid={bad} value={value} onChange={(e) => onChange(e.target.value)} />
      <datalist id={list}>{varsOf(flow).map((v) => <option key={v} value={v} />)}</datalist>
      {bad && <p className="error">אותיות לועזיות ומספרים בלבד, מתחיל באות קטנה.</p>}
    </div>
  );
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

function NodeForm({ n, flow, refs, canEdit, upd, del, makeStart, makeMain }: { n: Node; flow: Flow; refs: Refs; canEdit: boolean; upd: (p: Partial<Node>) => void; del: () => void; makeStart: () => void; makeMain: () => void }) {
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
          {n.options.length < 20 && <button type="button" onClick={() => set({ options: [...n.options, { label: '', examples: [] }] })}>הוספת אפשרות</button>}
          <div className="field"><label htmlFor={f('ms')}>לשמור את האפשרות שנבחרה בפרט בשם (אופציונלי, אותיות לועזיות)</label><input id={f('ms')} dir="ltr" maxLength={24} value={n.save ?? ''} onChange={(e) => set({ save: e.target.value && VAR_RE.test(e.target.value) ? e.target.value : e.target.value ? n.save : undefined })} placeholder="status" /></div>
          <div className="field"><label><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={n.kbOnFreeText} onChange={(e) => set({ kbOnFreeText: e.target.checked })} /> אם הלקוח כותב שאלה במקום לבחור, לנסות לענות ממאגר הידע</label></div>
        </>
      )}
      {n.type === 'question' && (
        <>
          <VarInput id={f('sv')} label="שם הפרט שנאסף (אותיות לועזיות, למשל fullName)" value={n.save} onChange={(v) => set({ save: v })} flow={flow} />
          <div className="field"><label htmlFor={f('kd')}>סוג הפרט (לבדיקה)</label>
            <select id={f('kd')} value={n.kind ?? (['name', 'phone', 'email'].includes(n.save) ? n.save : 'text')} onChange={(e) => set({ kind: e.target.value })}>{(Object.keys(KIND_LABEL) as (keyof typeof KIND_LABEL)[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select>
            <p className="hint">הפרט נבדק (אימייל/טלפון), נשמר כהערה פנימית בשיחה, ושם שנאסף משמש כשם איש הקשר.</p></div>
          <div className="field"><label><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={!!n.optional} onChange={(e) => set({ optional: e.target.checked })} /> אפשר לדלג (הלקוח כותב "דלג")</label></div>
          <div className="field"><label htmlFor={f('rt')}>הודעה כשהתשובה לא תקינה</label><input id={f('rt')} maxLength={300} value={n.retryText} onChange={(e) => set({ retryText: e.target.value })} /></div>
        </>
      )}
      {n.type === 'media' && (
        <>
          <VarInput id={f('sv')} label="שם הפרט לטקסט שיוצג בסיכום (אופציונלי)" value={n.save ?? ''} onChange={(v) => set({ save: v || undefined })} flow={flow} optional />
          <div className="field"><label><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={n.allowText} onChange={(e) => set({ allowText: e.target.checked })} /> מספיק גם תיאור בכתב (בלי קובץ)</label></div>
          <div className="field"><label><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={n.optional} onChange={(e) => set({ optional: e.target.checked })} /> אפשר לדלג</label></div>
          <div className="field"><label htmlFor={f('rt')}>הודעה כשלא התקבל קובץ או טקסט</label><input id={f('rt')} maxLength={300} value={n.retryText} onChange={(e) => set({ retryText: e.target.value })} /></div>
          <p className="hint">קבצים עוברים סריקת וירוסים והסגר כמו בכל שיחה. מספר הקבצים נרשם בהערת הסיכום.</p>
        </>
      )}
      {n.type === 'list' && (
        <>
          <VarInput id={f('sv')} label="שם הפרט שנאסף (אותיות לועזיות, למשל chemicals)" value={n.save} onChange={(v) => set({ save: v })} flow={flow} />
          <div className="row">
            <div className="field"><label htmlFor={f('mx')}>מקסימום פריטים</label><input id={f('mx')} type="number" min={2} max={20} value={n.max} onChange={(e) => set({ max: Math.min(20, Math.max(2, Number(e.target.value) || 2)) })} /></div>
            <div className="field"><label htmlFor={f('mt')}>השאלה אחרי כל פריט</label><input id={f('mt')} maxLength={200} value={n.moreText} onChange={(e) => set({ moreText: e.target.value })} /></div>
          </div>
          <div className="field"><label><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={n.optional} onChange={(e) => set({ optional: e.target.checked })} /> אפשר לדלג על הרשימה</label></div>
        </>
      )}
      {n.type === 'remember' && (
        <div className="field"><label htmlFor={f('rv')}>פרטים לשמירה בכרטיס איש הקשר (מופרדים בפסיק)</label>
          <input id={f('rv')} dir="ltr" value={n.vars.join(', ')} onChange={(e) => set({ vars: e.target.value.split(',').map((x) => x.trim()).filter((x) => VAR_RE.test(x)).slice(0, 12) })} />
          <p className="hint">בפנייה הבאה של אותו אדם, שאלות עם אותו שם לא יישאלו שוב (בתנאי שיש תנאי "פרט נאסף" בתחילת התרשים). פרטים אישיים: יש לציין זאת במדיניות הפרטיות.</p></div>
      )}
      {n.type === 'condition' && (
        <>
          <div className="field"><label htmlFor={f('ck')}>התנאי</label>
            <select id={f('ck')} value={n.check.kind} onChange={(e) => set({ check: e.target.value === 'hours' ? { kind: 'hours' } : e.target.value === 'channel' ? { kind: 'channel', is: 'whatsapp' } : e.target.value === 'has' ? { kind: 'has', name: varsOf(flow)[0] ?? 'fullName' } : { kind: 'variable', name: varsOf(flow)[0] ?? 'text', contains: '' } })}>
              <option value="hours">עכשיו בשעות הפעילות</option><option value="channel">הלקוח פנה דרך ערוץ מסוים</option><option value="variable">פרט שנאסף מכיל טקסט</option><option value="has">פרט כבר נאסף (למשל מפנייה קודמת)</option>
            </select></div>
          {n.check.kind === 'channel' && <div className="field"><label htmlFor={f('ch')}>ערוץ</label><select id={f('ch')} value={n.check.is} onChange={(e) => set({ check: { kind: 'channel', is: e.target.value } })}><option value="whatsapp">ווצאפ (QR)</option><option value="whatsapp_cloud">ווצאפ רשמי</option><option value="telegram">טלגרם</option><option value="messenger">Messenger</option><option value="instagram">Instagram</option><option value="webchat">צ׳אט באתר</option><option value="email">אימייל</option></select></div>}
          {n.check.kind === 'variable' && (
            <div className="row">
              <VarInput id={f('vn')} label="הפרט" value={n.check.name} onChange={(v) => set({ check: { ...(n.check as Extract<Check, { kind: 'variable' }>), name: v } })} flow={flow} />
              <div className="field"><label htmlFor={f('vc')}>מכיל</label><input id={f('vc')} maxLength={60} value={n.check.contains} onChange={(e) => set({ check: { ...(n.check as Extract<Check, { kind: 'variable' }>), contains: e.target.value } })} /></div>
            </div>
          )}
          {n.check.kind === 'has' && <VarInput id={f('hn')} label="הפרט" value={n.check.name} onChange={(v) => set({ check: { kind: 'has', name: v } })} flow={flow} />}
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
      {n.type === 'handoff' && (
        <div className="field"><label htmlFor={f('av')}>העברה לפי אזור אחריות, מתוך הפרטים (מופרדים בפסיק, אופציונלי)</label>
          <input id={f('av')} dir="ltr" value={(n.areaVars ?? []).join(', ')} onChange={(e) => { const v = e.target.value.split(',').map((x) => x.trim()).filter((x) => VAR_RE.test(x)).slice(0, 4); set({ areaVars: v.length ? v : undefined }); }} placeholder="where, building" />
          <p className="hint">אם אחד הפרטים מכיל שם בניין או מקום שמוגדר ב<a href="#/safety">אזורי האחריות</a>, השיחה תועבר לאחראי עליו. אחרת לנציג שנבחר למטה.</p></div>
      )}
      {n.type === 'handoff' && (() => {
        const found = (refs.officers ?? []).filter((o) => o.active && n.officerTopic && o.topics.some((t) => t.toLowerCase() === n.officerTopic!.toLowerCase()));
        return (
          <div className="field"><label htmlFor={f('ot')}>ממונה בתחום (אופציונלי)</label>
            <input id={f('ot')} list={f('otl')} maxLength={60} value={n.officerTopic ?? ''} onChange={(e) => set({ officerTopic: e.target.value.trim() ? e.target.value : undefined })} placeholder="למשל: לייזרים" aria-describedby={f('oth')} />
            <datalist id={f('otl')}>{(refs.topics ?? []).map((t) => <option key={t} value={t} />)}</datalist>
            <p id={f('oth')} className="hint">{n.officerTopic ? (found.length ? `ממונים בתחום "${n.officerTopic}": ${found.map((o) => `${o.name}${o.hasAccount ? '' : ' (בלי חשבון)'}`).join(', ')}.` : `אין עדיין ממונה פעיל בתחום "${n.officerTopic}". מוסיפים אותו ב`) : 'השיחה עוברת לממונה של הנושא שמוגדר ב'}<a href="#/safety">לוח בטיחות ← ממונים ונושאים</a>. שיוך לפי מקום (אזורי אחריות) גובר, והנציג שנבחר למטה הוא גיבוי.</p>
            {n.officerTopic && <label><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={!!n.showContact} onChange={(e) => set({ showContact: e.target.checked || undefined })} /> להציג ללקוח את שם הממונה, הווצאפ והאימייל שלו</label>}
          </div>
        );
      })()}
      {n.type === 'handoff' && <div className="field"><label htmlFor={f('us')}>נציג אחראי</label><select id={f('us')} value={n.userId ?? ''} onChange={(e) => set({ userId: e.target.value || undefined })}><option value="">לפי הקצאה רגילה</option>{refs.users.map((u) => <option key={u.id} value={u.id}>{personLabel(u)}</option>)}</select></div>}
      {'next' in n && n.type !== 'tag' ? <TargetSelect id={f('nx')} label="ממשיך אל" value={n.next} flow={flow} onChange={(v) => set({ next: v })} /> : null}
      {n.type === 'tag' && <TargetSelect id={f('nx')} label="ממשיך אל" value={n.next} flow={flow} onChange={(v) => set({ next: v })} />}

      {n.type === 'menu' && <p id={`${n.id}-mmh`} className="hint">{flow.mainMenu === n.id ? 'זה התפריט הראשי: לקוח שכותב "תפריט" או "תחזור לתפריט" מגיע לכאן.' : 'כשלקוח כותב "תפריט" הוא מגיע לתפריט הראשי. אם לא נבחר אחד, נבחר אוטומטית התפריט הראשון שמקבל טקסט חופשי (תפריט הנושאים).'}</p>}
      {canEdit && (
        <div className="row">
          {flow.start !== n.id && <button type="button" onClick={makeStart}>הגדרה כצומת התחלה</button>}
          {n.type === 'menu' && flow.mainMenu !== n.id && <button type="button" onClick={makeMain} aria-describedby={`${n.id}-mmh`}>הגדרה כתפריט הראשי</button>}
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
  const [channel, setChannel] = useState<'whatsapp' | 'whatsapp_cloud' | 'telegram' | 'messenger' | 'instagram'>('whatsapp');
  const [err, setErr] = useState('');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [log]);

  async function send(t: string | null, media = false) {
    setErr('');
    try {
      const r = await api<{ replies: string[]; state: FState; effects: { kind: string; [k: string]: unknown }[] }>('POST', '/flow/simulate', { flow: flow ?? undefined, state, text: t, media: media || undefined, open: openNow, channel });
      setState(r.state);
      setLog((l) => [...l, ...(t !== null || media ? [{ who: 'user' as const, text: media ? `📷 תמונה${t ? `: ${t}` : ''}` : t! }] : []), ...r.replies.map((x) => ({ who: 'bot' as const, text: x })),
        ...r.effects.map((e) => ({ who: 'sys' as const, text: e.kind === 'handoff' ? `⇢ העברה לנציג${e.userId ? ' (נציג מסוים)' : ''}` : e.kind === 'tag' ? '⇢ נוספה תגית' : e.kind === 'note' ? `⇢ הערה פנימית: ${String(e.text)}` : e.kind === 'name' ? `⇢ שם איש הקשר: ${String(e.value)}` : e.kind === 'profile' ? '⇢ הפרטים נשמרו בכרטיס איש הקשר' : '' }))]);
    } catch (e) { setErr(errText(e instanceof ApiError ? e.code : 'generic')); }
  }
  return (
    <section className="card" aria-labelledby="sim-h">
      <h2 id="sim-h">בדיקה בשיחה</h2>
      <p className="hint">מדמה לקוח מול התרשים (גם אם עוד לא נשמר). לא נשלחות הודעות אמיתיות ולא נוצרות שיחות. מאגר הידע והבנת המשמעות פועלים כמו בשיחה אמיתית.</p>
      <div className="row">
        <label><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={openNow} onChange={(e) => setOpenNow(e.target.checked)} /> עכשיו בשעות הפעילות</label>
        <label htmlFor="sim-ch" className="sr-only">ערוץ</label>
        <select id="sim-ch" value={channel} onChange={(e) => setChannel(e.target.value as 'whatsapp')} style={{ maxWidth: 200 }}><option value="whatsapp">ווצאפ</option><option value="whatsapp_cloud">ווצאפ רשמי</option><option value="telegram">טלגרם</option><option value="messenger">Messenger</option><option value="instagram">Instagram</option></select>
        <button onClick={() => { setLog([]); setState(null); }}>התחלה מחדש</button>
      </div>
      <div className="sim-log" tabIndex={0} role="log" aria-live="polite" aria-label="שיחת הבדיקה">
        {log.length === 0 && <p className="hint">כתבו הודעה ראשונה כמו לקוח.</p>}
        {log.filter((m) => m.text).map((m, i) => <div key={i} className={`sim-msg ${m.who}`}><span className="sr-only">{m.who === 'user' ? 'לקוח: ' : m.who === 'bot' ? 'בוט: ' : 'מערכת: '}</span><span style={{ whiteSpace: 'pre-wrap' }}>{m.text}</span></div>)}
        <div ref={end} />
      </div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); const t = text.trim(); if (!t) return; setText(''); void send(t); }}>
        <label htmlFor="sim-in" className="sr-only">הודעת לקוח</label>
        <input id="sim-in" maxLength={500} value={text} onChange={(e) => setText(e.target.value)} placeholder="הודעת לקוח…" style={{ flex: 1, minWidth: 160 }} />
        <button className="primary" type="submit" disabled={!flow}>שליחה</button>
        <button type="button" disabled={!flow} onClick={() => { const t = text; setText(''); void send(t || null, true); }}>שליחת תמונה (דמה)</button>
      </form>
      <p role="alert" className="error">{err}</p>
      {state && <p className="hint">מצב: {state.done ? 'הסתיים' : state.node ? `ממתין בצומת ${state.node}` : '—'}{Object.keys(state.vars).length ? ` · נאסף: ${Object.entries(state.vars).map(([k, v]) => `${flow?.labels?.[k] ?? k}=${v}`).join(', ')}` : ''}</p>}
    </section>
  );
}

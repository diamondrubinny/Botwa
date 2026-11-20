import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent } from 'react';
import { api, ApiError, FORM_FIELD_TYPES, type FormField, type FormFieldType, type FormTemplate } from '../api';
import { errText } from '../strings';

const PREFILL: Record<string, string> = { '': 'בלי', contact_name: 'שם הפונה', contact_phone: 'טלפון הפונה', today: 'התאריך היום', agent_name: 'שם הנציג/ה ששולח', case_number: 'מספר הפנייה' };
const DEFAULT_SIZE: Record<FormFieldType, [number, number]> = { text: [160, 16], textarea: [260, 60], date: [90, 16], id_number: [110, 16], phone: [110, 16], email: [180, 16], number: [70, 16], checkbox: [12, 12], signature: [150, 34], initials: [60, 24] };

interface PageView { w: number; h: number; scale: number }

/**
 * Places the fields on the template's pages: drag to move, the corner to resize, arrow keys to move (Alt + arrows to resize),
 * and every property (also the exact position) in the side panel, so it works without a mouse too.
 */
export function FormEditor({ templateId, onClose }: { templateId: string; onClose: () => void }) {
  const [tpl, setTpl] = useState<FormTemplate | null>(null);
  const [fields, setFields] = useState<FormField[]>([]);
  const [pages, setPages] = useState<PageView[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const holder = useRef<HTMLDivElement>(null);
  const canvases = useRef<(HTMLCanvasElement | null)[]>([]);
  const docRef = useRef<import('pdfjs-dist').PDFDocumentProxy | null>(null);
  const drag = useRef<{ id: string; mode: 'move' | 'size'; x0: number; y0: number; f: FormField; scale: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const t = await api<FormTemplate>('GET', `/forms/templates/${templateId}`);
        if (cancelled) return;
        setTpl(t); setFields(t.fields);
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')).default;
        const data = new Uint8Array(await (await fetch(`/forms/templates/${templateId}/source.pdf`, { credentials: 'same-origin' })).arrayBuffer());
        const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
        const width = Math.min(900, (holder.current?.clientWidth ?? 800) - 4);
        const views: PageView[] = [];
        for (let i = 1; i <= doc.numPages; i++) { const p = await doc.getPage(i); const v = p.getViewport({ scale: 1 }); views.push({ w: v.width, h: v.height, scale: width / v.width }); }
        if (cancelled) return;
        docRef.current = doc;
        setPages(views);
      } catch (e) { setMsg({ ok: false, text: errText(e instanceof ApiError ? e.code : 'generic') }); }
    })();
    return () => { cancelled = true; };
  }, [templateId]);

  // draw the pages once their canvases are on the screen
  useEffect(() => {
    const doc = docRef.current;
    if (!doc || !pages.length) return;
    let stop = false;
    (async () => {
      for (let i = 1; i <= pages.length && !stop; i++) {
        const c = canvases.current[i - 1]; if (!c) continue;
        const p = await doc.getPage(i); const dpr = window.devicePixelRatio || 1;
        const vp = p.getViewport({ scale: pages[i - 1]!.scale * dpr });
        c.width = vp.width; c.height = vp.height;
        try { await p.render({ canvasContext: c.getContext('2d')!, viewport: vp }).promise; } catch (e) { setMsg({ ok: false, text: `עמוד ${i} לא הוצג: ${(e as Error).message}` }); }
      }
    })();
    return () => { stop = true; };
  }, [pages]);

  const update = (id: string, patch: Partial<FormField>) => { setFields((l) => l.map((f) => (f.id === id ? { ...f, ...patch } : f))); setDirty(true); };
  const cur = fields.find((f) => f.id === sel) ?? null;
  const round = (n: number) => Math.round(n * 10) / 10;
  const clampBox = (f: FormField, p: PageView): FormField => ({ ...f, w: Math.max(6, Math.min(f.w, p.w)), h: Math.max(6, Math.min(f.h, p.h)), x: round(Math.max(0, Math.min(f.x, p.w - f.w))), y: round(Math.max(0, Math.min(f.y, p.h - f.h))) });

  function add(type: FormFieldType, page = cur?.page ?? 0) {
    const p = pages[page] ?? pages[0]; if (!p) return;
    const [w, h] = DEFAULT_SIZE[type];
    let n = fields.length + 1; while (fields.some((f) => f.id === `f${n}`)) n++;
    const f: FormField = { id: `f${n}`, type, label: FORM_FIELD_TYPES[type], page, x: round(p.w / 2 - w / 2), y: round(p.h / 2), w, h, required: type === 'signature', prefill: null, locked: false, hint: '' };
    setFields((l) => [...l, f]); setSel(f.id); setDirty(true);
  }

  function onDown(e: RPointerEvent, f: FormField, mode: 'move' | 'size') {
    e.stopPropagation(); e.preventDefault();
    setSel(f.id);
    drag.current = { id: f.id, mode, x0: e.clientX, y0: e.clientY, f, scale: pages[f.page]!.scale };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onMove(e: RPointerEvent) {
    const d = drag.current; if (!d) return;
    const dx = (e.clientX - d.x0) / d.scale, dy = (e.clientY - d.y0) / d.scale;
    const p = pages[d.f.page]!;
    const next = d.mode === 'move' ? { ...d.f, x: d.f.x + dx, y: d.f.y - dy } : { ...d.f, w: Math.max(6, d.f.w + dx), h: Math.max(6, d.f.h + dy), y: d.f.y - dy };
    const c = clampBox(next, p);
    setFields((l) => l.map((x) => (x.id === d.id ? c : x))); setDirty(true);
  }
  function onUp() { drag.current = null; }
  function onKey(e: KeyboardEvent, f: FormField) {
    const step = e.shiftKey ? 10 : 1;
    const k = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key] as [number, number] | undefined;
    if (e.key === 'Delete') { e.preventDefault(); remove(f.id); return; }
    if (!k) return;
    e.preventDefault();
    const p = pages[f.page]!;
    update(f.id, clampBox(e.altKey ? { ...f, w: f.w + k[0], h: f.h - k[1], y: f.y + k[1] } : { ...f, x: f.x + k[0], y: f.y + k[1] }, p));
  }
  function remove(id: string) { setFields((l) => l.filter((f) => f.id !== id)); setSel(null); setDirty(true); }

  async function save() {
    setBusy(true); setMsg(null);
    try { const t = await api<FormTemplate>('PATCH', `/forms/templates/${templateId}`, { fields }); setTpl(t); setFields(t.fields); setDirty(false); setMsg({ ok: true, text: 'נשמר.' }); }
    catch (e) { setMsg({ ok: false, text: errText(e instanceof ApiError ? e.code : 'generic') }); }
    finally { setBusy(false); }
  }

  return (
    <section className="card form-editor" aria-labelledby="fe-h">
      <div className="row fe-top">
        <h2 id="fe-h" style={{ margin: 0 }}>עריכת שדות: {tpl?.title ?? '…'}</h2>
        <span className="hint">{fields.length} שדות{dirty ? ' · יש שינויים שלא נשמרו' : ''}</span>
        <button className="primary" type="button" disabled={busy || !dirty} onClick={() => void save()}>שמירה</button>
        <button type="button" onClick={() => { if (!dirty || window.confirm('לצאת בלי לשמור את השינויים?')) onClose(); }}>סגירה</button>
      </div>
      <p className="hint">המערכת הציעה שדות לפי הכיתוב בטופס. גררו שדה כדי להזיז, והפינה מגדילה או מקטינה. אפשר גם לבחור שדה ולהזיז בחצים (Shift = צעד גדול, Alt + חצים = שינוי גודל, Delete = מחיקה).</p>
      <div className="row" role="group" aria-label="הוספת שדה">
        {(Object.keys(FORM_FIELD_TYPES) as FormFieldType[]).map((t) => <button key={t} type="button" onClick={() => add(t)}>+ {FORM_FIELD_TYPES[t]}</button>)}
      </div>
      {msg && <p role="status" className={msg.ok ? 'ok' : 'error'}>{msg.text}</p>}
      <div className="fe-body">
        <div className="fe-pages" ref={holder} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          {!pages.length && <p role="status">טוען את עמודי הטופס…</p>}
          {pages.map((p, i) => (
            <div key={i} className="fe-page" style={{ width: p.w * p.scale, height: p.h * p.scale }} onPointerDown={() => setSel(null)}>
              <canvas ref={(el) => { canvases.current[i] = el; }} style={{ width: p.w * p.scale, height: p.h * p.scale }} aria-label={`עמוד ${i + 1} של הטופס`} role="img" />
              {fields.filter((f) => f.page === i).map((f) => (
                <div key={f.id} role="button" tabIndex={0} aria-pressed={sel === f.id} aria-label={`${f.label} (${FORM_FIELD_TYPES[f.type]})${f.required ? ', חובה' : ''}`}
                  className={`fe-field t-${f.type}${sel === f.id ? ' sel' : ''}`} onFocus={() => setSel(f.id)} onKeyDown={(e) => onKey(e, f)} onPointerDown={(e) => onDown(e, f, 'move')}
                  style={{ left: f.x * p.scale, top: (p.h - f.y - f.h) * p.scale, width: f.w * p.scale, height: f.h * p.scale }}>
                  <span className="fe-label">{f.label}</span>
                  {sel === f.id && <span className="fe-handle" aria-hidden="true" onPointerDown={(e) => onDown(e, f, 'size')} />}
                </div>
              ))}
            </div>
          ))}
        </div>
        <aside className="fe-side" aria-label="מאפייני השדה">
          {!cur ? (
            <>
              <h3>השדות בטופס</h3>
              <ul className="plain">{fields.map((f) => <li key={f.id}><button type="button" className="linklike" onClick={() => setSel(f.id)}>{f.label} · {FORM_FIELD_TYPES[f.type]} · עמ׳ {f.page + 1}</button></li>)}</ul>
              {!fields.length && <p className="hint">אין עדיין שדות. הוסיפו שדה מהכפתורים למעלה.</p>}
            </>
          ) : (
            <>
              <h3>שדה: {cur.label}</h3>
              <div className="field"><label htmlFor="fe-l">כותרת (מה שהחותם רואה)</label><input id="fe-l" maxLength={80} value={cur.label} onChange={(e) => update(cur.id, { label: e.target.value })} /></div>
              <div className="field"><label htmlFor="fe-t">סוג</label>
                <select id="fe-t" value={cur.type} onChange={(e) => update(cur.id, { type: e.target.value as FormFieldType })}>{(Object.keys(FORM_FIELD_TYPES) as FormFieldType[]).map((t) => <option key={t} value={t}>{FORM_FIELD_TYPES[t]}</option>)}</select></div>
              <label className="row" style={{ fontWeight: 400 }}><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={cur.required} onChange={(e) => update(cur.id, { required: e.target.checked })} /> חובה</label>
              {cur.type !== 'signature' && cur.type !== 'initials' && cur.type !== 'checkbox' && (
                <>
                  <div className="field"><label htmlFor="fe-p">מילוי אוטומטי בשליחה</label>
                    <select id="fe-p" value={cur.prefill ?? ''} onChange={(e) => update(cur.id, { prefill: (e.target.value || null) as FormField['prefill'] })}>{Object.entries(PREFILL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
                  {cur.prefill && <label className="row" style={{ fontWeight: 400 }}><input type="checkbox" style={{ width: 'auto', minHeight: 'auto' }} checked={cur.locked} onChange={(e) => update(cur.id, { locked: e.target.checked })} /> נעול: החותם לא יכול לשנות</label>}
                </>
              )}
              <div className="field"><label htmlFor="fe-hint">הסבר קצר לחותם (לא חובה)</label><input id="fe-hint" maxLength={160} value={cur.hint} onChange={(e) => update(cur.id, { hint: e.target.value })} /></div>
              <fieldset className="fe-pos"><legend>מיקום וגודל (בנקודות)</legend>
                {(['x', 'y', 'w', 'h'] as const).map((k) => (
                  <div className="field" key={k}><label htmlFor={`fe-${k}`}>{{ x: 'מימין לשמאל (x)', y: 'מלמטה (y)', w: 'רוחב', h: 'גובה' }[k]}</label>
                    <input id={`fe-${k}`} type="number" step={1} value={cur[k]} onChange={(e) => update(cur.id, clampBox({ ...cur, [k]: Number(e.target.value) || 0 }, pages[cur.page]!))} /></div>
                ))}
                <div className="field"><label htmlFor="fe-pg">עמוד</label>
                  <select id="fe-pg" value={cur.page} onChange={(e) => update(cur.id, clampBox({ ...cur, page: Number(e.target.value) }, pages[Number(e.target.value)]!))}>{pages.map((_, i) => <option key={i} value={i}>{i + 1}</option>)}</select></div>
              </fieldset>
              <div className="row"><button type="button" className="danger" onClick={() => remove(cur.id)}>מחיקת השדה</button><button type="button" onClick={() => setSel(null)}>לרשימת השדות</button></div>
            </>
          )}
        </aside>
      </div>
    </section>
  );
}

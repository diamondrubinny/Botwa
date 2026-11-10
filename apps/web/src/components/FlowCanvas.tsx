import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent } from 'react';

/** What the canvas needs to know about a node (the editor keeps the full node). */
export interface CanvasNode { id: string; kind: string; typeLabel: string; title: string; subtitle: string; cls: string; ports: { key: string; label: string; to?: string }[] }
export type Pos = { x: number; y: number };

const W = 210, BASE_H = 66, PORT_GAP = 22, GRID = 10;
const heightOf = (n: CanvasNode) => (n.ports.length > 1 ? 58 + n.ports.length * PORT_GAP : BASE_H);
const snap = (v: number) => Math.round(v / GRID) * GRID;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Columns from the start node (right to left, like the reading direction); unplaced nodes only. */
export function autoLayout(nodes: CanvasNode[], start: string): Record<string, Pos> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const layer = new Map<string, number>([[start, 0]]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const n = byId.get(queue[i]!);
    if (!n) continue;
    for (const p of n.ports) if (p.to && byId.has(p.to) && !layer.has(p.to)) { layer.set(p.to, layer.get(n.id)! + 1); queue.push(p.to); }
  }
  const last = Math.max(0, ...layer.values()) + 1;
  for (const n of nodes) if (!layer.has(n.id)) layer.set(n.id, last);
  const maxL = Math.max(...layer.values());
  const yOf = new Map<number, number>();
  const out: Record<string, Pos> = {};
  for (const n of nodes) {
    const l = layer.get(n.id)!;
    const y = yOf.get(l) ?? 20;
    out[n.id] = { x: (maxL - l) * (W + 70) + 30, y };
    yOf.set(l, y + heightOf(n) + 22);
  }
  return out;
}

interface Props {
  nodes: CanvasNode[];
  start: string;
  layout: Record<string, Pos> | undefined;
  selected: string | null;
  canEdit: boolean;
  onSelect: (id: string) => void;
  /** live move while dragging (record = false) and the final position (record = true, one undo step) */
  onMove: (id: string, pos: Pos, record: boolean) => void;
  onConnect: (from: string, port: string, to: string) => void;
  onArrange: () => void;
  /** full screen: the canvas (and the editor panel next to it) fills the window */
  full?: boolean;
  onToggleFull?: () => void;
}

type Drag =
  | { kind: 'node'; id: string; from: Pos; grab: Pos; moved: boolean; pointer: number }
  | { kind: 'link'; id: string; port: string; from: Pos; at: Pos; pointer: number }
  | { kind: 'pan'; x: number; y: number; left: number; top: number; pointer: number };

/**
 * The flow chart: drag nodes to arrange them, drag from a node's round handle to another node to connect, zoom and fit.
 * Everything here also works without a mouse: arrow keys move the focused node, and every connection can be set in the node's form.
 */
export function FlowCanvas({ nodes, start, layout, selected, canEdit, onSelect, onMove, onConnect, onArrange, full = false, onToggleFull }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useState({ left: 0, top: 0, w: 0, h: 0 });     // the visible part, for the minimap
  const [q, setQ] = useState('');
  const [hit, setHit] = useState(0);
  const [showMap, setShowMap] = useState(() => { try { return localStorage.getItem('botwa.flowMap') !== '0'; } catch { return true; } });
  const toggleMap = () => setShowMap((v) => { try { localStorage.setItem('botwa.flowMap', v ? '0' : '1'); } catch { /* storage blocked: keep it for this visit only */ } return !v; });
  const fitted = useRef(false);
  const zoomAnchor = useRef<{ cx: number; cy: number } | null>(null);

  const auto = useMemo(() => autoLayout(nodes, start), [nodes, start]);
  const pos = (id: string): Pos => layout?.[id] ?? auto[id] ?? { x: 20, y: 20 };
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const bounds = useMemo(() => {
    let w = 900, h = 520;
    for (const n of nodes) { const p = layout?.[n.id] ?? auto[n.id]!; w = Math.max(w, p.x + W + 120); h = Math.max(h, p.y + heightOf(n) + 120); }
    return { w, h };
  }, [nodes, layout, auto]);

  const toSvg = (clientX: number, clientY: number): Pos => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = clientX; pt.y = clientY;
    const m = svg.getScreenCTM();
    const r = m ? pt.matrixTransform(m.inverse()) : pt;
    return { x: r.x, y: r.y };
  };
  const portPos = (n: CanvasNode, i: number): Pos => {
    const p = pos(n.id);
    return n.ports.length > 1 ? { x: p.x, y: p.y + 66 + i * PORT_GAP } : { x: p.x, y: p.y + heightOf(n) / 2 };
  };

  // pointer moves / ends are followed on the window so a fast drag never "loses" the node
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      if (e.pointerId !== drag.pointer) return;
      if (drag.kind === 'pan') {
        const w = wrapRef.current; if (!w) return;
        w.scrollLeft = drag.left - (e.clientX - drag.x);
        w.scrollTop = drag.top - (e.clientY - drag.y);
        return;
      }
      const at = toSvg(e.clientX, e.clientY);
      if (drag.kind === 'node') {
        const next = { x: Math.max(0, snap(at.x - drag.grab.x)), y: Math.max(0, snap(at.y - drag.grab.y)) };
        if (!drag.moved && Math.hypot(next.x - drag.from.x, next.y - drag.from.y) < 6) return;
        if (!drag.moved) setDrag({ ...drag, moved: true });
        onMove(drag.id, next, false);
      } else {
        setDrag({ ...drag, at });
        const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-node-id]');
        setHover(el ? el.getAttribute('data-node-id') : null);
      }
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== drag.pointer) return;
      if (drag.kind === 'pan') { setDrag(null); return; }
      if (drag.kind === 'node') {
        if (drag.moved) onMove(drag.id, pos(drag.id), true); else onSelect(drag.id);
      } else {
        const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-node-id]');
        const to = el?.getAttribute('data-node-id');
        if (to && to !== drag.id) onConnect(drag.id, drag.port, to);
      }
      setDrag(null); setHover(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
  });  // eslint-disable-line react-hooks/exhaustive-deps

  const startNodeDrag = (e: RPointerEvent, id: string) => {
    if (e.button !== 0) return;
    if (!canEdit) { onSelect(id); return; }
    e.preventDefault();
    const p = pos(id), at = toSvg(e.clientX, e.clientY);
    setDrag({ kind: 'node', id, from: p, grab: { x: at.x - p.x, y: at.y - p.y }, moved: false, pointer: e.pointerId });
  };
  const startLink = (e: RPointerEvent, n: CanvasNode, i: number) => {
    if (!canEdit || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const from = portPos(n, i);
    setDrag({ kind: 'link', id: n.id, port: n.ports[i]!.key, from, at: from, pointer: e.pointerId });
  };
  const keyMove = (e: RKeyboardEvent, id: string) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(id); return; }
    if (!canEdit) return;
    const step = e.shiftKey ? 50 : GRID;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    const p = pos(id);
    onMove(id, { x: Math.max(0, p.x + d[0]!), y: Math.max(0, p.y + d[1]!) }, true);
  };
  const clampZ = (z: number) => Math.max(0.25, Math.min(1.6, Math.round(z * 100) / 100));
  /** change the zoom keeping the middle of what is on screen in the middle */
  const zoomTo = (z: number) => {
    const w = wrapRef.current;
    if (w) zoomAnchor.current = { cx: (w.scrollLeft + w.clientWidth / 2) / zoom, cy: (w.scrollTop + w.clientHeight / 2) / zoom };
    setZoom(clampZ(z));
  };
  useLayoutEffect(() => {
    const w = wrapRef.current, a = zoomAnchor.current;
    if (!w || !a) return;
    zoomAnchor.current = null;
    w.scrollLeft = a.cx * zoom - w.clientWidth / 2;
    w.scrollTop = a.cy * zoom - w.clientHeight / 2;
  }, [zoom]);
  /** the whole chart on screen (width and height) */
  const fit = () => {
    const w = wrapRef.current;
    if (!w) return;
    // everything on screen, but never so small that it cannot be read (then the minimap and search help to move around)
    setZoom(clampZ(Math.max(0.45, Math.min(1.1, (w.clientWidth - 16) / bounds.w, (w.clientHeight - 16) / bounds.h))));
    requestAnimationFrame(() => { w.scrollLeft = w.scrollWidth; w.scrollTop = 0; });   // the start is on the right
  };
  // first time a chart is shown, and when switching to full screen: fit it, so everything is visible without zooming by hand
  useEffect(() => { if (nodes.length && !fitted.current) { fitted.current = true; fit(); } });  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (nodes.length) requestAnimationFrame(fit); }, [full]);  // eslint-disable-line react-hooks/exhaustive-deps
  const wheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoomTo(zoom - Math.sign(e.deltaY) * 0.1);
  };
  const track = () => { const w = wrapRef.current; if (w) setView({ left: w.scrollLeft, top: w.scrollTop, w: w.clientWidth, h: w.clientHeight }); };
  useEffect(track, [zoom, bounds.w, bounds.h, full]);  // eslint-disable-line react-hooks/exhaustive-deps
  /** bring a node to the middle of the screen */
  const reveal = (id: string) => {
    const w = wrapRef.current, n = byId.get(id);
    if (!w || !n) return;
    const p = pos(id);
    const x = (p.x + W / 2) * zoom, y = (p.y + heightOf(n) / 2) * zoom;
    if (x < w.scrollLeft + 40 || x > w.scrollLeft + w.clientWidth - 40 || y < w.scrollTop + 40 || y > w.scrollTop + w.clientHeight - 40) {
      w.scrollTo({ left: x - w.clientWidth / 2, top: y - w.clientHeight / 2, behavior: 'smooth' });
    }
  };
  // a node chosen elsewhere (the list, a search) is scrolled into view
  useEffect(() => { if (selected && !drag) reveal(selected); }, [selected]);  // eslint-disable-line react-hooks/exhaustive-deps
  const startPan = (e: RPointerEvent) => {
    if (e.button !== 0 || (e.target as Element).closest('[data-node-id]')) return;
    const w = wrapRef.current; if (!w) return;
    e.preventDefault();
    setDrag({ kind: 'pan', x: e.clientX, y: e.clientY, left: w.scrollLeft, top: w.scrollTop, pointer: e.pointerId });
  };
  // search: matching nodes are marked; Enter goes to the next one
  const needle = q.trim().toLowerCase();
  const matches = needle ? nodes.filter((n) => `${n.title} ${n.subtitle} ${n.typeLabel} ${n.ports.map((p) => p.label).join(' ')}`.toLowerCase().includes(needle)).map((n) => n.id) : [];
  const goHit = (i: number) => { if (!matches.length) return; const k = ((i % matches.length) + matches.length) % matches.length; setHit(k); reveal(matches[k]!); };
  const low = zoom < 0.62;   // zoomed out: bigger, single-line labels so the chart stays readable

  const edgePath = (a: Pos, b: CanvasNode) => {
    const t = pos(b.id), th = heightOf(b);
    if (t.x + W <= a.x - 20) {
      // forward (the target is further along, to the left): into its right side
      const tx = t.x + W, ty = t.y + th / 2;
      const dx = Math.max(50, (a.x - tx) / 2);
      return { d: `M${a.x} ${a.y} C${a.x - dx} ${a.y} ${tx + dx} ${ty} ${tx} ${ty}`, mid: { x: (a.x + tx) / 2, y: (a.y + ty) / 2 } };
    }
    // back to an earlier node (a loop): around below, into its bottom
    const tx = t.x + W / 2, ty = t.y + th;
    const low = Math.max(a.y, ty) + 50;
    return { d: `M${a.x} ${a.y} C${a.x - 70} ${a.y} ${a.x - 70} ${low} ${(a.x + tx) / 2} ${low} S${tx} ${ty + 50} ${tx} ${ty}`, mid: { x: (a.x + tx) / 2, y: low } };
  };

  return (
    <div className="flow-canvas">
      <div className="flow-toolbar" role="toolbar" aria-label="תצוגת התרשים">
        <button type="button" onClick={() => zoomTo(zoom - 0.1)} aria-label="הקטנת התצוגה">−</button>
        <span className="flow-zoom" aria-live="polite">{Math.round(zoom * 100)}%</span>
        <button type="button" onClick={() => zoomTo(zoom + 0.1)} aria-label="הגדלת התצוגה">+</button>
        <button type="button" onClick={fit}>התאמה למסך</button>
        <button type="button" onClick={() => zoomTo(1)}>100%</button>
        {onToggleFull && <button type="button" aria-pressed={full} onClick={onToggleFull}>{full ? 'יציאה ממסך מלא' : 'מסך מלא'}</button>}
        <button type="button" aria-pressed={showMap} onClick={toggleMap}>מפה קטנה</button>
        {canEdit && <button type="button" onClick={onArrange}>סידור אוטומטי</button>}
        <span className="flow-search">
          <label htmlFor="flow-q" className="sr-only">חיפוש צומת</label>
          <input id="flow-q" type="search" placeholder="חיפוש צומת…" value={q} onChange={(e) => { setQ(e.target.value); setHit(0); const v = e.target.value.trim().toLowerCase(); const first = v ? nodes.find((n) => `${n.title} ${n.subtitle} ${n.typeLabel} ${n.ports.map((p) => p.label).join(' ')}`.toLowerCase().includes(v)) : undefined; if (first) reveal(first.id); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); goHit(e.shiftKey ? hit - 1 : hit + 1); } }} />
          {needle && <span className="hint" aria-live="polite">{matches.length ? `${hit + 1} מתוך ${matches.length}` : 'לא נמצא'}</span>}
          {matches.length > 0 && <button type="button" onClick={() => onSelect(matches[hit]!)}>פתיחה</button>}
        </span>
        <span className="hint flow-help">{canEdit ? 'גוררים רקע ריק כדי לנוע בתרשים, וצומת כדי להזיז אותו (או חצים כשהוא מסומן). מושכים מהעיגול שבצד שמאל של צומת אל צומת אחר כדי לחבר. Ctrl+גלגלת לזום, Ctrl+Z מבטל.' : 'גוררים רקע ריק כדי לנוע. לחיצה על צומת מציגה את פרטיו.'}</span>
      </div>
      <div className="flow-stage">
      <div className="flow-scroll" ref={wrapRef} onWheel={wheel} onScroll={track}>
        <svg ref={svgRef} width={bounds.w * zoom} height={bounds.h * zoom} viewBox={`0 0 ${bounds.w} ${bounds.h}`} className={`flow-svg${drag ? ' dragging' : ''}${drag?.kind === 'pan' ? ' panning' : ''}${low ? ' low' : ''}`} role="group" aria-label="תרשים הזרימה" onPointerDown={startPan}>
          <defs>
            <pattern id="fgrid" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" className="flow-dot" /></pattern>
            <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" className="flow-arrow" /></marker>
            <marker id="arr-hl" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" className="flow-arrow hl" /></marker>
          </defs>
          <rect x="0" y="0" width={bounds.w} height={bounds.h} fill="url(#fgrid)" aria-hidden="true" />
          <g aria-hidden="true">
            {nodes.flatMap((n) => n.ports.map((p, i) => {
              const to = p.to ? byId.get(p.to) : undefined;
              if (!to) return null;
              const { d, mid } = edgePath(portPos(n, i), to);
              const hl = selected === n.id || selected === to.id;
              return (
                <g key={`${n.id}-${p.key}`} className={`flow-edge-g${hl ? ' hl' : ''}`}>
                  <path d={d} className="flow-edge" markerEnd={hl ? 'url(#arr-hl)' : 'url(#arr)'} />
                  {p.label && n.ports.length > 1 && n.kind !== 'menu' && <text x={mid.x} y={mid.y - 6} textAnchor="middle" className="flow-edge-label">{p.label}</text>}
                </g>
              );
            }))}
            {drag?.kind === 'link' && <path d={`M${drag.from.x} ${drag.from.y} C${drag.from.x - 60} ${drag.from.y} ${drag.at.x + 60} ${drag.at.y} ${drag.at.x} ${drag.at.y}`} className="flow-edge temp" />}
          </g>
          {nodes.map((n) => {
            const p = pos(n.id), h = heightOf(n);
            const isStart = start === n.id;
            const targets = n.ports.filter((x) => x.to).map((x) => byId.get(x.to!)?.title).filter(Boolean);
            return (
              <g key={n.id} data-node-id={n.id} className={`flow-node ${n.cls}${selected === n.id ? ' sel' : ''}${matches.includes(n.id) ? ' match' : ''}${hover === n.id ? ' drop' : ''}${drag?.kind === 'node' && drag.id === n.id && drag.moved ? ' lifting' : ''}`}
                role="button" tabIndex={0} aria-pressed={selected === n.id} aria-describedby={`fdesc-${n.id}`}
                onPointerDown={(e) => startNodeDrag(e, n.id)} onKeyDown={(e) => keyMove(e, n.id)}>
                <desc id={`fdesc-${n.id}`}>{targets.length ? `ממשיך אל: ${targets.join(', ')}` : 'סוף הענף'}</desc>
                <rect x={p.x} y={p.y} width={W} height={h} rx="12" className="flow-box" />
                <rect x={p.x + W - 6} y={p.y} width="6" height={h} rx="3" className="flow-stripe" />
                {low ? (
                  <text x={p.x + W - 16} y={p.y + 41} className="flow-text-big" direction="rtl">{clip(n.subtitle || n.typeLabel, 13)}</text>
                ) : (<>
                  <text x={p.x + W - 16} y={p.y + 22} className="flow-type" direction="rtl">{clip(n.typeLabel, 26)}</text>
                  <text x={p.x + W - 16} y={p.y + 44} className="flow-text" direction="rtl">{clip(n.subtitle, 28)}</text>
                </>)}
                {isStart && <g><rect x={p.x + 8} y={p.y + 8} width="54" height="18" rx="9" className="flow-start" /><text x={p.x + 35} y={p.y + 21} textAnchor="middle" className="flow-start-t">התחלה</text></g>}
                {n.ports.map((port, i) => {
                  const pp = portPos(n, i);
                  return (
                    <g key={port.key} aria-hidden="true">
                      {n.ports.length > 1 && !low && <text x={p.x + W - 16} y={pp.y + 4} className="flow-port-label" direction="rtl">{clip(port.label, 26)}</text>}
                      {canEdit && <circle cx={pp.x} cy={pp.y} r="7" className={`flow-port${port.to ? ' on' : ''}`} onPointerDown={(e) => startLink(e, n, i)}><title>גררו אל צומת כדי לחבר{port.label ? ` (${port.label})` : ''}</title></circle>}
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
      {showMap && (bounds.w * zoom > view.w + 4 || bounds.h * zoom > view.h + 4) ? (
        <Minimap nodes={nodes} pos={pos} bounds={bounds} view={view} zoom={zoom} selected={selected}
          onJump={(cx, cy) => { const w = wrapRef.current; if (w) { w.scrollLeft = cx * zoom - w.clientWidth / 2; w.scrollTop = cy * zoom - w.clientHeight / 2; } }} />
      ) : null}
      </div>
    </div>
  );
}

/** A small overview of the whole chart with the visible part marked; click or drag on it to move there. Pointer only (the keyboard has search and the node list). */
function Minimap({ nodes, pos, bounds, view, zoom, selected, onJump }: { nodes: CanvasNode[]; pos: (id: string) => Pos; bounds: { w: number; h: number }; view: { left: number; top: number; w: number; h: number }; zoom: number; selected: string | null; onJump: (cx: number, cy: number) => void }) {
  const MW = 190;
  const scale = MW / bounds.w;
  const MH = Math.min(150, bounds.h * scale);
  const sy = MH / bounds.h;
  const at = (e: RPointerEvent<SVGSVGElement>) => { const r = e.currentTarget.getBoundingClientRect(); onJump(((e.clientX - r.left) / r.width) * bounds.w, ((e.clientY - r.top) / r.height) * bounds.h); };
  return (
    <svg className="flow-minimap" width={MW} height={MH} viewBox={`0 0 ${bounds.w} ${bounds.h}`} preserveAspectRatio="none" aria-hidden="true"
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); at(e); }} onPointerMove={(e) => { if (e.buttons === 1) at(e); }}>
      <rect x="0" y="0" width={bounds.w} height={bounds.h} className="mm-bg" />
      {nodes.map((n) => { const p = pos(n.id); return <rect key={n.id} x={p.x} y={p.y} width={W} height={heightOf(n)} rx="10" className={`mm-node${n.id === selected ? ' sel' : ''}`} />; })}
      <rect x={view.left / zoom} y={view.top / zoom} width={view.w / zoom} height={view.h / zoom} className="mm-view" style={{ strokeWidth: 2 / Math.min(scale, sy) }} />
    </svg>
  );
}

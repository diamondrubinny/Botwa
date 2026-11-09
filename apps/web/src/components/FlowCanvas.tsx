import { useEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent } from 'react';

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
    out[n.id] = { x: (maxL - l) * (W + 90) + 30, y };
    yOf.set(l, y + heightOf(n) + 34);
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
}

type Drag =
  | { kind: 'node'; id: string; from: Pos; grab: Pos; moved: boolean; pointer: number }
  | { kind: 'link'; id: string; port: string; from: Pos; at: Pos; pointer: number };

/**
 * The flow chart: drag nodes to arrange them, drag from a node's round handle to another node to connect, zoom and fit.
 * Everything here also works without a mouse: arrow keys move the focused node, and every connection can be set in the node's form.
 */
export function FlowCanvas({ nodes, start, layout, selected, canEdit, onSelect, onMove, onConnect, onArrange }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hover, setHover] = useState<string | null>(null);

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
  const fit = () => {
    const w = wrapRef.current?.clientWidth ?? 900;
    setZoom(Math.max(0.35, Math.min(1.25, Math.floor(((w - 24) / bounds.w) * 20) / 20)));
  };
  const wheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom((z) => Math.max(0.35, Math.min(1.6, Math.round((z - Math.sign(e.deltaY) * 0.1) * 10) / 10)));
  };

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
        <button type="button" onClick={() => setZoom((z) => Math.max(0.35, Math.round((z - 0.1) * 10) / 10))} aria-label="הקטנת התצוגה">−</button>
        <span className="flow-zoom" aria-live="polite">{Math.round(zoom * 100)}%</span>
        <button type="button" onClick={() => setZoom((z) => Math.min(1.6, Math.round((z + 0.1) * 10) / 10))} aria-label="הגדלת התצוגה">+</button>
        <button type="button" onClick={() => setZoom(1)}>100%</button>
        <button type="button" onClick={fit}>התאמה לרוחב</button>
        {canEdit && <button type="button" onClick={onArrange}>סידור אוטומטי</button>}
        <span className="hint flow-help">{canEdit ? 'גוררים צומת להזזה (או חצים כשהוא מסומן, Shift לצעד גדול). מושכים מהעיגול שבצד שמאל של צומת אל צומת אחר כדי לחבר. Ctrl+Z מבטל.' : 'לחיצה על צומת מציגה את פרטיו.'}</span>
      </div>
      <div className="flow-scroll" ref={wrapRef} onWheel={wheel}>
        <svg ref={svgRef} width={bounds.w * zoom} height={bounds.h * zoom} viewBox={`0 0 ${bounds.w} ${bounds.h}`} className={`flow-svg${drag ? ' dragging' : ''}`} role="group" aria-label="תרשים הזרימה">
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
              <g key={n.id} data-node-id={n.id} className={`flow-node ${n.cls}${selected === n.id ? ' sel' : ''}${hover === n.id ? ' drop' : ''}${drag?.kind === 'node' && drag.id === n.id && drag.moved ? ' lifting' : ''}`}
                role="button" tabIndex={0} aria-pressed={selected === n.id} aria-describedby={`fdesc-${n.id}`}
                onPointerDown={(e) => startNodeDrag(e, n.id)} onKeyDown={(e) => keyMove(e, n.id)}>
                <desc id={`fdesc-${n.id}`}>{targets.length ? `ממשיך אל: ${targets.join(', ')}` : 'סוף הענף'}</desc>
                <rect x={p.x} y={p.y} width={W} height={h} rx="12" className="flow-box" />
                <rect x={p.x + W - 6} y={p.y} width="6" height={h} rx="3" className="flow-stripe" />
                <text x={p.x + W - 16} y={p.y + 22} className="flow-type" direction="rtl">{clip(n.typeLabel, 26)}</text>
                {isStart && <g><rect x={p.x + 8} y={p.y + 8} width="54" height="18" rx="9" className="flow-start" /><text x={p.x + 35} y={p.y + 21} textAnchor="middle" className="flow-start-t">התחלה</text></g>}
                <text x={p.x + W - 16} y={p.y + 44} className="flow-text" direction="rtl">{clip(n.subtitle, 28)}</text>
                {n.ports.map((port, i) => {
                  const pp = portPos(n, i);
                  return (
                    <g key={port.key} aria-hidden="true">
                      {n.ports.length > 1 && <text x={p.x + W - 16} y={pp.y + 4} className="flow-port-label" direction="rtl">{clip(port.label, 26)}</text>}
                      {canEdit && <circle cx={pp.x} cy={pp.y} r="7" className={`flow-port${port.to ? ' on' : ''}`} onPointerDown={(e) => startLink(e, n, i)}><title>גררו אל צומת כדי לחבר{port.label ? ` (${port.label})` : ''}</title></circle>}
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

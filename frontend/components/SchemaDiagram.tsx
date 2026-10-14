'use client';
/**
 * Full-screen ER diagram of the selected database: every table as a card,
 * foreign keys as lines between the exact columns. Drag tables, drag the
 * background to pan, scroll (or the buttons) to zoom; hover or click a table
 * to light up its relationships.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TableInfo } from '@/lib/api';
import Icon from '@/components/Icon';
import { AnimatePresence, motion, ease, spring, softSpring } from '@/components/motion';

// Card geometry — edges are anchored to rows, so these must match the markup below
const W = 248;
const HEAD = 42;
const ROW = 26;
const PAD = 8;
const GAP_X = 110;
const GAP_Y = 36;
const MAX_COL_H = 1300;

interface Edge {
  id: string;
  from: string;
  fromCols: string[];
  to: string;
  toCols: string[];
  /** Guessed from a column name like customer_id (no foreign key declared) */
  inferred: boolean;
}
type Pos = Record<string, { x: number; y: number }>;
interface View {
  x: number;
  y: number;
  k: number;
}

const lc = (s: string) => s.toLowerCase();
const nodeHeight = (t: TableInfo) => HEAD + t.columns.length * ROW + PAD;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function buildEdges(tables: TableInfo[]): Edge[] {
  const byName = new Map(tables.map(t => [lc(t.name), t]));
  const edges: Edge[] = [];
  const covered = new Set<string>();

  for (const t of tables) {
    for (const fk of t.foreign_keys || []) {
      const target = byName.get(lc(fk.ref_table));
      if (!target) continue;
      edges.push({
        id: `${t.name}.${fk.columns.join(',')}`,
        from: t.name,
        fromCols: fk.columns,
        to: target.name,
        toCols: fk.ref_columns,
        inferred: false,
      });
      fk.columns.forEach(c => covered.add(`${lc(t.name)}.${lc(c)}`));
    }
  }

  // No declared key? Guess customer_id → customers(customer_id | id)
  for (const t of tables) {
    for (const col of t.columns) {
      const m = col.name.match(/^(.+?)_?id$/i);
      if (!m || covered.has(`${lc(t.name)}.${lc(col.name)}`)) continue;
      const base = lc(m[1]);
      const names = [base, `${base}s`, `${base}es`, base.replace(/y$/, 'ies')];
      const target = names.map(n => byName.get(n)).find(x => x && x.name !== t.name);
      if (!target) continue;
      const has = (n: string) => target.columns.find(c => lc(c.name) === lc(n))?.name;
      const toCol = has(col.name) || has('id') || target.primary_key?.[0];
      if (!toCol) continue;
      edges.push({
        id: `${t.name}.${col.name}~`,
        from: t.name,
        fromCols: [col.name],
        to: target.name,
        toCols: [toCol],
        inferred: true,
      });
    }
  }
  return edges;
}

/** Layered layout: referenced ("parent") tables on the left, tables that point to them on the right */
function layout(tables: TableInfo[], edges: Edge[]): Pos {
  const refs = new Map<string, Set<string>>();
  const degree = new Map<string, number>();
  for (const e of edges) {
    if (e.from === e.to) continue;
    if (!refs.has(e.from)) refs.set(e.from, new Set());
    refs.get(e.from)!.add(e.to);
    degree.set(e.from, (degree.get(e.from) || 0) + 1);
    degree.set(e.to, (degree.get(e.to) || 0) + 1);
  }

  const level = new Map<string, number>();
  const visiting = new Set<string>();
  const levelOf = (n: string): number => {
    if (level.has(n)) return level.get(n)!;
    if (visiting.has(n)) return 0; // cycle
    visiting.add(n);
    const parents = Array.from(refs.get(n) || []);
    const l = parents.length ? 1 + Math.max(...parents.map(levelOf)) : 0;
    visiting.delete(n);
    level.set(n, l);
    return l;
  };

  const connected = tables.filter(t => degree.has(t.name));
  const isolated = tables.filter(t => !degree.has(t.name));
  connected.forEach(t => levelOf(t.name));
  const maxLevel = connected.length ? Math.max(...connected.map(t => level.get(t.name)!)) : -1;

  // Group by level; order each level by its parents' positions to cut down crossings
  const groups: TableInfo[][] = [];
  for (let l = 0; l <= maxLevel; l++) groups.push([]);
  connected.forEach(t => groups[level.get(t.name)!].push(t));
  const index = new Map<string, number>();
  groups.forEach((g, l) => {
    if (l === 0) g.sort((a, b) => (degree.get(b.name) || 0) - (degree.get(a.name) || 0));
    else {
      const score = (t: TableInfo) => {
        const ps = Array.from(refs.get(t.name) || []).filter(p => index.has(p));
        return ps.length ? ps.reduce((s, p) => s + index.get(p)!, 0) / ps.length : 0;
      };
      g.sort((a, b) => score(a) - score(b));
    }
    g.forEach((t, i) => index.set(t.name, i));
  });
  if (isolated.length) groups.push(isolated);

  // Split tall levels into extra columns, then stack and center each column
  const columns: TableInfo[][] = [];
  for (const g of groups) {
    let col: TableInfo[] = [];
    let h = 0;
    for (const t of g) {
      const th = nodeHeight(t) + GAP_Y;
      if (col.length && h + th > MAX_COL_H) {
        columns.push(col);
        col = [];
        h = 0;
      }
      col.push(t);
      h += th;
    }
    if (col.length) columns.push(col);
  }
  const heights = columns.map(c => c.reduce((s, t) => s + nodeHeight(t) + GAP_Y, -GAP_Y));
  const tallest = Math.max(0, ...heights);
  const pos: Pos = {};
  columns.forEach((col, ci) => {
    let y = (tallest - heights[ci]) / 2;
    col.forEach(t => {
      pos[t.name] = { x: ci * (W + GAP_X), y };
      y += nodeHeight(t) + GAP_Y;
    });
  });
  return pos;
}

function rowY(t: TableInfo, col: string) {
  const i = t.columns.findIndex(c => lc(c.name) === lc(col));
  return i < 0 ? HEAD / 2 : HEAD + i * ROW + ROW / 2;
}

function edgePath(e: Edge, a: TableInfo, b: TableInfo, pos: Pos) {
  const pa = pos[a.name];
  const pb = pos[b.name];
  const sy = pa.y + rowY(a, e.fromCols[0]);
  const ty = pb.y + rowY(b, e.toCols[0]);
  if (a.name === b.name) {
    const x = pa.x + W;
    return {
      d: `M ${x} ${sy} C ${x + 70} ${sy}, ${x + 70} ${ty}, ${x} ${ty}`,
      sx: x,
      sy,
      tx: x,
      ty,
    };
  }
  // Overlapping columns: loop out of the right side of both cards
  if (Math.abs(pa.x - pb.x) < W) {
    const sx = pa.x + W;
    const tx = pb.x + W;
    const c = 50 + Math.abs(ty - sy) * 0.15;
    const out = Math.max(sx, tx) + c;
    return { d: `M ${sx} ${sy} C ${out} ${sy}, ${out} ${ty}, ${tx} ${ty}`, sx, sy, tx, ty };
  }
  const right = pb.x > pa.x;
  const sx = right ? pa.x + W : pa.x;
  const tx = right ? pb.x : pb.x + W;
  const dir = right ? 1 : -1;
  const c = Math.max(40, Math.abs(tx - sx) / 2);
  return {
    d: `M ${sx} ${sy} C ${sx + dir * c} ${sy}, ${tx - dir * c} ${ty}, ${tx} ${ty}`,
    sx,
    sy,
    tx,
    ty,
  };
}

export default function SchemaDiagram({
  tables,
  sourceName,
  focus,
  onClose,
}: {
  tables: TableInfo[];
  sourceName?: string;
  /** Table to select when the diagram opens */
  focus?: string | null;
  onClose: () => void;
}) {
  const edges = useMemo(() => buildEdges(tables), [tables]);
  const byName = useMemo(() => new Map(tables.map(t => [t.name, t])), [tables]);
  const initial = useMemo(() => layout(tables, edges), [tables, edges]);
  const [pos, setPos] = useState<Pos>(initial);
  const [view, setView] = useState<View>({ x: 40, y: 40, k: 1 });
  const [selected, setSelected] = useState<string | null>(focus ?? null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);
  const drag = useRef<
    | { kind: 'pan'; px: number; py: number; vx: number; vy: number; moved: boolean }
    | { kind: 'node'; name: string; px: number; py: number; nx: number; ny: number; moved: boolean }
    | null
  >(null);

  useEffect(() => setPos(initial), [initial]);

  const fit = useCallback(
    (p: Pos = pos) => {
      const box = boxRef.current;
      const names = Object.keys(p);
      if (!box || !names.length) return;
      const xs = names.map(n => p[n].x);
      const ys = names.map(n => p[n].y);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const maxX = Math.max(...xs) + W + 80; // room for self-loops
      const maxY = Math.max(...names.map(n => p[n].y + nodeHeight(byName.get(n)!)));
      const { width, height } = box.getBoundingClientRect();
      const k = clamp(
        Math.min((width - 64) / (maxX - minX), (height - 64) / (maxY - minY)),
        0.2,
        1,
      );
      setView({
        k,
        x: (width - (maxX - minX) * k) / 2 - minX * k,
        y: (height - (maxY - minY) * k) / 2 - minY * k,
      });
    },
    [pos, byName],
  );

  const centerOn = useCallback(
    (name: string) => {
      const box = boxRef.current;
      const p = pos[name];
      const t = byName.get(name);
      if (!box || !p || !t) return;
      const { width, height } = box.getBoundingClientRect();
      setView(v => {
        const k = Math.max(v.k, 0.8);
        return {
          k,
          x: width / 2 - (p.x + W / 2) * k,
          y: height / 2 - (p.y + nodeHeight(t) / 2) * k,
        };
      });
    },
    [pos, byName],
  );

  // Fit once on open, then jump to the requested table
  useLayoutEffect(() => {
    fit(initial);
    if (focus && initial[focus]) requestAnimationFrame(() => centerOn(focus));
  }, [initial]); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Wheel zoom around the cursor (non-passive so the page does not scroll)
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = box.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      setView(v => {
        const k = clamp(v.k * Math.exp(-e.deltaY * 0.0015), 0.15, 2.5);
        return { k, x: mx - (mx - v.x) * (k / v.k), y: my - (my - v.y) * (k / v.k) };
      });
    };
    box.addEventListener('wheel', onWheel, { passive: false });
    return () => box.removeEventListener('wheel', onWheel);
  }, []);

  const zoomBy = (f: number) => {
    const box = boxRef.current;
    if (!box) return;
    const { width, height } = box.getBoundingClientRect();
    setView(v => {
      const k = clamp(v.k * f, 0.15, 2.5);
      return {
        k,
        x: width / 2 - (width / 2 - v.x) * (k / v.k),
        y: height / 2 - (height / 2 - v.y) * (k / v.k),
      };
    });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const card = (e.target as HTMLElement).closest('[data-node]') as HTMLElement | null;
    const name = card?.dataset.node;
    if (name && pos[name]) {
      drag.current = {
        kind: 'node',
        name,
        px: e.clientX,
        py: e.clientY,
        nx: pos[name].x,
        ny: pos[name].y,
        moved: false,
      };
    } else {
      drag.current = {
        kind: 'pan',
        px: e.clientX,
        py: e.clientY,
        vx: view.x,
        vy: view.y,
        moved: false,
      };
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (d.kind === 'pan') setView(v => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
    else setPos(p => ({ ...p, [d.name]: { x: d.nx + dx / view.k, y: d.ny + dy / view.k } }));
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved) return;
    if (d.kind === 'pan') setSelected(null);
    else setSelected(s => (s === d.name ? null : d.name));
  };

  const q = lc(search.trim());
  const matches = useMemo(
    () =>
      q
        ? tables.filter(t => lc(t.name).includes(q) || t.columns.some(c => lc(c.name).includes(q)))
        : [],
    [q, tables],
  );

  const active = hovered ?? selected;
  const activeEdges = useMemo(
    () =>
      new Set(active ? edges.filter(e => e.from === active || e.to === active).map(e => e.id) : []),
    [active, edges],
  );
  const neighbours = useMemo(() => {
    const s = new Set<string>();
    if (active) {
      s.add(active);
      edges.forEach(e => {
        if (e.from === active) s.add(e.to);
        if (e.to === active) s.add(e.from);
      });
    }
    return s;
  }, [active, edges]);
  // Columns that take part in a lit relationship
  const litCols = useMemo(() => {
    const s = new Set<string>();
    edges.forEach(e => {
      if (!activeEdges.has(e.id)) return;
      e.fromCols.forEach(c => s.add(`${e.from}.${lc(c)}`));
      e.toCols.forEach(c => s.add(`${e.to}.${lc(c)}`));
    });
    return s;
  }, [edges, activeEdges]);

  const fkCols = useMemo(() => {
    const s = new Set<string>();
    edges.forEach(e => e.fromCols.forEach(c => s.add(`${e.from}.${lc(c)}`)));
    return s;
  }, [edges]);

  const sel = selected ? byName.get(selected) : undefined;
  const declared = edges.filter(e => !e.inferred).length;

  // Opening animation: cards pop in left to right, then the links draw themselves
  const rank = useMemo(() => {
    const order = Object.keys(initial).sort(
      (a, b) => initial[a].x - initial[b].x || initial[a].y - initial[b].y,
    );
    return new Map(order.map((n, i) => [n, i]));
  }, [initial]);
  const cardDelay = (name: string) => 0.18 + Math.min(rank.get(name) ?? 0, 16) * 0.05;
  const edgeStart = 0.38 + Math.min(tables.length, 16) * 0.05;
  const edgeDelay = (i: number) => edgeStart + Math.min(i, 12) * 0.05;
  const [intro, setIntro] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setIntro(false), (edgeDelay(edges.length) + 0.7) * 1000);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <motion.div
      className="fixed inset-0 z-50 flex flex-col bg-slate-50"
      initial={{ opacity: 0, scale: 0.94, y: 24, filter: 'blur(8px)' }}
      animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)', transition: softSpring }}
      exit={{
        opacity: 0,
        scale: 0.96,
        y: 16,
        filter: 'blur(6px)',
        transition: { duration: 0.2, ease: [0.4, 0, 1, 1] },
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Schema diagram"
    >
      {/* Toolbar */}
      <motion.div
        initial={{ opacity: 0, y: -14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ ...ease, delay: 0.08 }}
        className="relative z-10 flex flex-wrap items-center gap-2 px-3 sm:px-4 py-2.5 bg-white/95 backdrop-blur border-b border-slate-200 shadow-[0_1px_8px_rgba(15,23,42,0.04)]"
      >
        <motion.span
          initial={{ scale: 0.4, rotate: -90, opacity: 0 }}
          animate={{ scale: 1, rotate: 0, opacity: 1 }}
          transition={{ ...spring, delay: 0.15 }}
          className="w-8 h-8 rounded-lg bg-gradient-to-br from-teal-500 to-teal-700 text-white shadow-teal flex items-center justify-center"
        >
          <Icon name="diagram" size={16} />
        </motion.span>
        <div className="min-w-0 mr-2">
          <p className="text-sm font-semibold text-slate-900 truncate">
            Schema diagram{sourceName ? ` · ${sourceName}` : ''}
          </p>
          <p className="text-[11px] text-slate-500">
            {tables.length} tables · {declared} foreign keys
            {edges.length > declared && ` · ${edges.length - declared} guessed`}
          </p>
        </div>
        <div className="relative w-full sm:w-56 order-last sm:order-none">
          <Icon
            name="search"
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
          />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && matches[0]) {
                setSelected(matches[0].name);
                centerOn(matches[0].name);
              }
            }}
            placeholder="Find a table or column"
            className="input pl-8 py-1.5 text-[13px]"
          />
        </div>
        <span className="flex-1" />
        <div className="flex items-center gap-0.5 rounded-xl border border-slate-200 p-0.5">
          <button
            onClick={() => zoomBy(1 / 1.2)}
            className="btn-icon w-8 h-8"
            aria-label="Zoom out"
            title="Zoom out"
          >
            <Icon name="minus" size={15} />
          </button>
          <span className="w-11 text-center text-xs tabular-nums text-slate-600">
            {Math.round(view.k * 100)}%
          </span>
          <button
            onClick={() => zoomBy(1.2)}
            className="btn-icon w-8 h-8"
            aria-label="Zoom in"
            title="Zoom in"
          >
            <Icon name="plus" size={15} />
          </button>
          <button
            onClick={() => fit()}
            className="btn-icon w-8 h-8"
            aria-label="Fit to screen"
            title="Fit to screen"
          >
            <Icon name="maximize" size={15} />
          </button>
          <button
            onClick={() => {
              setPos(initial);
              fit(initial);
            }}
            className="btn-icon w-8 h-8"
            aria-label="Reset layout"
            title="Reset layout"
          >
            <Icon name="refresh" size={14} />
          </button>
        </div>
        <button
          onClick={onClose}
          className="btn-icon w-8 h-8"
          aria-label="Close diagram"
          title="Close (Esc)"
        >
          <Icon name="x" size={17} />
        </button>
      </motion.div>

      <div className="relative flex-1 overflow-hidden">
        {/* Canvas */}
        <motion.div
          ref={boxRef}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4, delay: 0.1 }}
          className="absolute inset-0 select-none cursor-grab active:cursor-grabbing"
          style={{
            touchAction: 'none',
            backgroundImage: 'radial-gradient(circle, #cbd5e1 1px, transparent 1px)',
            backgroundSize: `${22 * view.k}px ${22 * view.k}px`,
            backgroundPosition: `${view.x}px ${view.y}px`,
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => (drag.current = null)}
        >
          {tables.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center">
              <Icon name="table" size={26} className="text-slate-300" />
              <p className="text-sm font-medium text-slate-600 mt-2">No tables to show</p>
            </div>
          ) : (
            <div
              className="absolute left-0 top-0 origin-top-left"
              style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
            >
              <svg className="absolute left-0 top-0 overflow-visible" width={1} height={1}>
                <defs>
                  {['idle', 'lit'].map(m => (
                    <marker
                      key={m}
                      id={`arrow-${m}`}
                      viewBox="0 0 10 10"
                      refX="9"
                      refY="5"
                      markerWidth="7"
                      markerHeight="7"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 0 L 10 5 L 0 10 z" fill={m === 'lit' ? '#0E9999' : '#94A3B8'} />
                    </marker>
                  ))}
                </defs>
                {edges.map((e, i) => {
                  const a = byName.get(e.from);
                  const b = byName.get(e.to);
                  if (!a || !b || !pos[a.name] || !pos[b.name]) return null;
                  const g = edgePath(e, a, b, pos);
                  const lit = activeEdges.has(e.id);
                  const dim = !!active && !lit;
                  return (
                    <g key={e.id} opacity={dim ? 0.18 : 1} style={{ transition: 'opacity 200ms' }}>
                      {intro ? (
                        // Draws the line from the foreign-key column to the table it points to
                        <motion.path
                          d={g.d}
                          fill="none"
                          stroke="#0E9999"
                          strokeWidth={2}
                          initial={{ pathLength: 0, opacity: 0 }}
                          animate={{ pathLength: 1, opacity: 1 }}
                          transition={{
                            pathLength: {
                              duration: 0.65,
                              ease: [0.65, 0, 0.35, 1],
                              delay: edgeDelay(i),
                            },
                            opacity: { duration: 0.1, delay: edgeDelay(i) },
                          }}
                        />
                      ) : (
                        <path
                          d={g.d}
                          fill="none"
                          stroke={lit ? '#0E9999' : '#94A3B8'}
                          strokeWidth={lit ? 2.25 : 1.5}
                          strokeDasharray={lit ? '7 5' : e.inferred ? '4 4' : undefined}
                          markerEnd={`url(#arrow-${lit ? 'lit' : 'idle'})`}
                          className={lit ? 'animate-dash-flow' : ''}
                        />
                      )}
                      <motion.circle
                        cx={g.sx}
                        cy={g.sy}
                        r={3.5}
                        fill={lit ? '#0E9999' : '#94A3B8'}
                        initial={{ scale: 0, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ ...spring, delay: intro ? edgeDelay(i) : 0 }}
                        style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
                      />
                    </g>
                  );
                })}
              </svg>

              {tables.map(t => {
                const p = pos[t.name];
                if (!p) return null;
                const pk = new Set((t.primary_key || []).map(lc));
                const isActive = active === t.name;
                const dim = !!active && !neighbours.has(t.name);
                const hit = q && matches.some(m => m.name === t.name);
                return (
                  <div
                    key={t.name}
                    data-node={t.name}
                    onPointerEnter={() => !drag.current && setHovered(t.name)}
                    onPointerLeave={() => setHovered(h => (h === t.name ? null : h))}
                    className={`absolute cursor-pointer transition-opacity duration-200 ${dim ? 'opacity-35' : ''}`}
                    style={{ left: p.x, top: p.y, width: W }}
                  >
                    <motion.div
                      initial={{ opacity: 0, scale: 0.82, y: 18 }}
                      animate={{ opacity: 1, scale: isActive ? 1.02 : 1, y: 0 }}
                      transition={{ ...spring, delay: intro ? cardDelay(t.name) : 0 }}
                      className={`rounded-xl bg-white border shadow-sm transition-[box-shadow,border-color] duration-200 ${
                        isActive
                          ? 'border-teal-500 shadow-teal-lg'
                          : hit
                            ? 'border-amber-400 ring-2 ring-amber-200'
                            : 'border-slate-200 hover:shadow-md'
                      }`}
                    >
                      <div
                        className={`flex items-center gap-2 px-3 rounded-t-xl border-b cursor-grab active:cursor-grabbing ${
                          isActive
                            ? 'bg-teal-600 text-white border-teal-600'
                            : 'bg-slate-50 border-slate-200'
                        }`}
                        style={{ height: HEAD - 1 }}
                      >
                        <Icon
                          name="table"
                          size={14}
                          className={isActive ? 'text-teal-100' : 'text-teal-600'}
                        />
                        <span
                          className="font-mono text-[13px] font-semibold truncate flex-1"
                          title={t.name}
                        >
                          {t.name}
                        </span>
                        <span
                          className={`text-[10.5px] tabular-nums ${isActive ? 'text-teal-100' : 'text-slate-400'}`}
                        >
                          {typeof t.row_count === 'number'
                            ? `${t.row_count.toLocaleString()} rows`
                            : `${t.columns.length} cols`}
                        </span>
                      </div>
                      <ul style={{ paddingBottom: PAD }}>
                        {t.columns.map(c => {
                          const key = `${t.name}.${lc(c.name)}`;
                          const isPk = pk.has(lc(c.name));
                          const isFk = fkCols.has(key);
                          const lit = litCols.has(key);
                          const colHit = q && lc(c.name).includes(q);
                          return (
                            <li
                              key={c.name}
                              className={`flex items-center gap-2 px-3 text-xs transition-colors ${
                                lit ? 'bg-teal-50' : colHit ? 'bg-amber-50' : ''
                              }`}
                              style={{ height: ROW }}
                            >
                              <span className="w-6 flex-shrink-0 flex">
                                {isPk ? (
                                  <span className="text-[9px] font-bold px-1 rounded bg-amber-100 text-amber-700">
                                    PK
                                  </span>
                                ) : isFk ? (
                                  <span className="text-[9px] font-bold px-1 rounded bg-indigo-100 text-indigo-700">
                                    FK
                                  </span>
                                ) : null}
                              </span>
                              <span
                                className={`font-mono truncate flex-1 ${lit ? 'text-teal-800 font-semibold' : 'text-slate-700'}`}
                                title={c.name}
                              >
                                {c.name}
                              </span>
                              <span className="font-mono text-[10px] text-slate-400 uppercase flex-shrink-0">
                                {c.type.split('(')[0]}
                                {c.nullable === false && !isPk && (
                                  <span className="text-slate-500"> *</span>
                                )}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </motion.div>
                  </div>
                );
              })}
            </div>
          )}
        </motion.div>

        {/* Legend + hint */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...ease, delay: edgeStart }}
          className="pointer-events-none absolute left-3 bottom-3 flex flex-col gap-1.5 rounded-xl bg-white/90 backdrop-blur border border-slate-200 px-3 py-2 text-[11px] text-slate-600 shadow-sm"
        >
          <span className="flex items-center gap-2">
            <span className="text-[9px] font-bold px-1 rounded bg-amber-100 text-amber-700">
              PK
            </span>{' '}
            primary key
            <span className="text-[9px] font-bold px-1 rounded bg-indigo-100 text-indigo-700 ml-2">
              FK
            </span>{' '}
            foreign key
          </span>
          <span className="flex items-center gap-2">
            <svg width="26" height="6">
              <line x1="0" y1="3" x2="26" y2="3" stroke="#94A3B8" strokeWidth="1.5" />
            </svg>
            declared link
            <svg width="26" height="6" className="ml-2">
              <line
                x1="0"
                y1="3"
                x2="26"
                y2="3"
                stroke="#94A3B8"
                strokeWidth="1.5"
                strokeDasharray="4 4"
              />
            </svg>
            guessed from name
          </span>
          <span className="hidden sm:block text-slate-400">
            Drag tables · drag the background to pan · scroll to zoom · click a table for details
          </span>
        </motion.div>

        {/* Details of the selected table */}
        <AnimatePresence>
          {sel && (
            <motion.aside
              key={sel.name}
              initial={{ opacity: 0, x: 24, scale: 0.96 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 16, scale: 0.98, transition: { duration: 0.15 } }}
              transition={spring}
              className="absolute right-3 top-3 w-72 max-w-[calc(100%-24px)] max-h-[calc(100%-24px)] overflow-y-auto card p-4 shadow-lg origin-top-right"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="label">Table</p>
                  <p className="font-mono font-semibold text-slate-900 truncate">{sel.name}</p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {sel.columns.length} columns
                    {typeof sel.row_count === 'number' &&
                      ` · ${sel.row_count.toLocaleString()} rows`}
                    {sel.primary_key?.length ? ` · key: ${sel.primary_key.join(', ')}` : ''}
                  </p>
                </div>
                <button
                  onClick={() => setSelected(null)}
                  className="btn-icon w-7 h-7 -mr-1"
                  aria-label="Close details"
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
              <Relations
                title="Points to"
                items={edges.filter(e => e.from === sel.name && e.to !== sel.name)}
                other={e => e.to}
                text={e => `${e.fromCols.join(', ')} → ${e.to}.${e.toCols.join(', ')}`}
                onPick={n => {
                  setSelected(n);
                  centerOn(n);
                }}
              />
              <Relations
                title="Used by"
                items={edges.filter(e => e.to === sel.name && e.from !== sel.name)}
                other={e => e.from}
                text={e => `${e.from}.${e.fromCols.join(', ')} → ${e.toCols.join(', ')}`}
                onPick={n => {
                  setSelected(n);
                  centerOn(n);
                }}
              />
            </motion.aside>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

function Relations({
  title,
  items,
  other,
  text,
  onPick,
}: {
  title: string;
  items: Edge[];
  other: (e: Edge) => string;
  text: (e: Edge) => string;
  onPick: (name: string) => void;
}) {
  return (
    <div className="mt-3">
      <p className="label mb-1">
        {title} ({items.length})
      </p>
      {items.length === 0 ? (
        <p className="text-xs text-slate-400">None</p>
      ) : (
        <ul className="space-y-1">
          {items.map(e => (
            <li key={e.id}>
              <button
                onClick={() => onPick(other(e))}
                className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-slate-100 text-xs"
              >
                <span className="font-mono text-slate-700 break-all">{text(e)}</span>
                {e.inferred && <span className="ml-1 text-[10px] text-slate-400">(guessed)</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

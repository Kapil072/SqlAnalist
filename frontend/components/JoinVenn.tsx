'use client';
/** Draws each JOIN of an answer's SQL as two overlapping circles (a Venn diagram). */
import { useId } from 'react';
import Icon from '@/components/Icon';
import type { JoinInfo, JoinKind } from '@/lib/sqlJoins';

const LABEL: Record<JoinKind, string> = {
  inner: 'INNER JOIN',
  left: 'LEFT JOIN',
  right: 'RIGHT JOIN',
  full: 'FULL OUTER JOIN',
  cross: 'CROSS JOIN',
};

// Matched rows (the shared part) are dark; rows kept without a match are light
const MATCH = '#0E9999';
const KEPT = '#B1E5E6';
const IDLE = '#F1F5F9';
const LEFT_STROKE = '#0B7A7A';
const RIGHT_STROKE = '#6366F1';

function explain(j: JoinInfo): string {
  const key = j.on.length ? j.on.map(([a, b]) => (a === b ? a : `${a} = ${b}`)).join(', ') : '';
  const match = key ? ` where ${key} matches` : ' that match';
  switch (j.kind) {
    case 'inner':
      return `Keeps only rows found in both ${j.left} and ${j.right}${match}. Rows without a partner are dropped.`;
    case 'left':
      return `Keeps every row of ${j.left}, plus the matching ${j.right} rows${match}. Where ${j.right} has no match, its columns are empty.`;
    case 'right':
      return `Keeps every row of ${j.right}, plus the matching ${j.left} rows${match}. Where ${j.left} has no match, its columns are empty.`;
    case 'full':
      return `Keeps all rows from both tables. Rows that match${key ? ` on ${key}` : ''} are combined; the rest have empty columns on the other side.`;
    case 'cross':
      return `Pairs every row of ${j.left} with every row of ${j.right} — no shared column is used.`;
  }
}

function Venn({ join }: { join: JoinInfo }) {
  const id = useId().replace(/:/g, '');
  const cross = join.kind === 'cross';
  const r = 46;
  // Circles overlap for real joins; sit apart for CROSS JOIN
  const lx = cross ? 70 : 98;
  const rx = cross ? 190 : 162;
  const cy = 62;
  const leftFill = join.kind === 'left' || join.kind === 'full' || cross ? KEPT : IDLE;
  const rightFill = join.kind === 'right' || join.kind === 'full' || cross ? KEPT : IDLE;

  return (
    <svg
      viewBox="0 0 260 132"
      className="w-full max-w-[300px] h-auto"
      role="img"
      aria-label={LABEL[join.kind]}
    >
      <defs>
        <clipPath id={`l${id}`}>
          <circle cx={lx} cy={cy} r={r} />
        </clipPath>
      </defs>

      <circle cx={lx} cy={cy} r={r} fill={leftFill} className="venn-left" />
      <circle cx={rx} cy={cy} r={r} fill={rightFill} className="venn-right" />

      {/* The shared part: right circle clipped to the left one */}
      {!cross && (
        <g clipPath={`url(#l${id})`}>
          <circle cx={rx} cy={cy} r={r} fill={MATCH} className="venn-match" />
        </g>
      )}

      <g className="venn-lines">
        <circle cx={lx} cy={cy} r={r} fill="none" stroke={LEFT_STROKE} strokeWidth={1.75} />
        <circle cx={rx} cy={cy} r={r} fill="none" stroke={RIGHT_STROKE} strokeWidth={1.75} />
        {cross && (
          <text
            x={130}
            y={cy + 6}
            textAnchor="middle"
            fontSize={20}
            fill="#64748B"
            fontWeight={600}
          >
            ×
          </text>
        )}
        <text
          x={lx - (cross ? 0 : 14)}
          y={cy + r + 16}
          textAnchor="middle"
          fontSize={11}
          fontWeight={600}
          fill="#085F5F"
          className="font-mono"
        >
          {truncate(join.left)}
        </text>
        <text
          x={rx + (cross ? 0 : 14)}
          y={cy + r + 16}
          textAnchor="middle"
          fontSize={11}
          fontWeight={600}
          fill="#4338CA"
          className="font-mono"
        >
          {truncate(join.right)}
        </text>
      </g>
    </svg>
  );
}

const truncate = (s: string) => (s.length > 16 ? s.slice(0, 15) + '…' : s);

export default function JoinView({ joins }: { joins: JoinInfo[] }) {
  return (
    <div className="p-4 space-y-4">
      {joins.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-600">
          <span className="label mr-1">Tables combined</span>
          {[joins[0].left, ...joins.map(j => j.right)].map((t, i) => (
            <span key={`${t}-${i}`} className="flex items-center gap-1.5">
              {i > 0 && <span className="text-slate-400">+</span>}
              <span className="chip font-mono">{t}</span>
            </span>
          ))}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        {joins.map((j, i) => (
          <div
            key={i}
            className="rounded-xl border border-slate-200 bg-white p-3 animate-fade-in [animation-fill-mode:both]"
            style={{ animationDelay: `${i * 80}ms` }}
          >
            <div className="flex items-center gap-2 mb-1">
              <span className="chip border-teal-200 bg-teal-50 text-teal-800">
                <Icon name="join" size={11} /> {LABEL[j.kind]}
              </span>
              {j.on.length > 0 && (
                <span className="text-[11px] text-slate-500 truncate" title={j.condition}>
                  on{' '}
                  {j.on.map(([a, b], k) => (
                    <span key={k} className="font-mono text-slate-700">
                      {k > 0 && ', '}
                      {a === b ? a : `${a} = ${b}`}
                    </span>
                  ))}
                </span>
              )}
            </div>
            <div className="flex justify-center">
              <Venn join={j} />
            </div>
            <p className="text-[13px] leading-relaxed text-slate-600 mt-1">{explain(j)}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500">
        <Legend color={MATCH} text="Rows that match in both tables" />
        <Legend color={KEPT} text="Rows kept without a match" />
        <Legend color={IDLE} text="Rows left out" border />
      </div>
    </div>
  );
}

function Legend({ color, text, border }: { color: string; text: string; border?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className={`w-2.5 h-2.5 rounded-full ${border ? 'border border-slate-300' : ''}`}
        style={{ background: color }}
      />
      {text}
    </span>
  );
}

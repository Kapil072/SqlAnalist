'use client';
import { useState, useRef, useEffect, useCallback } from 'react';
import { authFetch } from '@/lib/api';

interface QueryResult {
  columns: string[];
  rows: (string | number | null)[][];
  row_count: number;
  timing_ms: number;
}

const DEFAULT_SQL = `SELECT c.name, COUNT(o.order_id) AS total_orders,
       SUM(o.total_amount) AS total_spent
FROM customers c
JOIN orders o ON c.customer_id = o.customer_id
WHERE o.status = 'delivered'
GROUP BY c.customer_id, c.name
ORDER BY total_spent DESC
LIMIT 5`;

export default function SqlConsolePage() {
  const [sql,     setSql]     = useState(DEFAULT_SQL);
  const [result,  setResult]  = useState<QueryResult | null>(null);
  const [error,   setError]   = useState('');
  const [loading, setLoading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Ctrl+Enter shortcut
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        runQuery();
      }
    };
    el.addEventListener('keydown', handler);
    return () => el.removeEventListener('keydown', handler);
  }); // intentionally no dep array — picks up latest runQuery

  const runQuery = useCallback(async () => {
    const q = sql.trim();
    if (!q) return;
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const res  = await authFetch('/api/query', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ sql: q }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Execution failed');
      setResult(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [sql]);

  function copySQL() {
    navigator.clipboard.writeText(sql).catch(() => {});
  }

  function clearAll() {
    setSql('');
    setResult(null);
    setError('');
    textareaRef.current?.focus();
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto px-6 py-5 space-y-4">

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-heading font-extrabold text-xl text-teal-800 tracking-tight">
            SQL Console
          </h1>
          <p className="text-sm text-teal-500 mt-0.5">
            Run safe read-only{' '}
            <code className="font-mono bg-teal-100 text-teal-700 px-1.5 py-0.5 rounded-md text-xs">
              SELECT
            </code>{' '}
            queries directly against your database.
          </p>
        </div>
        <button
          onClick={runQuery}
          disabled={loading || !sql.trim()}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl
                     bg-gradient-to-r from-teal-500 to-teal-600 text-white
                     text-sm font-semibold shadow-teal flex-shrink-0
                     hover:from-teal-600 hover:to-teal-700
                     disabled:opacity-40 disabled:cursor-not-allowed
                     transition-all duration-200 hover:-translate-y-0.5">
          {loading
            ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            : <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" strokeWidth="2">
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
          }
          Run Query
          <span className="opacity-60 font-normal text-xs">(Ctrl+Enter)</span>
        </button>
      </div>

      {/* Editor */}
      <div className="rounded-2xl overflow-hidden border border-teal-200 shadow-teal bg-white">
        {/* Editor toolbar */}
        <div className="flex items-center justify-between px-4 py-2.5
                        bg-teal-50 border-b border-teal-100">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-red-400" />
            <div className="w-3 h-3 rounded-full bg-amber-400" />
            <div className="w-3 h-3 rounded-full bg-teal-400" />
            <span className="text-xs font-mono text-teal-500 ml-2 uppercase tracking-wider">
              SQL Editor
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <button onClick={copySQL}
              className="text-xs px-2.5 py-1 rounded-lg bg-white border border-teal-200
                         text-teal-600 hover:bg-teal-50 transition-colors font-medium">
              Copy
            </button>
            <button onClick={clearAll}
              className="text-xs px-2.5 py-1 rounded-lg bg-white border border-teal-200
                         text-teal-600 hover:bg-teal-50 transition-colors font-medium">
              Clear
            </button>
          </div>
        </div>

        <textarea
          ref={textareaRef}
          value={sql}
          onChange={e => setSql(e.target.value)}
          rows={9}
          spellCheck={false}
          placeholder="SELECT * FROM customers LIMIT 10;"
          className="w-full px-4 py-4 font-mono text-sm text-teal-900 bg-white
                     resize-y outline-none leading-relaxed
                     placeholder-teal-200 min-h-[160px]"
        />
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-start gap-3 bg-red-50 border border-red-200
                        rounded-xl px-4 py-3 animate-fade-in">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" strokeWidth="2"
               className="text-red-500 mt-0.5 flex-shrink-0">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <div>
            <p className="text-sm font-semibold text-red-700">Query Error</p>
            <p className="text-sm text-red-600 mt-0.5">{error}</p>
          </div>
        </div>
      )}

      {/* Results */}
      {result && (
        <div className="bg-white rounded-2xl border border-teal-100 shadow-teal
                        overflow-hidden animate-fade-in">
          {/* Results header */}
          <div className="flex items-center justify-between px-4 py-2.5
                          bg-teal-50 border-b border-teal-100">
            <div className="flex items-center gap-2">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" strokeWidth="2" className="text-teal-500">
                <path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9"/>
              </svg>
              <span className="text-sm font-bold text-teal-700">
                {result.row_count.toLocaleString()} rows
              </span>
              <span className="text-xs text-teal-400">
                in {result.timing_ms}ms
              </span>
            </div>
            <span className="text-xs px-2 py-0.5 rounded-full bg-teal-100
                             text-teal-600 font-semibold border border-teal-200">
              Safe Query
            </span>
          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="bg-teal-50/60">
                  {result.columns.map(c => (
                    <th key={c}
                        className="px-4 py-2.5 text-left font-bold text-teal-600
                                   uppercase tracking-wider border-b border-teal-100
                                   text-[10px] whitespace-nowrap">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, i) => (
                  <tr key={i}
                      className="border-b border-teal-50 hover:bg-teal-50/50
                                 transition-colors duration-100">
                    {row.map((cell, j) => (
                      <td key={j}
                          className="px-4 py-2.5 text-teal-800 whitespace-nowrap">
                        {cell === null || cell === undefined
                          ? <span className="text-teal-300 italic text-[11px]">NULL</span>
                          : String(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!result && !error && !loading && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <div className="w-14 h-14 rounded-2xl bg-teal-50 border border-teal-100
                          flex items-center justify-center mb-3">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="1.5" className="text-teal-300">
              <ellipse cx="12" cy="5" rx="9" ry="3"/>
              <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
              <path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/>
            </svg>
          </div>
          <p className="text-sm font-medium text-teal-500">
            Write a query above and click{' '}
            <span className="font-bold text-teal-700">Run Query</span>{' '}
            to see results.
          </p>
        </div>
      )}
    </div>
  );
}

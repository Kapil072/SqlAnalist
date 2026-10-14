'use client';
import { useState, useRef, useEffect, useCallback } from 'react';
import { authFetch, DEFAULT_SOURCE_ID, errorText, getUser } from '@/lib/api';
import { useDash } from '../context';
import Icon from '@/components/Icon';
import DataTable, { downloadCsv } from '@/components/DataTable';
import { AnimatePresence, motion, Skeleton, ease, spring } from '@/components/motion';

interface WriteResult {
  kind: string;
  rows_affected: number | null;
  timing_ms: number;
  schema_refreshed: boolean;
  database: string;
}

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
  // Run against the database selected in the top bar
  const { sourceId, source } = useDash();
  const [sql, setSql] = useState(DEFAULT_SQL);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Admin-only: run INSERT / UPDATE / DELETE / DDL. Off by default every visit.
  const [isAdmin, setIsAdmin] = useState(false);
  const [writeMode, setWriteMode] = useState(false);
  const [writeResult, setWriteResult] = useState<WriteResult | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setIsAdmin(getUser()?.role === 'admin');
  }, []);

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
    const dsId = sourceId !== DEFAULT_SOURCE_ID ? sourceId : undefined;
    const dbName = source?.name ?? 'the selected database';

    if (
      writeMode &&
      !window.confirm(
        `Run this statement on "${dbName}"?\n\nChanges are saved immediately and cannot be undone.\n\n${q.slice(0, 400)}`,
      )
    )
      return;

    setLoading(true);
    setError('');
    setResult(null);
    setWriteResult(null);
    try {
      if (!writeMode) {
        const res = await authFetch('/api/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sql: q, data_source_id: dsId }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(errorText(data, 'Execution failed'));
        setResult(data);
        return;
      }

      // ── Admin write mode ──
      const send = (confirmFullTable: boolean) =>
        authFetch('/admin/sql/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sql: q,
            data_source_id: dsId,
            confirm_full_table: confirmFullTable,
          }),
        });
      let res = await send(false);
      let data = await res.json();
      if (res.status === 409) {
        // UPDATE/DELETE without WHERE, TRUNCATE or DROP — ask a second time
        if (
          !window.confirm(
            `${errorText(data, 'This changes the whole table.')}\n\nAre you absolutely sure?`,
          )
        ) {
          setError('Cancelled — nothing was changed.');
          return;
        }
        res = await send(true);
        data = await res.json();
      }
      if (!res.ok) throw new Error(errorText(data, 'Statement failed'));
      if (data.kind === 'select') {
        setResult(data);
      } else {
        setWriteResult(data);
        // Let the sidebar reload the table list after CREATE / DROP / ALTER
        if (data.schema_refreshed) window.dispatchEvent(new Event('schema-changed'));
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [sql, sourceId, source, writeMode]);

  function copySQL() {
    navigator.clipboard.writeText(sql).catch(() => {});
  }

  function clearAll() {
    setSql('');
    setResult(null);
    setError('');
    textareaRef.current?.focus();
  }

  const dbLabel = source?.name ?? 'your database';

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-3 sm:px-6 py-5 space-y-4">
        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-heading font-bold text-xl text-slate-900 tracking-tight">
              SQL Console
            </h1>
            <p className="text-sm text-slate-500 mt-0.5">
              {writeMode ? (
                <span className="text-red-700">
                  Write mode — changes run on <b>{dbLabel}</b> and are saved immediately.
                </span>
              ) : (
                <>
                  Run read-only <code className="font-mono text-[13px] text-slate-700">SELECT</code>{' '}
                  queries on <b className="text-slate-800">{dbLabel}</b>. Every query is checked
                  before it runs.
                </>
              )}
            </p>
          </div>
          {isAdmin && (
            <label
              title="Admins only: allow INSERT, UPDATE, DELETE and table changes"
              className="flex items-center gap-2.5 cursor-pointer select-none text-sm font-medium text-slate-700"
            >
              <span>Write mode</span>
              <span className="relative inline-flex">
                <input
                  type="checkbox"
                  checked={writeMode}
                  onChange={e => {
                    setWriteMode(e.target.checked);
                    setError('');
                    setWriteResult(null);
                  }}
                  className="peer sr-only"
                />
                <span className="w-10 h-6 rounded-full bg-slate-200 peer-checked:bg-red-600 transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-teal-500/60" />
                <motion.span
                  className="absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow"
                  animate={{ x: writeMode ? 16 : 0 }}
                  transition={spring}
                />
              </span>
            </label>
          )}
        </div>

        {/* Editor */}
        <div
          className={`card overflow-hidden transition-[border-color,box-shadow] duration-300 ${writeMode ? 'border-red-300 ring-4 ring-red-500/10' : ''}`}
        >
          <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200 bg-slate-50">
            <Icon name="code" size={14} className="text-slate-400" />
            <span className="text-xs font-medium text-slate-500">Query</span>
            <span className="flex-1" />
            <button
              onClick={copySQL}
              className="btn-icon w-8 h-8"
              title="Copy"
              aria-label="Copy SQL"
            >
              <Icon name="copy" size={14} />
            </button>
            <button
              onClick={clearAll}
              className="btn-icon w-8 h-8"
              title="Clear"
              aria-label="Clear"
            >
              <Icon name="trash" size={14} />
            </button>
          </div>
          <textarea
            ref={textareaRef}
            value={sql}
            onChange={e => setSql(e.target.value)}
            rows={9}
            spellCheck={false}
            aria-label="SQL query"
            placeholder="SELECT * FROM customers LIMIT 10"
            className="block w-full px-4 py-3.5 font-mono text-[13.5px] leading-relaxed bg-slate-900 text-slate-100
                       placeholder-slate-500 resize-y outline-none min-h-[180px]"
          />
          <div className="flex flex-wrap items-center gap-3 px-3 py-2.5 border-t border-slate-200">
            <span className="text-xs text-slate-400 hidden sm:inline">
              <kbd className="font-mono px-1.5 py-0.5 rounded border border-slate-200 bg-slate-50 text-slate-600">
                Ctrl
              </kbd>{' '}
              +{' '}
              <kbd className="font-mono px-1.5 py-0.5 rounded border border-slate-200 bg-slate-50 text-slate-600">
                Enter
              </kbd>{' '}
              to run
            </span>
            <span className="flex-1" />
            <motion.button
              onClick={runQuery}
              disabled={loading || !sql.trim()}
              whileTap={{ scale: 0.95 }}
              className={writeMode ? 'btn-danger' : 'btn-primary'}
            >
              {loading ? (
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <Icon name="play" size={13} />
              )}
              {writeMode ? 'Run change' : 'Run query'}
            </motion.button>
          </div>
        </div>

        <AnimatePresence initial={false}>
          {/* Running */}
          {loading && (
            <motion.div
              key="loading"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.12 } }}
              transition={ease}
              className="card overflow-hidden"
              aria-live="polite"
            >
              <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-4 w-14 rounded-full" />
                <span className="flex-1" />
                <span className="text-xs text-slate-400">Running query…</span>
              </div>
              <div className="p-4 space-y-2.5">
                {[0, 1, 2, 3, 4].map(i => (
                  <div key={i} className="grid grid-cols-4 gap-3">
                    {[0, 1, 2, 3].map(j => (
                      <Skeleton key={j} className="h-3.5" />
                    ))}
                  </div>
                ))}
              </div>
            </motion.div>
          )}

          {/* Error */}
          {error && (
            <motion.div
              key="error"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, x: [0, -5, 5, -3, 3, 0] }}
              exit={{ opacity: 0, transition: { duration: 0.12 } }}
              transition={{ duration: 0.4 }}
              className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3"
            >
              <Icon name="alert" size={16} className="text-red-600 mt-0.5" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-red-800">
                  {writeMode ? 'Statement not run' : 'Query error'}
                </p>
                <p className="text-sm text-red-700 mt-0.5 whitespace-pre-wrap break-words">
                  {error}
                </p>
              </div>
            </motion.div>
          )}

          {/* Write result */}
          {writeResult && (
            <motion.div
              key="write"
              initial={{ opacity: 0, y: 10, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.12 } }}
              transition={spring}
              className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3"
            >
              <motion.span
                initial={{ scale: 0, rotate: -45 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{ ...spring, delay: 0.1 }}
                className="flex"
              >
                <Icon name="check" size={16} className="text-emerald-600 mt-0.5" />
              </motion.span>
              <div>
                <p className="text-sm font-semibold text-emerald-900">
                  {writeResult.kind.toUpperCase()} done on {writeResult.database}
                </p>
                <p className="text-sm text-emerald-800 mt-0.5">
                  {writeResult.rows_affected === null
                    ? 'Statement completed'
                    : `${writeResult.rows_affected.toLocaleString()} row(s) affected`}{' '}
                  in {writeResult.timing_ms} ms
                  {writeResult.schema_refreshed && ' · table list refreshed'} · recorded in the
                  audit log.
                </p>
              </div>
            </motion.div>
          )}

          {/* Results */}
          {result && (
            <motion.div
              key="result"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.12 } }}
              transition={ease}
              className="card overflow-hidden"
            >
              <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-slate-200">
                <span className="text-sm font-semibold text-slate-900">
                  {result.row_count.toLocaleString()} {result.row_count === 1 ? 'row' : 'rows'}
                </span>
                <span className="chip">
                  <Icon name="clock" size={11} /> {result.timing_ms} ms
                </span>
                <span className="chip border-emerald-200 bg-emerald-50 text-emerald-700">
                  <Icon name="shield" size={11} /> Safe
                </span>
                <span className="flex-1" />
                {result.columns.length > 0 && (
                  <button
                    onClick={() => downloadCsv(result.columns, result.rows)}
                    className="btn-secondary py-1 px-2.5 text-xs"
                  >
                    <Icon name="download" size={13} /> CSV
                  </button>
                )}
              </div>
              <DataTable columns={result.columns} rows={result.rows} maxHeight="max-h-[60vh]" />
            </motion.div>
          )}

          {/* Empty state */}
          {!result && !error && !writeResult && !loading && (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.12 } }}
              className="flex flex-col items-center justify-center py-12 text-center"
            >
              <motion.span
                animate={{ y: [0, -5, 0] }}
                transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
                className="w-12 h-12 rounded-2xl bg-white border border-slate-200 shadow-sm flex items-center justify-center text-teal-500"
              >
                <Icon name="database" size={22} strokeWidth={1.6} />
              </motion.span>
              <p className="mt-3 text-sm text-slate-500">
                Write a query above and press <b className="text-slate-700">Run query</b> to see the
                results here.
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

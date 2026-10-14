'use client';
import { useState, useMemo } from 'react';
import { TableInfo, ChatMessage, SourceInfo, timeAgo } from '@/lib/api';
import Icon from '@/components/Icon';
import { AnimatePresence, motion, spring, ease, collapse } from '@/components/motion';

interface Props {
  /** Whether the panel is shown (a drawer on small screens) */
  open: boolean;
  onClose: () => void;
  tables: TableInfo[];
  /** null when the database does not report row counts (external data sources) */
  totalRows: number | null;
  history: ChatMessage[];
  onHistoryClick: (q: string) => void;
  /** Only passed for admins — refreshing a schema is admin-only */
  onRefresh?: () => void;
  refreshing: boolean;
  /** Databases the user can ask about (default DB + admin-added data sources) */
  sources: SourceInfo[];
  sourceId: string;
  schemaError?: string;
  /** Opens the full-screen schema diagram */
  onOpenDiagram: () => void;
}

export default function Sidebar({
  open,
  onClose,
  tables,
  totalRows,
  history,
  onHistoryClick,
  onRefresh,
  refreshing,
  sources,
  sourceId,
  schemaError,
  onOpenDiagram,
}: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'tables' | 'history'>('tables');

  const source = sources.find(src => src.id === sourceId);
  const filteredTables = useMemo(() => {
    const s = search.toLowerCase().trim();
    if (!s) return tables;
    return tables.filter(
      t =>
        t.name.toLowerCase().includes(s) || t.columns.some(c => c.name.toLowerCase().includes(s)),
    );
  }, [tables, search]);

  const allOpen = tables.length > 0 && tables.every(t => expanded[t.name]);
  const toggleAll = () =>
    setExpanded(allOpen ? {} : Object.fromEntries(tables.map(t => [t.name, true])));

  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          key="backdrop"
          onClick={onClose}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="lg:hidden fixed inset-0 top-14 z-30 bg-slate-900/30 backdrop-blur-[1px]"
        />
      )}
      {open && (
        // Width animates so the main area glides over on desktop; on phones it reveals as a drawer
        <motion.aside
          key="panel"
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: 300, opacity: 1, transition: { ...ease, opacity: { duration: 0.2 } } }}
          exit={{ width: 0, opacity: 0, transition: { duration: 0.22, ease: [0.4, 0, 0.2, 1] } }}
          className="fixed lg:static top-14 bottom-0 left-0 z-30 max-w-[85vw] flex-shrink-0
                   bg-white border-r border-slate-200 overflow-hidden"
        >
          <div className="w-[300px] max-w-[85vw] h-full flex flex-col">
            {/* Database summary */}
            <div className="px-4 pt-4 pb-3 border-b border-slate-100">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="label">Database</p>
                  <p className="mt-0.5 font-semibold text-slate-900 truncate" title={source?.name}>
                    {source?.name ?? 'default'}
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {source?.db_type ?? 'sql'} · {tables.length}{' '}
                    {tables.length === 1 ? 'table' : 'tables'}
                    {totalRows !== null && ` · ${totalRows.toLocaleString()} rows`}
                  </p>
                </div>
                <div className="flex items-center gap-0.5 -mr-1.5">
                  <button
                    onClick={onOpenDiagram}
                    disabled={tables.length === 0}
                    title="Show the schema as a diagram"
                    aria-label="Schema diagram"
                    className="btn-icon w-8 h-8"
                  >
                    <Icon name="diagram" size={15} />
                  </button>
                  {onRefresh && (
                    <button
                      onClick={onRefresh}
                      disabled={refreshing}
                      title="Re-read this database's tables"
                      aria-label="Refresh tables"
                      className="btn-icon w-8 h-8"
                    >
                      <Icon name="refresh" size={15} className={refreshing ? 'animate-spin' : ''} />
                    </button>
                  )}
                  <button
                    onClick={onClose}
                    title="Hide panel"
                    aria-label="Hide panel"
                    className="btn-icon w-8 h-8"
                  >
                    <Icon name="x" size={16} />
                  </button>
                </div>
              </div>

              {/* Tables / Recent switch */}
              <div className="mt-3 grid grid-cols-2 p-0.5 rounded-lg bg-slate-100 text-xs font-medium">
                {(['tables', 'history'] as const).map(t => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`relative py-1.5 rounded-md transition-colors ${
                      tab === t ? 'text-slate-900' : 'text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    {tab === t && (
                      <motion.span
                        layoutId="sidebar-tab"
                        transition={spring}
                        className="absolute inset-0 rounded-md bg-white shadow-sm"
                      />
                    )}
                    <span className="relative">
                      {t === 'tables'
                        ? 'Tables'
                        : `Recent${history.length ? ` (${Math.min(history.length, 30)})` : ''}`}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {schemaError && (
              <div className="mx-3 mt-3 flex gap-2 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                <Icon name="alert" size={14} className="mt-0.5" />
                <span>Could not read this database&apos;s tables. {schemaError}</span>
              </div>
            )}

            {tab === 'tables' ? (
              <>
                {tables.length > 0 && (
                  <div className="px-3 pt-3 pb-2 space-y-2">
                    <motion.button
                      onClick={onOpenDiagram}
                      whileHover={{ y: -1 }}
                      whileTap={{ scale: 0.98 }}
                      className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl border border-teal-200
                               bg-gradient-to-r from-teal-50 to-white text-left hover:border-teal-300 hover:shadow-teal"
                    >
                      <span className="w-7 h-7 rounded-lg bg-teal-600 text-white flex items-center justify-center">
                        <Icon name="diagram" size={14} />
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-[13px] font-semibold text-slate-900">
                          View schema diagram
                        </span>
                        <span className="block text-[11px] text-slate-500">
                          Tables, keys and how they connect
                        </span>
                      </span>
                    </motion.button>
                    <div className="relative">
                      <Icon
                        name="search"
                        size={14}
                        className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
                      />
                      <input
                        type="text"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="Find a table or column"
                        className="input pl-8 pr-8 py-1.5 text-[13px]"
                      />
                      {search && (
                        <button
                          onClick={() => setSearch('')}
                          aria-label="Clear search"
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
                        >
                          <Icon name="x" size={14} />
                        </button>
                      )}
                    </div>
                    <div className="flex justify-between items-center px-1 text-[11px] text-slate-500">
                      <span>
                        {search ? `${filteredTables.length} of ${tables.length}` : tables.length}{' '}
                        tables
                      </span>
                      <button
                        onClick={toggleAll}
                        className="font-medium text-teal-700 hover:text-teal-900"
                      >
                        {allOpen ? 'Collapse all' : 'Expand all'}
                      </button>
                    </div>
                  </div>
                )}

                <div className="flex-1 overflow-y-auto px-2 pb-3">
                  {filteredTables.length === 0 ? (
                    <div className="text-center py-10 px-4">
                      <Icon name="table" size={22} className="mx-auto text-slate-300" />
                      <p className="text-sm font-medium text-slate-600 mt-2">
                        {search ? 'No matching tables' : 'No tables to show'}
                      </p>
                      <p className="text-xs text-slate-400 mt-1">
                        {search ? 'Try another word' : 'Pick another database at the top'}
                      </p>
                    </div>
                  ) : (
                    filteredTables.map((tbl, i) => {
                      const isOpen = expanded[tbl.name] ?? search.trim().length > 0;
                      return (
                        <motion.div
                          key={tbl.name}
                          initial={{ opacity: 0, x: -8 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ ...ease, delay: Math.min(i, 12) * 0.025 }}
                        >
                          <button
                            onClick={() => setExpanded(p => ({ ...p, [tbl.name]: !isOpen }))}
                            aria-expanded={isOpen}
                            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-100 text-left group"
                          >
                            <motion.span
                              className="flex text-slate-400"
                              animate={{ rotate: isOpen ? 0 : -90 }}
                              transition={spring}
                            >
                              <Icon name="chevronDown" size={14} />
                            </motion.span>
                            <Icon name="table" size={14} className="text-teal-600" />
                            <span className="font-mono text-[13px] font-medium text-slate-800 truncate flex-1">
                              {tbl.name}
                            </span>
                            <span className="text-[11px] tabular-nums text-slate-400">
                              {tbl.row_count === null || tbl.row_count === undefined
                                ? `${tbl.columns.length} cols`
                                : tbl.row_count.toLocaleString()}
                            </span>
                          </button>
                          <AnimatePresence initial={false}>
                            {isOpen && (
                              <motion.ul
                                {...collapse}
                                className="ml-[22px] pl-3 border-l border-slate-200 mb-1 overflow-hidden"
                              >
                                {tbl.columns.map(col => (
                                  <li
                                    key={col.name}
                                    className="flex items-center justify-between gap-2 py-1 pr-2 text-xs"
                                  >
                                    <span className="font-mono text-slate-700 truncate">
                                      {col.name}
                                    </span>
                                    <span className="font-mono text-[10.5px] text-slate-400 uppercase flex-shrink-0">
                                      {col.type.split('(')[0]}
                                    </span>
                                  </li>
                                ))}
                              </motion.ul>
                            )}
                          </AnimatePresence>
                        </motion.div>
                      );
                    })
                  )}
                </div>
              </>
            ) : (
              <div className="flex-1 overflow-y-auto p-2">
                {history.length === 0 ? (
                  <div className="text-center py-10 px-4">
                    <Icon name="clock" size={22} className="mx-auto text-slate-300" />
                    <p className="text-sm font-medium text-slate-600 mt-2">No questions yet</p>
                    <p className="text-xs text-slate-400 mt-1">Your recent questions appear here</p>
                  </div>
                ) : (
                  history.slice(0, 30).map((m, i) => (
                    <motion.button
                      key={m.id}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ ...ease, delay: Math.min(i, 12) * 0.03 }}
                      onClick={() => onHistoryClick(m.question)}
                      title="Put this question back in the box"
                      className="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-100 group"
                    >
                      <p className="text-[13px] text-slate-800 line-clamp-2 group-hover:text-slate-900">
                        {m.question}
                      </p>
                      <p className="text-[11px] text-slate-400 mt-0.5">{timeAgo(m.created_at)}</p>
                    </motion.button>
                  ))
                )}
              </div>
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

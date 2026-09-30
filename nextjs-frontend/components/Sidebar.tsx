'use client';
import { useState } from 'react';
import { TableInfo, ChatMessage, timeAgo } from '@/lib/api';

interface Props {
  tables: TableInfo[];
  totalRows: number;
  history: ChatMessage[];
  onHistoryClick: (q: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
}

export default function Sidebar({ tables, totalRows, history, onHistoryClick, onRefresh, refreshing }: Props) {
  const [open, setOpen] = useState<Record<string, boolean>>({});

  return (
    <aside className="w-72 min-w-[288px] flex flex-col bg-teal-50/60 border-r border-teal-200/60
                      backdrop-blur-sm overflow-y-auto">

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-teal-200/60
                      bg-teal-100/50">
        <div className="flex items-center gap-2">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" strokeWidth="2" className="text-teal-600">
            <ellipse cx="12" cy="5" rx="9" ry="3"/>
            <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
            <path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/>
          </svg>
          <span className="font-heading font-bold text-sm text-teal-800">Database Schema</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-teal-200 text-teal-800
                           border border-teal-300">
            {tables.length} Tables
          </span>
          <button onClick={onRefresh} disabled={refreshing}
            className="w-7 h-7 flex items-center justify-center rounded-lg border border-teal-200
                       bg-white/60 text-teal-500 hover:text-teal-700 hover:bg-white
                       transition-all duration-150 disabled:opacity-50">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="2"
                 className={refreshing ? 'animate-spin' : ''}>
              <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>
            </svg>
          </button>
        </div>
      </div>

      {/* DB meta */}
      <div className="flex justify-between px-4 py-2.5 bg-teal-50/80 border-b border-teal-200/40
                      text-xs">
        <div>
          <p className="text-teal-500 uppercase tracking-wider font-semibold text-[10px]">Database</p>
          <p className="font-mono font-bold text-teal-700 mt-0.5">analytics</p>
        </div>
        <div className="text-right">
          <p className="text-teal-500 uppercase tracking-wider font-semibold text-[10px]">Total rows</p>
          <p className="font-bold text-teal-700 mt-0.5">{totalRows.toLocaleString()}</p>
        </div>
      </div>

      {/* Tables */}
      <div className="flex flex-col flex-shrink-0">
        {tables.length === 0 && (
          <p className="text-center text-teal-400 text-sm py-8">No tables found</p>
        )}
        {tables.map(tbl => (
          <div key={tbl.name} className="border-b border-teal-200/40">
            <button
              onClick={() => setOpen(o => ({ ...o, [tbl.name]: !o[tbl.name] }))}
              className="w-full flex items-center justify-between px-4 py-2.5
                         hover:bg-teal-100/60 transition-colors duration-150 text-left">
              <div className="flex items-center gap-2">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" strokeWidth="2" className="text-teal-500 flex-shrink-0">
                  <rect x="3" y="3" width="18" height="18" rx="2"/>
                  <path d="M3 9h18M3 15h18M9 3v18"/>
                </svg>
                <span className="font-mono text-[13px] font-semibold text-teal-800">{tbl.name}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] font-semibold text-teal-600 bg-teal-100
                                 px-2 py-0.5 rounded-full border border-teal-200">
                  {(tbl.row_count || 0).toLocaleString()}
                </span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" strokeWidth="2"
                     className={`text-teal-400 transition-transform duration-200
                                ${open[tbl.name] ? 'rotate-180' : ''}`}>
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </div>
            </button>

            {open[tbl.name] && (
              <div className="pl-8 pr-4 pb-2.5 bg-teal-50/40">
                {tbl.columns.map(col => (
                  <div key={col.name}
                       className="flex justify-between items-center py-1 border-b
                                  border-teal-100/60 last:border-0">
                    <span className="font-mono text-[12px] font-medium text-teal-700">
                      {col.name}
                    </span>
                    <span className="text-[11px] font-mono text-teal-400 bg-white/70
                                     px-1.5 py-0.5 rounded border border-teal-100">
                      {col.type.split('(')[0]}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Chat history */}
      {history.length > 0 && (
        <div className="mt-auto border-t border-teal-200/60">
          <p className="flex items-center gap-1.5 px-4 py-2.5 text-[10px] font-bold uppercase
                        tracking-wider text-teal-500 bg-teal-50/80">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
            Recent Conversations
          </p>
          <div className="flex flex-col">
            {history.slice(0, 10).map(m => (
              <button key={m.id}
                onClick={() => onHistoryClick(m.question)}
                className="text-left px-4 py-2 hover:bg-teal-100/60 transition-colors
                           border-b border-teal-100/40 last:border-0 group">
                <p className="text-[12px] font-medium text-teal-700 truncate
                              group-hover:text-teal-900 transition-colors">
                  {m.question}
                </p>
                <p className="text-[10px] text-teal-400 mt-0.5">{timeAgo(m.created_at)}</p>
              </button>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

'use client';
import {
  useState, useEffect, useRef, useCallback, useLayoutEffect
} from 'react';
import {
  API, authHeaders, saveChatMessage, uploadFileForAnalysis,
  FileAnalysisResult,
} from '@/lib/api';
import { useDash } from './layout';
import dynamic from 'next/dynamic';

const ChartComponent = dynamic(() => import('@/components/ChartBlock'), { ssr: false });

// ── Types ────────────────────────────────────────────────────
interface MetaPayload {
  sql_query: string;
  columns: string[];
  rows: (string | number | null)[][];
  row_count: number;
  timing_ms: number;
  chart?: { type: string; title: string; x_axis?: string; y_axis?: string };
  engine_used: string;
  session_id: string;
}

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'file';
  question?: string;
  text?: string;
  meta?: MetaPayload;
  fileResult?: FileAnalysisResult;
  streaming?: boolean;
  error?: string;
}

const SAMPLES = [
  'Who are the top 5 customers by total spending?',
  'Which product category generates the highest revenue?',
  'What are the top 5 best selling products by units sold?',
  'How many orders are in each status?',
];

export default function ChatPage() {
  const { setInjectPrompt } = useDash();
  const [messages,  setMessages]  = useState<Message[]>([]);
  const [input,     setInput]     = useState('');
  const [loading,   setLoading]   = useState(false);
  const [fileModal, setFileModal] = useState(false);
  const [uploading, setUploading] = useState(false);
  const scrollRef  = useRef<HTMLDivElement>(null);
  const inputRef   = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sessionRef = useRef<string | null>(
    typeof window !== 'undefined'
      ? sessionStorage.getItem('sqlanalyst_session_id')
      : null
  );

  // Register the inject function so layout can push prompts
  useEffect(() => {
    setInjectPrompt((q: string) => {
      setInput(q);
      inputRef.current?.focus();
    });
  }, [setInjectPrompt]);

  // New-chat event from navbar
  useEffect(() => {
    function handleNewChat() {
      setMessages([]);
      setInput('');
      sessionRef.current = null;
    }
    window.addEventListener('new-chat', handleNewChat);
    return () => window.removeEventListener('new-chat', handleNewChat);
  }, []);

  // Auto-scroll
  useLayoutEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // ── Send question ─────────────────────────────────────────
  const sendQuestion = useCallback(async (question: string) => {
    if (!question.trim() || loading) return;
    setInput('');
    setLoading(true);

    const userMsg: Message = { id: Date.now() + 'u', role: 'user', question };
    const assistantId = Date.now() + 'a';
    const assistantMsg: Message = { id: assistantId, role: 'assistant', streaming: true, text: '' };
    setMessages(prev => [...prev, userMsg, assistantMsg]);

    let finalMeta: MetaPayload | null = null;
    let finalExplanation = '';

    try {
      const resp = await fetch(API + '/ask/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          question,
          session_id: sessionRef.current || undefined,
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: 'Stream failed' }));
        throw new Error(err.detail || 'Request failed');
      }

      const reader  = resp.body!.getReader();
      const decoder = new TextDecoder();
      let   buffer  = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          if (!frame.trim()) continue;
          let eventName = 'message', dataStr = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            else if (line.startsWith('data:')) dataStr = line.slice(5).trim();
          }
          let payload: Record<string, unknown>;
          try { payload = JSON.parse(dataStr); } catch { continue; }

          if (eventName === 'meta') {
            finalMeta = payload as unknown as MetaPayload;
            if (finalMeta.session_id) {
              sessionRef.current = finalMeta.session_id;
              sessionStorage.setItem('sqlanalyst_session_id', finalMeta.session_id);
            }
            setMessages(prev => prev.map(m =>
              m.id === assistantId ? { ...m, meta: finalMeta! } : m
            ));
          } else if (eventName === 'token') {
            const token = (payload.token as string) || '';
            finalExplanation += token;
            setMessages(prev => prev.map(m =>
              m.id === assistantId
                ? { ...m, text: (m.text || '') + token }
                : m
            ));
          } else if (eventName === 'done') {
            setMessages(prev => prev.map(m =>
              m.id === assistantId ? { ...m, streaming: false } : m
            ));
          } else if (eventName === 'error') {
            throw new Error((payload.detail as string) || 'Unknown error');
          }
        }
      }

      // Save to DB
      if (finalMeta) {
        saveChatMessage({
          question,
          sql_query:   finalMeta.sql_query,
          explanation: finalExplanation,
          engine_used: finalMeta.engine_used,
          session_id:  sessionRef.current || undefined,
        }).catch(() => {});
      }

    } catch (err) {
      setMessages(prev => prev.map(m =>
        m.id === assistantId
          ? { ...m, streaming: false, error: (err as Error).message }
          : m
      ));
    } finally {
      setLoading(false);
    }
  }, [loading]);

  // ── File upload ───────────────────────────────────────────
  async function handleFileUpload(file: File) {
    setFileModal(false);
    setUploading(true);
    const fileId = Date.now() + 'f';
    setMessages(prev => [...prev, {
      id: fileId, role: 'file',
      question: `Analysing: ${file.name}…`,
    }]);
    try {
      const result = await uploadFileForAnalysis(file);
      setMessages(prev => prev.map(m =>
        m.id === fileId
          ? { ...m, question: file.name, fileResult: result }
          : m
      ));
    } catch (err) {
      setMessages(prev => prev.map(m =>
        m.id === fileId
          ? { ...m, error: (err as Error).message }
          : m
      ));
    } finally {
      setUploading(false);
    }
  }

  function handleFileDrop(e: React.DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFileUpload(file);
  }

  const showWelcome = messages.length === 0;

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* Messages area */}
      <div ref={scrollRef}
           className="flex-1 overflow-y-auto px-4 py-5 space-y-4">

        {/* Welcome */}
        {showWelcome && (
          <div className="max-w-2xl mx-auto text-center pt-8 animate-fade-in">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full
                            bg-teal-100 border border-teal-200 text-teal-700
                            text-xs font-semibold mb-4">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" strokeWidth="2.5">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
              </svg>
              Real-Time Text-to-SQL Engine
            </div>
            <h1 className="font-heading text-3xl font-extrabold text-teal-800
                           tracking-tight mb-3">
              Ask your database anything.
            </h1>
            <p className="text-teal-600 text-sm leading-relaxed mb-8 max-w-lg mx-auto">
              Type a business question and SQLAnalyst generates safe SQL,
              queries your live database and renders charts instantly.
              Or upload a CSV / Excel file to analyse local data.
            </p>
            <div className="grid grid-cols-2 gap-3 text-left">
              {SAMPLES.map(s => (
                <button key={s} onClick={() => sendQuestion(s)}
                  className="flex items-start gap-3 p-4 bg-white/80 rounded-xl
                             border border-teal-100 hover:border-teal-300
                             hover:bg-white shadow-sm hover:shadow-teal
                             transition-all duration-200 group">
                  <div className="w-7 h-7 rounded-lg bg-teal-50 border border-teal-200
                                  flex items-center justify-center flex-shrink-0">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                         stroke="currentColor" strokeWidth="2" className="text-teal-500">
                      <circle cx="11" cy="11" r="8"/>
                      <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                    </svg>
                  </div>
                  <span className="text-xs font-medium text-teal-700
                                   group-hover:text-teal-900 transition-colors leading-relaxed">
                    {s}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Message list */}
        {messages.map(msg => (
          <div key={msg.id} className="max-w-3xl mx-auto w-full">

            {/* User bubble */}
            {msg.role === 'user' && (
              <div className="flex justify-end mb-1">
                <div className="max-w-[72%] bg-gradient-to-br from-teal-500 to-teal-600
                                text-white px-4 py-2.5 rounded-2xl rounded-br-sm
                                text-sm font-medium shadow-teal leading-relaxed">
                  {msg.question}
                </div>
              </div>
            )}

            {/* File result card */}
            {msg.role === 'file' && (
              <div className="bg-white/90 rounded-2xl border border-teal-100
                              border-t-2 border-t-teal-300 shadow-teal p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-teal-50 border border-teal-200
                                  flex items-center justify-center">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
                         stroke="currentColor" strokeWidth="2" className="text-teal-600">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                      <polyline points="14 2 14 8 20 8"/>
                    </svg>
                  </div>
                  <span className="font-semibold text-sm text-teal-800">
                    {msg.fileResult ? msg.fileResult.filename : msg.question}
                  </span>
                  {!msg.fileResult && !msg.error && (
                    <div className="w-4 h-4 border-2 border-teal-400 border-t-transparent
                                    rounded-full animate-spin ml-auto" />
                  )}
                </div>
                {msg.error && (
                  <p className="text-red-600 text-sm bg-red-50 rounded-lg px-3 py-2">
                    {msg.error}
                  </p>
                )}
                {msg.fileResult && (
                  <>
                    <div className="flex gap-3 text-xs">
                      <span className="px-2 py-1 rounded-lg bg-teal-50 border border-teal-100
                                       text-teal-700 font-semibold">
                        {msg.fileResult.rows.toLocaleString()} rows
                      </span>
                      <span className="px-2 py-1 rounded-lg bg-teal-50 border border-teal-100
                                       text-teal-700 font-semibold">
                        {msg.fileResult.columns.length} columns
                      </span>
                    </div>
                    <p className="text-sm text-teal-700 leading-relaxed">
                      {msg.fileResult.analysis}
                    </p>
                    {/* Preview table */}
                    <div className="overflow-x-auto rounded-xl border border-teal-100">
                      <table className="w-full text-xs border-collapse">
                        <thead>
                          <tr className="bg-teal-50">
                            {msg.fileResult.columns.slice(0, 6).map(c => (
                              <th key={c} className="px-3 py-2 text-left font-bold
                                                     text-teal-600 uppercase tracking-wider
                                                     border-b border-teal-100 text-[10px]">
                                {c}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {msg.fileResult.preview.slice(0, 5).map((row, i) => (
                            <tr key={i} className="border-b border-teal-50 hover:bg-teal-50/50">
                              {msg.fileResult!.columns.slice(0, 6).map(c => (
                                <td key={c} className="px-3 py-2 text-teal-800">
                                  {String(row[c] ?? '')}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Assistant card */}
            {msg.role === 'assistant' && (
              <div className="bg-white/90 rounded-2xl border border-teal-100
                              border-t-2 border-t-teal-200 shadow-teal p-4 space-y-3
                              animate-fade-in">
                {/* Header */}
                <div className="flex items-center justify-between pb-2
                                border-b border-teal-50">
                  <div className="flex items-center gap-2">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
                         stroke="currentColor" strokeWidth="2" className="text-teal-500">
                      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83
                               M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                    </svg>
                    <span className="font-heading font-bold text-sm text-teal-800">
                      SQLAnalyst
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {msg.streaming && (
                      <span className="text-[11px] px-2 py-0.5 rounded-full
                                       bg-teal-100 text-teal-600 font-semibold
                                       animate-blink border border-teal-200">
                        Generating…
                      </span>
                    )}
                    {!msg.streaming && msg.meta && (
                      <>
                        <span className="text-[11px] px-2 py-0.5 rounded-full
                                         bg-teal-50 border border-teal-100 text-teal-500">
                          {msg.meta.timing_ms}ms
                        </span>
                        <span className="text-[11px] px-2 py-0.5 rounded-full
                                         bg-teal-50 border border-teal-100 text-teal-500">
                          {msg.meta.row_count} rows
                        </span>
                        <span className="text-[11px] px-2 py-0.5 rounded-full
                                         bg-teal-50 border border-teal-200
                                         text-teal-600 font-semibold">
                          Safe
                        </span>
                      </>
                    )}
                  </div>
                </div>

                {/* Error */}
                {msg.error && (
                  <div className="bg-red-50 border border-red-200 rounded-xl
                                  px-4 py-3 text-sm text-red-700">
                    {msg.error}
                  </div>
                )}

                {/* SQL */}
                {msg.meta?.sql_query && (
                  <SqlBlock sql={msg.meta.sql_query} />
                )}

                {/* Explanation */}
                {msg.text && (
                  <p className="text-sm text-teal-800 leading-relaxed">
                    {msg.text}
                  </p>
                )}

                {/* Chart */}
                {msg.meta?.chart && msg.meta.columns.length > 0 && (
                  <ChartComponent
                    chart={msg.meta.chart}
                    columns={msg.meta.columns}
                    rows={msg.meta.rows}
                  />
                )}

                {/* Data table */}
                {msg.meta?.columns && msg.meta.columns.length > 0 && (
                  <DataTable columns={msg.meta.columns} rows={msg.meta.rows} />
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Input bar */}
      <div className="px-4 pb-4 pt-2 flex-shrink-0">
        <div className="max-w-3xl mx-auto">
          <div className={`flex items-center bg-white/90 backdrop-blur-sm rounded-2xl
                           border-2 transition-all duration-200 shadow-teal
                           ${loading
                             ? 'border-teal-200'
                             : 'border-teal-200 focus-within:border-teal-500'}`}>

            {/* File upload button */}
            <button
              onClick={() => setFileModal(true)}
              disabled={uploading}
              title="Analyse a CSV or Excel file"
              className="ml-3 w-8 h-8 flex items-center justify-center rounded-xl
                         bg-teal-50 border border-teal-200 text-teal-500
                         hover:bg-teal-100 hover:text-teal-700
                         disabled:opacity-50 transition-all duration-150 flex-shrink-0">
              {uploading
                ? <div className="w-4 h-4 border-2 border-teal-400 border-t-transparent
                                  rounded-full animate-spin" />
                : <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                       stroke="currentColor" strokeWidth="2">
                    <line x1="12" y1="5" x2="12" y2="19"/>
                    <line x1="5" y1="12" x2="19" y2="12"/>
                  </svg>
              }
            </button>

            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  sendQuestion(input);
                }
              }}
              disabled={loading}
              placeholder="Ask about your data — e.g. top 10 customers by revenue…"
              className="flex-1 bg-transparent px-3 py-3 text-sm text-teal-900
                         placeholder-teal-300 outline-none disabled:opacity-60" />

            <button
              onClick={() => sendQuestion(input)}
              disabled={loading || !input.trim()}
              className="mr-2 flex items-center gap-2 px-4 py-2 rounded-xl
                         bg-gradient-to-r from-teal-500 to-teal-600 text-white
                         text-sm font-semibold shadow-teal
                         hover:from-teal-600 hover:to-teal-700
                         disabled:opacity-40 disabled:cursor-not-allowed
                         transition-all duration-200 hover:-translate-y-0.5
                         flex-shrink-0">
              {loading
                ? <div className="w-4 h-4 border-2 border-white border-t-transparent
                                  rounded-full animate-spin" />
                : <>
                    <span>Ask AI</span>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                         stroke="currentColor" strokeWidth="2.5">
                      <line x1="22" y1="2" x2="11" y2="13"/>
                      <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                    </svg>
                  </>
              }
            </button>
          </div>
        </div>
      </div>

      {/* File upload modal */}
      {fileModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4
                        bg-black/40 backdrop-blur-sm animate-fade-in"
             onClick={e => { if (e.target === e.currentTarget) setFileModal(false); }}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4"
               onDragOver={e => e.preventDefault()}
               onDrop={handleFileDrop}>

            <div className="flex items-center justify-between">
              <h2 className="font-heading font-bold text-lg text-teal-800">
                Analyse a File
              </h2>
              <button onClick={() => setFileModal(false)}
                className="w-8 h-8 flex items-center justify-center rounded-lg
                           text-teal-400 hover:text-teal-700 hover:bg-teal-50
                           transition-colors">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>

            {/* Drop zone */}
            <div
              onClick={() => fileInputRef.current?.click()}
              className="border-2 border-dashed border-teal-200 rounded-2xl
                         p-8 text-center cursor-pointer hover:border-teal-400
                         hover:bg-teal-50/50 transition-all duration-200 group">
              <div className="w-12 h-12 rounded-xl bg-teal-50 border border-teal-200
                              flex items-center justify-center mx-auto mb-3
                              group-hover:bg-teal-100 transition-colors">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" strokeWidth="1.5" className="text-teal-500">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                  <line x1="12" y1="12" x2="12" y2="18"/>
                  <line x1="9" y1="15" x2="15" y2="15"/>
                </svg>
              </div>
              <p className="font-semibold text-teal-700 text-sm mb-1">
                Click to select or drag and drop
              </p>
              <p className="text-teal-400 text-xs">
                Supports CSV, Excel (.xlsx, .xls) — max 10MB
              </p>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              className="hidden"
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) handleFileUpload(f);
                e.target.value = '';
              }}
            />

            <div className="flex gap-2 pt-1">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex-1 py-2.5 rounded-xl bg-gradient-to-r from-teal-500
                           to-teal-600 text-white text-sm font-semibold
                           hover:from-teal-600 hover:to-teal-700 transition-all">
                Browse Files
              </button>
              <button onClick={() => setFileModal(false)}
                className="px-4 py-2.5 rounded-xl border border-teal-200 text-teal-600
                           text-sm font-semibold hover:bg-teal-50 transition-colors">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── SQL block with copy button ────────────────────────────────
function SqlBlock({ sql }: { sql: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(sql).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  }
  return (
    <div className="rounded-xl overflow-hidden border border-teal-900/20">
      <div className="flex items-center justify-between px-3 py-1.5
                      bg-teal-900/90 border-b border-teal-700/30">
        <span className="text-[11px] font-mono font-medium text-teal-300 uppercase tracking-wider">
          SQL Query
        </span>
        <button onClick={copy}
          className="text-[11px] px-2 py-0.5 rounded-md bg-teal-700/40
                     text-teal-300 hover:bg-teal-600/50 hover:text-white
                     transition-colors font-medium">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="bg-teal-950 px-4 py-3 font-mono text-sm text-teal-300
                      overflow-x-auto whitespace-pre-wrap leading-relaxed">
        {sql}
      </pre>
    </div>
  );
}

// ── Data table ────────────────────────────────────────────────
function DataTable({ columns, rows }: { columns: string[]; rows: (string | number | null)[][] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-teal-100">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="bg-teal-50">
            {columns.map(c => (
              <th key={c} className="px-3 py-2 text-left font-bold text-teal-600
                                     uppercase tracking-wider border-b border-teal-100
                                     text-[10px] whitespace-nowrap">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 15).map((row, i) => (
            <tr key={i} className="border-b border-teal-50 hover:bg-teal-50/50 transition-colors">
              {row.map((cell, j) => (
                <td key={j} className="px-3 py-2 text-teal-800 whitespace-nowrap">
                  {cell === null || cell === undefined
                    ? <span className="text-teal-300 italic">NULL</span>
                    : String(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 15 && (
        <p className="text-center text-[11px] text-teal-400 py-2 border-t border-teal-50">
          Showing 15 of {rows.length} rows
        </p>
      )}
    </div>
  );
}

'use client';
import { useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo } from 'react';
import { API, authFetch, saveChatMessage, DEFAULT_SOURCE_ID, errorText } from '@/lib/api';
import { useDash } from './context';
import dynamic from 'next/dynamic';
import Icon, { IconName } from '@/components/Icon';
import DataTable, { downloadCsv } from '@/components/DataTable';
import JoinView from '@/components/JoinVenn';
import { parseJoins } from '@/lib/sqlJoins';
import {
  AnimatePresence,
  LayoutGroup,
  motion,
  Modal,
  Skeleton,
  TypingDots,
  collapse,
  ease,
  fadeUp,
  press,
  spring,
  stagger,
} from '@/components/motion';

const ChartComponent = dynamic(() => import('@/components/ChartBlock'), {
  ssr: false,
  loading: () => <Skeleton className="h-64 rounded-xl" />,
});

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
  source?: string;
}

/** A change (INSERT/UPDATE/DELETE/DDL) an admin asked for — runs only after they confirm. */
interface PendingChange {
  sql: string;
  kind: string;
  full_table: boolean;
  database: string;
  data_source_id?: string | null;
  state: 'waiting' | 'running' | 'done' | 'cancelled' | 'failed';
  result?: string;
}

interface FileResult {
  filename: string;
  file_session_id: string;
  rows: number;
  columns: string[];
  preview: Record<string, unknown>[];
  analysis: string;
}

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'file';
  question?: string;
  text?: string;
  meta?: MetaPayload;
  change?: PendingChange;
  fileResult?: FileResult;
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
  const { setInjectPrompt, sourceId, source, suggestions } = useDash();
  const samples = suggestions.length ? suggestions.slice(0, 4) : SAMPLES;
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [fileModal, setFileModal] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [activeFile, setActiveFile] = useState<FileResult | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sessionRef = useRef<string | null>(
    typeof window !== 'undefined' ? sessionStorage.getItem('sqlanalyst_session_id') : null,
  );

  // ── Fix 1: stable inject registration — no dependency loop ──
  // Use a ref to hold the latest setInjectPrompt so the effect only runs once
  const setInjectRef = useRef(setInjectPrompt);
  setInjectRef.current = setInjectPrompt;

  useEffect(() => {
    setInjectRef.current((q: string) => {
      setInput(q);
      inputRef.current?.focus();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once only — ref keeps it fresh

  // New-chat clears file session too
  useEffect(() => {
    function handleNewChat() {
      setMessages([]);
      setInput('');
      setActiveFile(null);
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

  // ── SSE stream helper ─────────────────────────────────────
  async function streamSSE(
    url: string,
    body: unknown,
    onMeta: (m: MetaPayload) => void,
    onToken: (t: string) => void,
    onDone: () => void,
    onError: (e: string) => void,
    onConfirm?: (c: Omit<PendingChange, 'state'>) => void,
  ) {
    // authFetch refreshes an expired access token and retries once on 401
    const resp = await authFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: 'Request failed' }));
      throw new Error(errorText(err, 'Request failed'));
    }
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        if (!frame.trim()) continue;
        let eventName = 'message',
          dataStr = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataStr = line.slice(5).trim();
        }
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(dataStr);
        } catch {
          continue;
        }
        if (eventName === 'meta') onMeta(payload as unknown as MetaPayload);
        if (eventName === 'token') onToken((payload.token as string) || '');
        if (eventName === 'done') onDone();
        if (eventName === 'error') onError((payload.detail as string) || 'Unknown error');
        if (eventName === 'confirm' && onConfirm)
          onConfirm(payload as unknown as Omit<PendingChange, 'state'>);
      }
    }
  }

  // ── Send question ─────────────────────────────────────────
  const sendQuestion = useCallback(
    async (question: string) => {
      if (!question.trim() || loading) return;
      setInput('');
      setLoading(true);

      const userMsg: Message = { id: Date.now() + 'u', role: 'user', question };
      const aId = Date.now() + 'a';
      setMessages(prev => [
        ...prev,
        userMsg,
        { id: aId, role: 'assistant', streaming: true, text: '' },
      ]);

      let finalMeta: MetaPayload | null = null;
      let finalText = '';

      try {
        // ── Fix 2: route to file endpoint when file is active ──
        const isFileMode = !!activeFile;
        const url = isFileMode ? `${API}/api/ask-file` : `${API}/ask/stream`;
        const body = isFileMode
          ? { question, file_session_id: activeFile!.file_session_id }
          : {
              question,
              session_id: sessionRef.current || undefined,
              // Ask the database chosen in the sidebar (omitted = default database)
              data_source_id: sourceId !== DEFAULT_SOURCE_ID ? sourceId : undefined,
            };

        await streamSSE(
          url,
          body,
          meta => {
            finalMeta = meta;
            if (!isFileMode && meta.session_id) {
              sessionRef.current = meta.session_id;
              sessionStorage.setItem('sqlanalyst_session_id', meta.session_id);
            }
            setMessages(prev => prev.map(m => (m.id === aId ? { ...m, meta } : m)));
          },
          token => {
            finalText += token;
            setMessages(prev =>
              prev.map(m => (m.id === aId ? { ...m, text: (m.text || '') + token } : m)),
            );
          },
          () => {
            setMessages(prev => prev.map(m => (m.id === aId ? { ...m, streaming: false } : m)));
          },
          errMsg => {
            throw new Error(errMsg);
          },
          change => {
            setMessages(prev =>
              prev.map(m => (m.id === aId ? { ...m, change: { ...change, state: 'waiting' } } : m)),
            );
          },
        );

        const metaToSave = finalMeta as MetaPayload | null;
        if (metaToSave) {
          saveChatMessage({
            question,
            sql_query: metaToSave.sql_query,
            explanation: finalText,
            engine_used: metaToSave.engine_used,
            session_id: sessionRef.current || undefined,
          })
            .then(() => window.dispatchEvent(new Event('history-changed')))
            .catch(() => {});
        }
      } catch (err) {
        setMessages(prev =>
          prev.map(m =>
            m.id === aId ? { ...m, streaming: false, error: (err as Error).message } : m,
          ),
        );
      } finally {
        setLoading(false);
      }
    },
    [loading, activeFile, sourceId],
  );

  // ── File upload ───────────────────────────────────────────
  async function handleFileUpload(file: File) {
    setFileModal(false);
    setUploading(true);
    const fileId = Date.now() + 'f';
    setMessages(prev => [
      ...prev,
      {
        id: fileId,
        role: 'file',
        question: `Uploading ${file.name}…`,
      },
    ]);

    try {
      const form = new FormData();
      form.append('file', file);
      const res = await authFetch(`${API}/api/analyze-file`, {
        method: 'POST',
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(errorText(data, 'Upload failed'));

      const result: FileResult = data;
      setActiveFile(result);
      setMessages(prev =>
        prev.map(m => (m.id === fileId ? { ...m, question: file.name, fileResult: result } : m)),
      );
    } catch (err) {
      setMessages(prev =>
        prev.map(m => (m.id === fileId ? { ...m, error: (err as Error).message } : m)),
      );
    } finally {
      setUploading(false);
    }
  }

  function handleFileDrop(e: React.DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFileUpload(file);
  }

  // ── Run (or cancel) a change the admin asked for in the chat ──
  async function runChange(msgId: string, change: PendingChange) {
    const setChange = (patch: Partial<PendingChange>) =>
      setMessages(prev =>
        prev.map(m =>
          m.id === msgId && m.change ? { ...m, change: { ...m.change, ...patch } } : m,
        ),
      );
    if (
      change.full_table &&
      !window.confirm(
        `This ${change.kind.toUpperCase()} affects every row of the table or removes it on "${change.database}".\n\n${change.sql}\n\nRun it anyway?`,
      )
    )
      return;
    setChange({ state: 'running' });
    try {
      const res = await authFetch('/admin/sql/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sql: change.sql,
          data_source_id: change.data_source_id || undefined,
          confirm_full_table: change.full_table,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(errorText(data, 'The change failed'));
      const rows =
        data.rows_affected === null || data.rows_affected === undefined
          ? 'done'
          : `${data.rows_affected} row(s) affected`;
      setChange({
        state: 'done',
        result:
          `${String(data.kind).toUpperCase()} on ${data.database}: ${rows} in ${data.timing_ms}ms.` +
          (data.schema_refreshed ? ' Table list refreshed.' : ''),
      });
      if (data.schema_refreshed) window.dispatchEvent(new Event('schema-changed'));
    } catch (err) {
      setChange({ state: 'failed', result: (err as Error).message });
    }
  }

  function cancelChange(msgId: string) {
    setMessages(prev =>
      prev.map(m =>
        m.id === msgId && m.change
          ? {
              ...m,
              change: {
                ...m.change,
                state: 'cancelled',
                result: 'Cancelled — nothing was changed.',
              },
            }
          : m,
      ),
    );
  }

  // Grow the question box with its content (up to ~6 lines)
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  const showWelcome = messages.length === 0;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ── Active file banner ── */}
      <AnimatePresence initial={false}>
        {activeFile && (
          <motion.div {...collapse} className="flex-shrink-0 overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-2 bg-gradient-to-r from-teal-700 to-teal-600 text-white text-sm">
              <Icon name="file" size={15} />
              <p className="min-w-0 truncate">
                Asking about <span className="font-semibold">{activeFile.filename}</span>
                <span className="opacity-75">
                  {' '}
                  · {activeFile.rows.toLocaleString()} rows · {activeFile.columns.length} columns
                </span>
              </p>
              <button
                onClick={() => setActiveFile(null)}
                className="ml-auto flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/15 hover:bg-white/25 text-xs font-medium flex-shrink-0"
              >
                <Icon name="x" size={12} /> Back to database
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Conversation ── */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-3 sm:px-6 py-6 space-y-6">
          {showWelcome && (
            <motion.div
              className="pt-6 sm:pt-12"
              variants={stagger(0.07)}
              initial="hidden"
              animate="show"
            >
              <motion.div variants={fadeUp} className="relative w-12 h-12">
                <motion.span
                  className="absolute inset-0 rounded-2xl bg-teal-400/30"
                  animate={{ scale: [1, 1.35], opacity: [0.6, 0] }}
                  transition={{ duration: 2, repeat: Infinity, ease: 'easeOut' }}
                />
                <motion.div
                  className="relative w-12 h-12 rounded-2xl bg-gradient-to-br from-teal-500 to-teal-700 text-white flex items-center justify-center shadow-teal"
                  animate={{ rotate: [0, -6, 6, 0] }}
                  transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut', repeatDelay: 1 }}
                >
                  <Icon name="sparkles" size={22} />
                </motion.div>
              </motion.div>
              <motion.h1
                variants={fadeUp}
                className="mt-5 font-heading text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight"
              >
                What would you like to know?
              </motion.h1>
              <motion.p variants={fadeUp} className="mt-2 text-slate-500 max-w-xl">
                Ask in plain English. SQLAnalyst writes safe, read-only SQL, runs it on{' '}
                {source ? (
                  <span className="font-medium text-slate-800">{source.name}</span>
                ) : (
                  'your database'
                )}{' '}
                and shows the answer as a chart and a table.
              </motion.p>

              <motion.p variants={fadeUp} className="label mt-8 mb-2">
                Try one of these
              </motion.p>
              <motion.div variants={stagger(0.06)} className="grid sm:grid-cols-2 gap-2.5">
                {samples.map(s => (
                  <motion.button
                    key={s}
                    variants={fadeUp}
                    {...press}
                    onClick={() => sendQuestion(s)}
                    className="card flex items-start gap-3 p-3.5 text-left hover:border-teal-300 hover:shadow-teal transition-[border-color,box-shadow] group"
                  >
                    <span className="mt-0.5 w-6 h-6 -ml-0.5 rounded-lg bg-teal-50 text-teal-600 flex items-center justify-center flex-shrink-0 group-hover:bg-teal-600 group-hover:text-white transition-colors">
                      <Icon name="search" size={13} />
                    </span>
                    <span className="text-sm text-slate-700 group-hover:text-slate-900">{s}</span>
                  </motion.button>
                ))}
              </motion.div>

              <motion.button
                variants={fadeUp}
                whileHover={{ x: 3 }}
                onClick={() => setFileModal(true)}
                className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-teal-700 hover:text-teal-900"
              >
                <Icon name="fileUp" size={15} /> Or upload a CSV / Excel file and ask about it
              </motion.button>
            </motion.div>
          )}

          {messages.map(msg => (
            <div key={msg.id}>
              {msg.role === 'user' && (
                <div className="flex justify-end">
                  <motion.div
                    initial={{ opacity: 0, y: 12, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={spring}
                    style={{ transformOrigin: 'bottom right' }}
                    className="max-w-[85%] sm:max-w-[75%] bg-gradient-to-br from-teal-500 to-teal-700 text-white px-4 py-2.5 rounded-2xl rounded-br-md text-[15px] leading-relaxed shadow-teal whitespace-pre-wrap"
                  >
                    {msg.question}
                  </motion.div>
                </div>
              )}

              {msg.role === 'file' && <FileCard msg={msg} />}

              {msg.role === 'assistant' && (
                <AnswerCard
                  msg={msg}
                  onRunChange={() => runChange(msg.id, msg.change!)}
                  onCancelChange={() => cancelChange(msg.id)}
                />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ── Question box ── */}
      <div className="flex-shrink-0 px-3 sm:px-6 pb-3 sm:pb-4 pt-2 bg-gradient-to-t from-slate-50 via-slate-50">
        <div className="max-w-4xl mx-auto">
          <div
            className={`flex items-end gap-2 bg-white rounded-2xl border shadow-sm p-2 transition-colors
              ${activeFile ? 'border-teal-400' : 'border-slate-200 focus-within:border-teal-500 focus-within:ring-4 focus-within:ring-teal-500/10'}`}
          >
            <button
              onClick={() => setFileModal(true)}
              disabled={uploading}
              title="Upload a CSV or Excel file to ask about"
              aria-label="Upload a file"
              className={`btn-icon flex-shrink-0 ${activeFile ? 'text-teal-700 bg-teal-50' : ''}`}
            >
              {uploading ? (
                <span className="w-4 h-4 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
              ) : (
                <Icon name="paperclip" size={18} />
              )}
            </button>

            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  sendQuestion(input);
                }
              }}
              disabled={loading}
              aria-label="Your question"
              placeholder={
                activeFile
                  ? `Ask about ${activeFile.filename}…`
                  : `Ask about ${source?.name ?? 'your data'}…  e.g. top 10 customers by revenue`
              }
              className="flex-1 resize-none bg-transparent px-1 py-2 text-[15px] leading-6 text-slate-900
                         placeholder-slate-400 outline-none disabled:opacity-60 max-h-40"
            />

            <motion.button
              onClick={() => sendQuestion(input)}
              disabled={loading || !input.trim()}
              aria-label="Send"
              whileTap={{ scale: 0.94 }}
              className="btn-primary h-9 px-3 sm:px-4 flex-shrink-0 min-w-[44px]"
            >
              <AnimatePresence mode="wait" initial={false}>
                {loading ? (
                  <motion.span
                    key="busy"
                    initial={{ opacity: 0, scale: 0.6 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.6 }}
                    className="flex"
                  >
                    <TypingDots className="bg-white" />
                  </motion.span>
                ) : (
                  <motion.span
                    key="idle"
                    initial={{ opacity: 0, x: -6 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 8 }}
                    className="flex items-center gap-1.5"
                  >
                    <span className="hidden sm:inline">Ask</span>
                    <Icon name="send" size={14} />
                  </motion.span>
                )}
              </AnimatePresence>
            </motion.button>
          </div>
          <p className="hidden sm:block text-center text-[11px] text-slate-400 mt-1.5">
            Enter to send · Shift + Enter for a new line · queries are read-only and checked before
            they run
          </p>
        </div>
      </div>

      {/* ── File upload dialog ── */}
      <AnimatePresence>
        {fileModal && (
          <Modal
            onClose={() => setFileModal(false)}
            labelledBy="upload-title"
            className="card shadow-xl w-full max-w-md p-6"
          >
            <div onDragOver={e => e.preventDefault()} onDrop={handleFileDrop}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 id="upload-title" className="font-semibold text-lg text-slate-900">
                    Upload a file
                  </h2>
                  <p className="text-sm text-slate-500 mt-0.5">
                    Your next questions will be answered from this file.
                  </p>
                </div>
                <button
                  onClick={() => setFileModal(false)}
                  aria-label="Close"
                  className="btn-icon w-8 h-8 -mr-2 -mt-1"
                >
                  <Icon name="x" size={16} />
                </button>
              </div>

              <motion.button
                whileHover={{ scale: 1.01 }}
                whileTap={{ scale: 0.99 }}
                onClick={() => fileInputRef.current?.click()}
                className="mt-5 w-full border-2 border-dashed border-slate-200 rounded-2xl p-8 text-center
                         hover:border-teal-400 hover:bg-teal-50/40 transition-colors group"
              >
                <motion.span
                  animate={{ y: [0, -4, 0] }}
                  transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                  className="w-12 h-12 rounded-xl bg-teal-50 text-teal-600 flex items-center justify-center mx-auto mb-3 group-hover:bg-teal-100"
                >
                  <Icon name="fileUp" size={22} />
                </motion.span>
                <span className="block font-medium text-slate-800 text-sm">
                  Click to choose a file, or drop it here
                </span>
                <span className="block text-slate-400 text-xs mt-1">
                  CSV, XLSX or XLS · up to 10 MB
                </span>
              </motion.button>

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

              <div className="flex justify-end gap-2 mt-5">
                <button onClick={() => setFileModal(false)} className="btn-secondary">
                  Cancel
                </button>
                <button onClick={() => fileInputRef.current?.click()} className="btn-primary">
                  Choose file
                </button>
              </div>
            </div>
          </Modal>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Answer card: explanation first, then Chart / Table / SQL tabs
// ─────────────────────────────────────────────────────────────
type View = 'chart' | 'table' | 'joins' | 'sql';

function AnswerCard({
  msg,
  onRunChange,
  onCancelChange,
}: {
  msg: Message;
  onRunChange: () => void;
  onCancelChange: () => void;
}) {
  const meta = msg.meta;
  const hasRows = !!meta && meta.columns.length > 0;
  const hasChart = hasRows && !!meta?.chart;
  const joins = useMemo(() => parseJoins(meta?.sql_query), [meta?.sql_query]);
  const [view, setView] = useState<View | null>(null);
  const active: View = view ?? (hasChart ? 'chart' : hasRows ? 'table' : 'sql');
  const waiting = msg.streaming && !meta && !msg.change && !msg.error;

  const views: { id: View; label: string; icon: IconName; show: boolean }[] = [
    { id: 'chart', label: 'Chart', icon: 'chart', show: hasChart },
    {
      id: 'table',
      label: `Table${meta ? ` · ${meta.row_count}` : ''}`,
      icon: 'table',
      show: hasRows,
    },
    {
      id: 'joins',
      label: `Joins · ${joins.length}`,
      icon: 'join',
      show: joins.length > 0,
    },
    { id: 'sql', label: 'SQL', icon: 'code', show: !!meta?.sql_query },
  ];

  return (
    <motion.div
      className="flex gap-3"
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...ease, delay: 0.08 }}
    >
      <div className="relative hidden sm:flex w-8 h-8 flex-shrink-0 mt-0.5">
        {msg.streaming && (
          <motion.span
            className="absolute inset-0 rounded-full bg-teal-400/40"
            animate={{ scale: [1, 1.6], opacity: [0.7, 0] }}
            transition={{ duration: 1.4, repeat: Infinity, ease: 'easeOut' }}
          />
        )}
        <span className="relative w-8 h-8 rounded-full bg-gradient-to-br from-teal-500 to-teal-700 text-white flex items-center justify-center">
          <Icon name="sparkles" size={15} />
        </span>
      </div>
      <div className="card flex-1 min-w-0 overflow-hidden">
        {/* Header */}
        <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
          <span className="text-sm font-semibold text-slate-900">SQLAnalyst</span>
          {meta?.source && (
            <span className="chip">
              <Icon name="database" size={11} /> {meta.source}
            </span>
          )}
          <span className="flex-1" />
          {msg.streaming && meta && (
            <span className="chip border-teal-200 bg-teal-50 text-teal-700">
              <TypingDots /> Writing
            </span>
          )}
          {!msg.streaming && meta && (
            <>
              <span className="chip" title="Time taken">
                <Icon name="clock" size={11} /> {meta.timing_ms} ms
              </span>
              <span
                className="chip border-emerald-200 bg-emerald-50 text-emerald-700"
                title="Checked by the SQL safety engine and run read-only"
              >
                <Icon name="shield" size={11} />
                {meta.engine_used === 'file-sqlite' ? 'File' : 'Safe'}
              </span>
            </>
          )}
        </div>

        <div className="px-4 pb-4 pt-2 space-y-3">
          {waiting && <Thinking />}

          {msg.error && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, x: [0, -5, 5, -3, 3, 0] }}
              transition={{ duration: 0.4 }}
              className="flex gap-2.5 rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-700"
            >
              <Icon name="alert" size={16} className="mt-0.5" />
              <p className="whitespace-pre-wrap">{msg.error}</p>
            </motion.div>
          )}

          {msg.text && (
            <p className="text-[15px] leading-relaxed text-slate-700 whitespace-pre-wrap">
              {msg.text}
              {msg.streaming && (
                <span className="inline-block w-1.5 h-4 ml-0.5 align-middle bg-teal-500 animate-blink" />
              )}
            </p>
          )}

          {msg.change && (
            <ChangeCard change={msg.change} onRun={onRunChange} onCancel={onCancelChange} />
          )}

          {meta && views.some(v => v.show) && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={ease}
              className="rounded-xl border border-slate-200 overflow-hidden"
            >
              <LayoutGroup id={`views-${msg.id}`}>
                <div className="flex items-center gap-1 px-1.5 py-1.5 bg-slate-50 border-b border-slate-200">
                  {views
                    .filter(v => v.show)
                    .map(v => (
                      <button
                        key={v.id}
                        onClick={() => setView(v.id)}
                        aria-pressed={active === v.id}
                        className={`relative flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                          active === v.id ? 'text-slate-900' : 'text-slate-500 hover:text-slate-800'
                        }`}
                      >
                        {active === v.id && (
                          <motion.span
                            layoutId="view-pill"
                            transition={spring}
                            className="absolute inset-0 rounded-lg bg-white shadow-sm border border-slate-200"
                          />
                        )}
                        <span className="relative flex items-center gap-1.5">
                          <Icon name={v.icon} size={13} /> {v.label}
                        </span>
                      </button>
                    ))}
                  <span className="flex-1" />
                  {active === 'table' && hasRows && (
                    <button
                      onClick={() => downloadCsv(meta.columns, meta.rows)}
                      className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium text-slate-500 hover:text-slate-900 hover:bg-white"
                    >
                      <Icon name="download" size={13} /> CSV
                    </button>
                  )}
                  {active === 'sql' && <CopyButton text={meta.sql_query} />}
                </div>
              </LayoutGroup>

              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={active}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.18 }}
                >
                  {active === 'chart' && hasChart && (
                    <div className="p-4">
                      <ChartComponent chart={meta.chart!} columns={meta.columns} rows={meta.rows} />
                    </div>
                  )}
                  {active === 'table' && hasRows && (
                    <>
                      {joins.length > 0 && (
                        <button
                          onClick={() => setView('joins')}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-slate-600 bg-teal-50/60 border-b border-slate-200 hover:bg-teal-50"
                        >
                          <Icon name="join" size={13} className="text-teal-700" />
                          <span className="truncate">
                            Combines{' '}
                            {[joins[0].left, ...joins.map(j => j.right)].map((t, i, all) => (
                              <span key={i}>
                                <span className="font-mono font-medium text-slate-800">{t}</span>
                                {i < all.length - 1 && ' + '}
                              </span>
                            ))}
                          </span>
                          <span className="ml-auto flex-shrink-0 font-medium text-teal-700">
                            See how →
                          </span>
                        </button>
                      )}
                      <DataTable columns={meta.columns} rows={meta.rows} />
                    </>
                  )}
                  {active === 'joins' && joins.length > 0 && <JoinView joins={joins} />}
                  {active === 'sql' && <SqlCode sql={meta.sql_query} />}
                </motion.div>
              </AnimatePresence>
            </motion.div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

// Cycles through what the assistant is doing while it waits for the first result
const THINKING_STEPS = [
  'Understanding your question…',
  'Writing SQL…',
  'Querying the database…',
  'Preparing the answer…',
];

function Thinking() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setStep(s => Math.min(s + 1, THINKING_STEPS.length - 1)), 1600);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="py-1 space-y-3" aria-live="polite">
      <div className="flex items-center gap-2.5 text-sm text-slate-500 h-5">
        <TypingDots />
        <AnimatePresence mode="wait">
          <motion.span
            key={step}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.2 }}
          >
            {THINKING_STEPS[step]}
          </motion.span>
        </AnimatePresence>
      </div>
      <div className="space-y-2" aria-hidden>
        <Skeleton className="h-3 w-11/12" />
        <Skeleton className="h-3 w-4/5" />
        <Skeleton className="h-3 w-3/5" />
      </div>
    </div>
  );
}

function ChangeCard({
  change,
  onRun,
  onCancel,
}: {
  change: PendingChange;
  onRun: () => void;
  onCancel: () => void;
}) {
  const tone =
    change.state === 'failed'
      ? 'border-red-200 bg-red-50'
      : change.state === 'done'
        ? 'border-emerald-200 bg-emerald-50'
        : change.state === 'cancelled'
          ? 'border-slate-200 bg-slate-50'
          : 'border-amber-200 bg-amber-50';
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={spring}
      className={`rounded-xl border p-3.5 space-y-3 transition-colors duration-300 ${tone}`}
    >
      <div className="flex items-start gap-2">
        <Icon name="alert" size={16} className="mt-0.5 text-amber-600" />
        <div className="text-sm">
          <p className="font-semibold text-slate-900">
            {change.kind.toUpperCase()} on {change.database}
            {change.full_table && <span className="text-red-700"> · affects the whole table</span>}
          </p>
          {change.state === 'waiting' && (
            <p className="text-slate-600 mt-0.5">
              Nothing has changed yet. Check the statement, then run it or cancel.
            </p>
          )}
        </div>
      </div>
      <div className="rounded-lg overflow-hidden border border-slate-200">
        <SqlCode sql={change.sql} />
      </div>
      {change.state === 'waiting' && (
        <div className="flex gap-2">
          <button onClick={onRun} className="btn-danger py-1.5">
            <Icon name="play" size={13} /> Run change
          </button>
          <button onClick={onCancel} className="btn-secondary py-1.5">
            Cancel
          </button>
        </div>
      )}
      {change.state === 'running' && (
        <p className="flex items-center gap-2 text-sm font-medium text-amber-800">
          <TypingDots className="bg-amber-500" /> Running…
        </p>
      )}
      {change.result && (
        <p
          className={`text-sm font-medium ${
            change.state === 'failed'
              ? 'text-red-700'
              : change.state === 'done'
                ? 'text-emerald-800'
                : 'text-slate-600'
          }`}
        >
          {change.result}
        </p>
      )}
    </motion.div>
  );
}

function FileCard({ msg }: { msg: Message }) {
  const f = msg.fileResult;
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={ease}
      className="card p-4 space-y-3"
    >
      <div className="flex items-center gap-3">
        <span className="w-9 h-9 rounded-xl bg-teal-50 text-teal-600 flex items-center justify-center">
          <Icon name="file" size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-sm text-slate-900 truncate">
            {f ? f.filename : msg.question}
          </p>
          {f && (
            <p className="text-xs text-slate-500">
              {f.rows.toLocaleString()} rows · {f.columns.length} columns · questions now use this
              file
            </p>
          )}
        </div>
        {!f && !msg.error && (
          <span className="w-4 h-4 border-2 border-teal-500 border-t-transparent rounded-full animate-spin" />
        )}
      </div>
      {msg.error && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {msg.error}
        </p>
      )}
      {f && (
        <>
          {f.analysis && <p className="text-sm text-slate-700 leading-relaxed">{f.analysis}</p>}
          <div className="rounded-xl border border-slate-200 overflow-hidden">
            <DataTable
              columns={f.columns}
              rows={f.preview.map(r =>
                f.columns.map(c => (r[c] ?? null) as string | number | null),
              )}
              maxHeight="max-h-60"
            />
          </div>
        </>
      )}
    </motion.div>
  );
}

function SqlCode({ sql }: { sql: string }) {
  return (
    <pre className="bg-slate-900 text-slate-100 px-4 py-3 font-mono text-[13px] leading-relaxed overflow-x-auto whitespace-pre-wrap">
      {sql}
    </pre>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() =>
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
      className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium text-slate-500 hover:text-slate-900 hover:bg-white"
    >
      <Icon name={copied ? 'check' : 'copy'} size={13} /> {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

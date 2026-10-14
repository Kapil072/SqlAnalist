'use client';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  getToken,
  getUser,
  ensureFreshToken,
  clearSession,
  fetchSources,
  fetchSourceSchema,
  refreshSourceSchema,
  getSavedSourceId,
  saveSourceId,
  DEFAULT_SOURCE_ID,
  fetchHealth,
  fetchChatHistory,
  TableInfo,
  ChatMessage,
  HealthData,
  SourceInfo,
} from '@/lib/api';
import Navbar from '@/components/Navbar';
import Sidebar from '@/components/Sidebar';
import LoadingScreen from '@/components/LoadingScreen';
import { AnimatePresence } from '@/components/motion';
import dynamic from 'next/dynamic';
import { DashContext } from './context';

const SchemaDiagram = dynamic(() => import('@/components/SchemaDiagram'), { ssr: false });

// ── Layout ────────────────────────────────────────────────────
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [sourceId, setSourceId] = useState<string>(DEFAULT_SOURCE_ID);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [totalRows, setTotalRows] = useState<number | null>(0);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [schemaError, setSchemaError] = useState('');
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [dbStatus, setDbStatus] = useState<HealthData | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [injector, setInjector] = useState<(q: string) => void>(() => () => {});
  // Tables panel: open on wide screens, a drawer that starts closed on phones/tablets
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [diagramOpen, setDiagramOpen] = useState(false);

  // Single mount effect — auth guard + data loading
  useEffect(() => {
    setMounted(true);
    // Open the tables panel on wide screens; close it when the window gets narrow
    const wide = window.matchMedia('(min-width: 1024px)');
    setSidebarOpen(wide.matches);
    const onWidth = (e: MediaQueryListEvent) => setSidebarOpen(e.matches);
    wide.addEventListener('change', onWidth);
    (async () => {
      // Expired access token? Try the refresh cookie before sending the user to login.
      if (!getToken() || !(await ensureFreshToken())) {
        clearSession();
        router.replace('/auth');
        return;
      }
      setIsAdmin(getUser()?.role === 'admin');
      loadSources();
      loadHealthData();
      loadHistoryData();
    })();
    return () => wide.removeEventListener('change', onWidth);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The SQL console announces CREATE / DROP / ALTER so the table list stays current
  useEffect(() => {
    const onChanged = () => {
      if (getToken()) loadSchemaData(sourceId);
    };
    window.addEventListener('schema-changed', onChanged);
    return () => window.removeEventListener('schema-changed', onChanged);
  }, [sourceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // The chat announces each saved question so "Recent" stays current
  useEffect(() => {
    const onSaved = () => loadHistoryData();
    window.addEventListener('history-changed', onSaved);
    return () => window.removeEventListener('history-changed', onSaved);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Reload the schema whenever the selected database changes
  useEffect(() => {
    if (mounted && getToken()) loadSchemaData(sourceId);
  }, [sourceId, mounted]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadSources() {
    try {
      const list = await fetchSources();
      setSources(list);
      // Restore the last database this browser used, if it still exists
      const saved = getSavedSourceId();
      setSourceId(list.some(s => s.id === saved) ? saved : DEFAULT_SOURCE_ID);
    } catch {
      setSources([]);
    }
  }

  function applySchema(data: { tables: TableInfo[]; suggestions?: string[] }) {
    setTables(data.tables);
    setSuggestions(data.suggestions || []);
    // External databases do not report row counts (null)
    const counted = data.tables.filter(t => typeof t.row_count === 'number');
    setTotalRows(counted.length ? counted.reduce((s, t) => s + (t.row_count || 0), 0) : null);
  }

  async function loadSchemaData(id: string) {
    setSchemaError('');
    try {
      applySchema(await fetchSourceSchema(id));
    } catch (e) {
      setTables([]);
      setSuggestions([]);
      setTotalRows(null);
      setSchemaError((e as Error).message);
    }
  }

  async function loadHealthData() {
    try {
      setDbStatus(await fetchHealth());
    } catch {}
  }

  async function loadHistoryData() {
    try {
      setHistory(await fetchChatHistory(30));
    } catch {}
  }

  const handleSourceChange = useCallback((id: string) => {
    setSourceId(id);
    saveSourceId(id);
    // Start a fresh conversation — earlier answers were about another database
    sessionStorage.removeItem('sqlanalyst_session_id');
    window.dispatchEvent(new Event('new-chat'));
  }, []);

  const handleRefreshSchema = useCallback(async () => {
    setRefreshing(true);
    setSchemaError('');
    try {
      applySchema(await refreshSourceSchema(sourceId));
    } catch (e) {
      setSchemaError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, [sourceId]);

  const handleNewChat = useCallback(() => {
    sessionStorage.removeItem('sqlanalyst_session_id');
    window.dispatchEvent(new Event('new-chat'));
  }, []);

  const isSmallScreen = () => !window.matchMedia('(min-width: 1024px)').matches;

  const handleHistoryClick = useCallback(
    (q: string) => {
      injector(q);
      if (isSmallScreen()) setSidebarOpen(false);
    },
    [injector],
  );

  const source = useMemo(() => sources.find(s => s.id === sourceId) || null, [sources, sourceId]);

  const ctxValue = useMemo(
    () => ({
      injectPrompt: injector,
      setInjectPrompt: (fn: (q: string) => void) => setInjector(() => fn),
      sourceId,
      source,
      suggestions,
    }),
    [injector, sourceId, source, suggestions],
  );

  // Don't render until mounted — prevents SSR/hydration mismatch
  if (!mounted) {
    return (
      <LoadingScreen
        message="Loading Dashboard…"
        subMessage="Introspecting database tables and preparing session"
      />
    );
  }

  return (
    <DashContext.Provider value={ctxValue}>
      <div className="flex flex-col h-screen overflow-hidden bg-slate-50">
        <Navbar
          dbStatus={
            dbStatus
              ? {
                  ok: dbStatus.status === 'healthy' && (dbStatus.target_db?.connected ?? false),
                  version: dbStatus.target_db?.version,
                }
              : undefined
          }
          onNewChat={handleNewChat}
          onToggleSidebar={() => setSidebarOpen(o => !o)}
          sources={sources}
          sourceId={sourceId}
          onSourceChange={handleSourceChange}
          sourceError={schemaError}
        />
        <div className="flex flex-1 overflow-hidden">
          <Sidebar
            open={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
            tables={tables}
            totalRows={totalRows}
            history={history}
            onHistoryClick={handleHistoryClick}
            onRefresh={isAdmin ? handleRefreshSchema : undefined}
            refreshing={refreshing}
            sources={sources}
            sourceId={sourceId}
            schemaError={schemaError}
            onOpenDiagram={() => setDiagramOpen(true)}
          />
          <main className="flex-1 min-w-0 overflow-hidden flex flex-col">{children}</main>
        </div>
      </div>
      <AnimatePresence>
        {diagramOpen && (
          <SchemaDiagram
            key={sourceId}
            tables={tables}
            sourceName={source?.name}
            onClose={() => setDiagramOpen(false)}
          />
        )}
      </AnimatePresence>
    </DashContext.Provider>
  );
}

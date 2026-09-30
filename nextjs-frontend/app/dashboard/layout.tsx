'use client';
import { useEffect, useState, useCallback, createContext, useContext } from 'react';
import { useRouter } from 'next/navigation';
import {
  getToken,
  fetchSchema, refreshSchema as apiRefreshSchema,
  fetchHealth, fetchChatHistory,
  TableInfo, ChatMessage, HealthData,
} from '@/lib/api';
import Navbar from '@/components/Navbar';
import Sidebar from '@/components/Sidebar';

// ── Context so child pages can push prompts ───────────────────
interface DashCtx {
  injectPrompt: (q: string) => void;
  setInjectPrompt: (fn: (q: string) => void) => void;
}
export const DashContext = createContext<DashCtx>({
  injectPrompt: () => {},
  setInjectPrompt: () => {},
});
export function useDash() { return useContext(DashContext); }

// ── Layout ────────────────────────────────────────────────────
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [mounted,    setMounted]    = useState(false);
  const [tables,     setTables]     = useState<TableInfo[]>([]);
  const [totalRows,  setTotalRows]  = useState(0);
  const [history,    setHistory]    = useState<ChatMessage[]>([]);
  const [dbStatus,   setDbStatus]   = useState<HealthData | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [injector,   setInjector]   = useState<(q: string) => void>(() => () => {});

  // Single mount effect — auth guard + data loading
  useEffect(() => {
    setMounted(true);
    if (!getToken()) {
      router.replace('/auth');
      return;
    }
    loadSchemaData();
    loadHealthData();
    loadHistoryData();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadSchemaData() {
    try {
      const data = await fetchSchema();
      setTables(data.tables);
      setTotalRows(data.tables.reduce((s, t) => s + (t.row_count || 0), 0));
    } catch {}
  }

  async function loadHealthData() {
    try { setDbStatus(await fetchHealth()); } catch {}
  }

  async function loadHistoryData() {
    try { setHistory(await fetchChatHistory(30)); } catch {}
  }

  const handleRefreshSchema = useCallback(async () => {
    setRefreshing(true);
    try { await apiRefreshSchema(); await loadSchemaData(); } catch {}
    finally { setRefreshing(false); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleNewChat = useCallback(() => {
    sessionStorage.removeItem('sqlanalyst_session_id');
    window.dispatchEvent(new Event('new-chat'));
  }, []);

  const ctxValue: DashCtx = {
    injectPrompt: injector,
    setInjectPrompt: (fn) => setInjector(() => fn),
  };

  // Don't render until mounted — prevents SSR/hydration mismatch
  if (!mounted) {
    return (
      <div className="flex items-center justify-center min-h-screen
                      bg-gradient-to-br from-teal-50 to-teal-100">
        <div className="w-10 h-10 rounded-full border-2 border-teal-500
                        border-t-transparent animate-spin" />
      </div>
    );
  }

  return (
    <DashContext.Provider value={ctxValue}>
      <div className="flex flex-col h-screen overflow-hidden
                      bg-gradient-to-br from-teal-50 to-teal-100">
        <Navbar
          dbStatus={dbStatus ? {
            ok: dbStatus.status === 'healthy' && (dbStatus.target_db?.connected ?? false),
            version: dbStatus.target_db?.version,
          } : undefined}
          onNewChat={handleNewChat}
          onRefreshSchema={handleRefreshSchema}
        />
        <div className="flex flex-1 overflow-hidden">
          <Sidebar
            tables={tables}
            totalRows={totalRows}
            history={history}
            onHistoryClick={(q) => injector(q)}
            onRefresh={handleRefreshSchema}
            refreshing={refreshing}
          />
          <main className="flex-1 overflow-hidden flex flex-col">
            {children}
          </main>
        </div>
      </div>
    </DashContext.Provider>
  );
}

'use client';
import { useState, useEffect, useCallback } from 'react';
import {
  fetchAdminStats, fetchAdminUsers, updateAdminUser,
  fetchAuditLogs, fetchDataSources,
  createDataSource, updateDataSource,
  testDataSourceConnection, deleteDataSource,
  AdminStats, AdminUser, AuditLog, DataSource,
  DataSourceCreate, timeAgo,
} from '@/lib/api';

type Tab = 'overview' | 'users' | 'audit' | 'datasources';

// ── Stat card ──────────────────────────────────────────────────
function StatCard({ label, value, sub, color }: {
  label: string; value: number; sub?: string; color: string;
}) {
  return (
    <div className={`bg-white rounded-2xl border p-5 shadow-teal ${color}`}>
      <p className="text-xs font-bold uppercase tracking-wider text-teal-500 mb-1">{label}</p>
      <p className="font-heading text-3xl font-extrabold text-teal-800 tracking-tight">
        {value.toLocaleString()}
      </p>
      {sub && <p className="text-xs text-teal-400 mt-1">{sub}</p>}
    </div>
  );
}

// ── Badge ──────────────────────────────────────────────────────
function Badge({ label, variant }: { label: string; variant: 'green' | 'red' | 'teal' | 'amber' }) {
  const cls = {
    green: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    red:   'bg-red-50   text-red-700   border-red-200',
    teal:  'bg-teal-50  text-teal-700  border-teal-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
  }[variant];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px]
                      font-semibold border ${cls}`}>
      {label}
    </span>
  );
}

// ── DB default ports ───────────────────────────────────────────
const DB_PORTS: Record<string, number> = {
  postgresql: 5432, mysql: 3306, sqlserver: 1433, oracle: 1521, sqlite: 0,
};

// ── Add Data Source Modal ──────────────────────────────────────
function AddDataSourceModal({
  onClose, onSave,
}: {
  onClose: () => void;
  onSave: (ds: DataSource) => void;
}) {
  const [form, setForm] = useState<DataSourceCreate>({
    name: '', db_type: 'mysql', host: '', port: 3306,
    username: '', database_name: '', password: '',
  });
  const [saving,   setSaving]   = useState(false);
  const [testing,  setTesting]  = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [error, setError] = useState('');

  function set(k: keyof DataSourceCreate, v: string | number) {
    setForm(f => ({ ...f, [k]: v }));
    setTestResult(null);
    setError('');
  }

  function onDbTypeChange(t: string) {
    setForm(f => ({ ...f, db_type: t, port: DB_PORTS[t] || 0 }));
    setTestResult(null);
  }

  async function handleTest() {
    setTesting(true); setTestResult(null); setError('');
    try {
      const r = await testDataSourceConnection(form);
      setTestResult(r);
    } catch (e) { setError((e as Error).message); }
    finally { setTesting(false); }
  }

  async function handleSave() {
    if (!form.name || !form.db_type) { setError('Name and database type are required.'); return; }
    setSaving(true); setError('');
    try {
      const ds = await createDataSource(form);
      onSave(ds);
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }

  const isSqlite = form.db_type === 'sqlite';

  const inputCls = `w-full px-3 py-2 rounded-xl border border-teal-200 bg-white text-sm
                    text-teal-900 outline-none focus:border-teal-500 focus:ring-2
                    focus:ring-teal-200/60 transition-all placeholder-teal-300`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4
                    bg-black/40 backdrop-blur-sm"
         onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh]
                      overflow-y-auto p-6 space-y-5">

        <div className="flex items-center justify-between">
          <h2 className="font-heading font-bold text-lg text-teal-800">
            Add Data Source
          </h2>
          <button onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg
                       text-teal-400 hover:text-teal-700 hover:bg-teal-50 transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Name */}
        <div className="space-y-1">
          <label className="text-[11px] font-bold uppercase tracking-wider text-teal-600">
            Connection Name *
          </label>
          <input value={form.name} onChange={e => set('name', e.target.value)}
            placeholder="e.g. Production MySQL" className={inputCls} />
        </div>

        {/* DB Type */}
        <div className="space-y-1">
          <label className="text-[11px] font-bold uppercase tracking-wider text-teal-600">
            Database Type *
          </label>
          <select value={form.db_type} onChange={e => onDbTypeChange(e.target.value)}
            className={inputCls}>
            {['mysql','postgresql','sqlite','sqlserver','oracle'].map(t => (
              <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
            ))}
          </select>
        </div>

        {isSqlite ? (
          /* SQLite only needs file path */
          <div className="space-y-1">
            <label className="text-[11px] font-bold uppercase tracking-wider text-teal-600">
              Database File Path *
            </label>
            <input value={form.database_name || ''} onChange={e => set('database_name', e.target.value)}
              placeholder="./data/mydb.db" className={inputCls} />
          </div>
        ) : (
          <>
            {/* Host + Port */}
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2 space-y-1">
                <label className="text-[11px] font-bold uppercase tracking-wider text-teal-600">
                  Host *
                </label>
                <input value={form.host || ''} onChange={e => set('host', e.target.value)}
                  placeholder="localhost" className={inputCls} />
              </div>
              <div className="space-y-1">
                <label className="text-[11px] font-bold uppercase tracking-wider text-teal-600">
                  Port *
                </label>
                <input type="number" value={form.port || ''} onChange={e => set('port', Number(e.target.value))}
                  placeholder="3306" className={inputCls} />
              </div>
            </div>

            {/* Database name */}
            <div className="space-y-1">
              <label className="text-[11px] font-bold uppercase tracking-wider text-teal-600">
                Database Name *
              </label>
              <input value={form.database_name || ''} onChange={e => set('database_name', e.target.value)}
                placeholder="analytics" className={inputCls} />
            </div>

            {/* Username + Password */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-[11px] font-bold uppercase tracking-wider text-teal-600">
                  Username *
                </label>
                <input value={form.username || ''} onChange={e => set('username', e.target.value)}
                  placeholder="root" className={inputCls} />
              </div>
              <div className="space-y-1">
                <label className="text-[11px] font-bold uppercase tracking-wider text-teal-600">
                  Password
                </label>
                <input type="password" value={form.password || ''} onChange={e => set('password', e.target.value)}
                  placeholder="••••••••" className={inputCls} />
              </div>
            </div>
          </>
        )}

        {/* Error */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3
                          text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Test result */}
        {testResult && (
          <div className={`rounded-xl px-4 py-3 text-sm font-medium border
                           ${testResult.success
                             ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                             : 'bg-red-50 border-red-200 text-red-700'}`}>
            {testResult.success ? 'Connection successful' : testResult.message}
            {testResult.success && (testResult as {execution_time_ms?: number}).execution_time_ms !== undefined && (
              <span className="ml-2 opacity-60 font-normal">
                ({(testResult as {execution_time_ms?: number}).execution_time_ms}ms)
              </span>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 pt-1">
          <button onClick={handleTest} disabled={testing}
            className="flex-1 py-2.5 rounded-xl border border-teal-300 text-teal-700
                       text-sm font-semibold hover:bg-teal-50 transition-colors
                       disabled:opacity-50">
            {testing ? 'Testing…' : 'Test Connection'}
          </button>
          <button onClick={handleSave} disabled={saving}
            className="flex-1 py-2.5 rounded-xl bg-gradient-to-r from-teal-500 to-teal-600
                       text-white text-sm font-semibold hover:from-teal-600 hover:to-teal-700
                       transition-all disabled:opacity-50">
            {saving ? 'Saving…' : 'Save & Add'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Edit Data Source Modal ─────────────────────────────────────
function EditDataSourceModal({
  ds, onClose, onSave,
}: {
  ds: DataSource;
  onClose: () => void;
  onSave: (updated: DataSource) => void;
}) {
  const [form, setForm] = useState({
    name: ds.name, is_active: ds.is_active, password: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');

  async function handleSave() {
    setSaving(true); setError('');
    try {
      const body: Record<string, unknown> = { name: form.name, is_active: form.is_active };
      if (form.password) body.password = form.password;
      const updated = await updateDataSource(ds.id, body);
      onSave(updated);
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }

  const inputCls = `w-full px-3 py-2 rounded-xl border border-teal-200 bg-white text-sm
                    text-teal-900 outline-none focus:border-teal-500 focus:ring-2
                    focus:ring-teal-200/60 transition-all placeholder-teal-300`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4
                    bg-black/40 backdrop-blur-sm"
         onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-heading font-bold text-lg text-teal-800">Edit: {ds.name}</h2>
          <button onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg
                       text-teal-400 hover:text-teal-700 hover:bg-teal-50 transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className="space-y-1">
          <label className="text-[11px] font-bold uppercase tracking-wider text-teal-600">Name</label>
          <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            className={inputCls} />
        </div>

        <div className="space-y-1">
          <label className="text-[11px] font-bold uppercase tracking-wider text-teal-600">
            New Password (leave blank to keep existing)
          </label>
          <input type="password" value={form.password}
            onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
            placeholder="••••••••" className={inputCls} />
        </div>

        <div className="flex items-center gap-3 py-1">
          <button
            onClick={() => setForm(f => ({ ...f, is_active: !f.is_active }))}
            className={`relative w-11 h-6 rounded-full transition-colors duration-200
                        ${form.is_active ? 'bg-teal-500' : 'bg-gray-300'}`}>
            <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow
                               transition-transform duration-200
                               ${form.is_active ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
          <span className="text-sm font-medium text-teal-700">
            {form.is_active ? 'Active' : 'Inactive'}
          </span>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <button onClick={onClose}
            className="flex-1 py-2.5 rounded-xl border border-teal-200 text-teal-600
                       text-sm font-semibold hover:bg-teal-50 transition-colors">
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving}
            className="flex-1 py-2.5 rounded-xl bg-gradient-to-r from-teal-500 to-teal-600
                       text-white text-sm font-semibold hover:from-teal-600 hover:to-teal-700
                       transition-all disabled:opacity-50">
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Admin Page ────────────────────────────────────────────
export default function AdminPage() {
  const [tab,         setTab]         = useState<Tab>('overview');
  const [stats,       setStats]       = useState<AdminStats | null>(null);
  const [users,       setUsers]       = useState<AdminUser[]>([]);
  const [userTotal,   setUserTotal]   = useState(0);
  const [logs,        setLogs]        = useState<AuditLog[]>([]);
  const [logTotal,    setLogTotal]    = useState(0);
  const [logFilter,   setLogFilter]   = useState('');
  const [dataSources, setDataSources] = useState<DataSource[]>([]);
  const [loading,     setLoading]     = useState(false);
  const [toast,       setToast]       = useState('');
  const [showAddDS,   setShowAddDS]   = useState(false);
  const [editDS,      setEditDS]      = useState<DataSource | null>(null);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  }

  const loadTab = useCallback(async (t: Tab) => {
    setLoading(true);
    try {
      if (t === 'overview') {
        const s = await fetchAdminStats();
        setStats(s);
      }
      if (t === 'users') {
        const [s, u] = await Promise.all([fetchAdminStats(), fetchAdminUsers(0, 100)]);
        setStats(s);
        setUsers(u.users);
        setUserTotal(u.total);
      }
      if (t === 'audit') {
        const l = await fetchAuditLogs(0, 100, logFilter || undefined);
        setLogs(l.logs);
        setLogTotal(l.total);
      }
      if (t === 'datasources') {
        const d = await fetchDataSources();
        setDataSources(d.data_sources);
      }
    } catch (err) {
      showToast((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [logFilter]);

  useEffect(() => { loadTab(tab); }, [tab, loadTab]);

  // ── User management ────────────────────────────────────────
  async function toggleActive(u: AdminUser) {
    try {
      const updated = await updateAdminUser(u.id, { is_active: !u.is_active });
      setUsers(prev => prev.map(x => x.id === u.id ? { ...x, ...updated } : x));
      showToast(`${u.name} ${updated.is_active ? 'activated' : 'deactivated'}`);
    } catch (err) { showToast((err as Error).message); }
  }

  async function toggleRole(u: AdminUser) {
    const newRole = u.role === 'admin' ? 'user' : 'admin';
    try {
      const updated = await updateAdminUser(u.id, { role: newRole });
      setUsers(prev => prev.map(x => x.id === u.id ? { ...x, ...updated } : x));
      showToast(`${u.name} is now ${updated.role}`);
    } catch (err) { showToast((err as Error).message); }
  }

  // ── Data source management ─────────────────────────────────
  async function handleDeleteDS(ds: DataSource) {
    if (!confirm(`Delete "${ds.name}"? This cannot be undone.`)) return;
    try {
      await deleteDataSource(ds.id);
      setDataSources(prev => prev.filter(d => d.id !== ds.id));
      showToast(`"${ds.name}" deleted`);
    } catch (err) { showToast((err as Error).message); }
  }

  async function handleToggleActive(ds: DataSource) {
    try {
      const updated = await updateDataSource(ds.id, { is_active: !ds.is_active });
      setDataSources(prev => prev.map(d => d.id === ds.id ? { ...d, ...updated } : d));
      showToast(`${ds.name} ${updated.is_active ? 'activated' : 'deactivated'}`);
    } catch (err) { showToast((err as Error).message); }
  }

  // ── Tab button ─────────────────────────────────────────────
  function TabBtn({ t, label, icon }: { t: Tab; label: string; icon: React.ReactNode }) {
    return (
      <button onClick={() => setTab(t)}
        className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold
                    transition-all duration-200 border
                    ${tab === t
                      ? 'bg-teal-600 text-white border-teal-600 shadow-teal'
                      : 'bg-white text-teal-600 border-teal-200 hover:bg-teal-50'}`}>
        {icon}{label}
      </button>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">

      {/* Toast */}
      {toast && (
        <div className="fixed top-4 right-4 z-50 bg-teal-800 text-white text-sm
                        font-medium px-4 py-2.5 rounded-xl shadow-lg animate-fade-in">
          {toast}
        </div>
      )}

      {/* Modals */}
      {showAddDS && (
        <AddDataSourceModal
          onClose={() => setShowAddDS(false)}
          onSave={ds => {
            setDataSources(prev => [ds, ...prev]);
            setShowAddDS(false);
            showToast(`"${ds.name}" added successfully`);
          }}
        />
      )}
      {editDS && (
        <EditDataSourceModal
          ds={editDS}
          onClose={() => setEditDS(null)}
          onSave={updated => {
            setDataSources(prev => prev.map(d => d.id === updated.id ? updated : d));
            setEditDS(null);
            showToast(`"${updated.name}" updated`);
          }}
        />
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-2xl font-extrabold text-teal-800 tracking-tight">
            Admin Dashboard
          </h1>
          <p className="text-sm text-teal-500 mt-0.5">
            Manage users, monitor queries, and configure data sources.
          </p>
        </div>
        <button onClick={() => loadTab(tab)} disabled={loading}
          className="flex items-center gap-2 px-4 py-2 rounded-xl border border-teal-200
                     bg-white text-teal-600 text-sm font-semibold hover:bg-teal-50
                     disabled:opacity-50 transition-all">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" strokeWidth="2"
               className={loading ? 'animate-spin' : ''}>
            <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>
          </svg>
          Refresh
        </button>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2">
        <TabBtn t="overview" label="Overview"
          icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>} />
        <TabBtn t="users" label={`Users (${userTotal})`}
          icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>} />
        <TabBtn t="audit" label={`Audit Logs (${logTotal})`}
          icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>} />
        <TabBtn t="datasources" label={`Data Sources (${dataSources.length})`}
          icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/></svg>} />
      </div>

      {/* ── OVERVIEW ─────────────────────────────────────────── */}
      {tab === 'overview' && stats && (
        <div className="space-y-6 animate-fade-in">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <StatCard label="Total Users"   value={stats.total_users}        color="border-teal-100" />
            <StatCard label="Active Users"  value={stats.active_users}       color="border-emerald-100"
                      sub={`${stats.total_users - stats.active_users} inactive`} />
            <StatCard label="Admins"        value={stats.admin_count}        color="border-teal-100" />
            <StatCard label="Total Queries" value={stats.total_queries}      color="border-teal-100" />
            <StatCard label="Successful"    value={stats.successful_queries} color="border-emerald-100" />
            <StatCard label="Failed"        value={stats.failed_queries}     color="border-red-100" />
          </div>
          {stats.total_queries > 0 && (
            <div className="bg-white rounded-2xl border border-teal-100 shadow-teal p-5 space-y-4">
              <h2 className="font-heading font-bold text-teal-800">Query Success Rate</h2>
              {[
                { label: 'Successful', val: stats.successful_queries, color: 'bg-teal-500' },
                { label: 'Failed',     val: stats.failed_queries,     color: 'bg-red-400' },
              ].map(item => (
                <div key={item.label}>
                  <div className="flex justify-between text-xs font-semibold text-teal-600 mb-1">
                    <span>{item.label}</span>
                    <span>{item.val} ({((item.val / stats.total_queries) * 100).toFixed(1)}%)</span>
                  </div>
                  <div className="h-2.5 bg-teal-50 rounded-full overflow-hidden border border-teal-100">
                    <div className={`h-full rounded-full ${item.color} transition-all duration-700`}
                         style={{ width: `${(item.val / stats.total_queries) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── USERS ───────────────────────────────────────────── */}
      {tab === 'users' && (
        <div className="bg-white rounded-2xl border border-teal-100 shadow-teal overflow-hidden animate-fade-in">
          <div className="px-5 py-3.5 border-b border-teal-50">
            <h2 className="font-heading font-bold text-teal-800">
              All Users <span className="ml-2 text-sm font-normal text-teal-400">({userTotal})</span>
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-teal-50/60">
                  {['Name','Email','Role','Status','Verified','Joined','Actions'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-[11px] font-bold uppercase
                                           tracking-wider text-teal-500 border-b border-teal-100
                                           whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id} className="border-b border-teal-50 hover:bg-teal-50/40 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-teal-400 to-teal-600
                                        flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                          {u.name.charAt(0).toUpperCase()}
                        </div>
                        <span className="font-medium text-teal-800">{u.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-teal-600 font-mono text-xs">{u.email}</td>
                    <td className="px-4 py-3"><Badge label={u.role} variant={u.role==='admin'?'teal':'green'}/></td>
                    <td className="px-4 py-3"><Badge label={u.is_active?'Active':'Inactive'} variant={u.is_active?'green':'red'}/></td>
                    <td className="px-4 py-3"><Badge label={u.email_verified?'Verified':'Pending'} variant={u.email_verified?'green':'amber'}/></td>
                    <td className="px-4 py-3 text-teal-400 text-xs whitespace-nowrap">{timeAgo(u.created_at)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <button onClick={() => toggleActive(u)}
                          className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-colors
                                      ${u.is_active
                                        ? 'bg-red-50 text-red-600 border-red-200 hover:bg-red-100'
                                        : 'bg-emerald-50 text-emerald-600 border-emerald-200 hover:bg-emerald-100'}`}>
                          {u.is_active ? 'Deactivate' : 'Activate'}
                        </button>
                        <button onClick={() => toggleRole(u)}
                          className="px-2.5 py-1 rounded-lg text-xs font-semibold border
                                     bg-teal-50 text-teal-600 border-teal-200 hover:bg-teal-100 transition-colors">
                          {u.role==='admin' ? 'Make User' : 'Make Admin'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {users.length===0 && !loading && (
            <p className="text-center text-teal-400 py-10 text-sm">No users found.</p>
          )}
        </div>
      )}

      {/* ── AUDIT LOGS ──────────────────────────────────────── */}
      {tab === 'audit' && (
        <div className="space-y-4 animate-fade-in">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-teal-700">Filter:</span>
            {['','success','error'].map(f => (
              <button key={f} onClick={() => setLogFilter(f)}
                className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all
                            ${logFilter===f
                              ? 'bg-teal-600 text-white border-teal-600'
                              : 'bg-white text-teal-600 border-teal-200 hover:bg-teal-50'}`}>
                {f===''?'All':f.charAt(0).toUpperCase()+f.slice(1)}
              </button>
            ))}
          </div>
          <div className="bg-white rounded-2xl border border-teal-100 shadow-teal overflow-hidden">
            <div className="px-5 py-3.5 border-b border-teal-50">
              <h2 className="font-heading font-bold text-teal-800">
                Audit Logs <span className="ml-2 text-sm font-normal text-teal-400">({logTotal})</span>
              </h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-teal-50/60">
                    {['Question','Status','Rows','Time','When'].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-[11px] font-bold uppercase
                                             tracking-wider text-teal-500 border-b border-teal-100
                                             whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {logs.map(log => (
                    <tr key={log.id} className="border-b border-teal-50 hover:bg-teal-50/40 transition-colors">
                      <td className="px-4 py-3 max-w-xs">
                        <p className="text-teal-800 text-sm truncate">{log.question||'—'}</p>
                        {log.sql_used && <p className="text-[11px] font-mono text-teal-400 truncate mt-0.5">{log.sql_used}</p>}
                        {log.error_msg && <p className="text-[11px] text-red-400 truncate mt-0.5">{log.error_msg}</p>}
                      </td>
                      <td className="px-4 py-3"><Badge label={log.status} variant={log.status==='success'?'green':'red'}/></td>
                      <td className="px-4 py-3 text-teal-600 text-xs">{log.row_count??'—'}</td>
                      <td className="px-4 py-3 text-teal-400 text-xs whitespace-nowrap">{log.timing_ms?`${log.timing_ms}ms`:'—'}</td>
                      <td className="px-4 py-3 text-teal-400 text-xs whitespace-nowrap">{timeAgo(log.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {logs.length===0 && !loading && <p className="text-center text-teal-400 py-10 text-sm">No logs found.</p>}
          </div>
        </div>
      )}

      {/* ── DATA SOURCES ────────────────────────────────────── */}
      {tab === 'datasources' && (
        <div className="space-y-4 animate-fade-in">

          {/* Info banner */}
          <div className="bg-teal-50 border border-teal-200 rounded-2xl px-5 py-4">
            <h3 className="font-semibold text-teal-800 text-sm mb-1">How data source access works</h3>
            <p className="text-xs text-teal-600 leading-relaxed">
              When a user sends a query they can pick any <strong>active</strong> data source.
              To restrict access, <strong>deactivate</strong> sources you do not want available.
              Each user can query any active source — per-user restrictions require a backend change.
            </p>
          </div>

          <div className="bg-white rounded-2xl border border-teal-100 shadow-teal overflow-hidden">
            <div className="px-5 py-3.5 border-b border-teal-50 flex items-center justify-between">
              <h2 className="font-heading font-bold text-teal-800">
                Data Sources <span className="ml-2 text-sm font-normal text-teal-400">({dataSources.length})</span>
              </h2>
              <button onClick={() => setShowAddDS(true)}
                className="flex items-center gap-2 px-4 py-2 rounded-xl
                           bg-gradient-to-r from-teal-500 to-teal-600 text-white
                           text-sm font-semibold hover:from-teal-600 hover:to-teal-700
                           transition-all shadow-teal">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" strokeWidth="2">
                  <line x1="12" y1="5" x2="12" y2="19"/>
                  <line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
                Add Data Source
              </button>
            </div>

            {dataSources.length === 0 && !loading ? (
              <div className="text-center py-14 space-y-3">
                <div className="w-14 h-14 rounded-2xl bg-teal-50 border border-teal-100
                                flex items-center justify-center mx-auto">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none"
                       stroke="currentColor" strokeWidth="1.5" className="text-teal-300">
                    <ellipse cx="12" cy="5" rx="9" ry="3"/>
                    <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
                    <path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/>
                  </svg>
                </div>
                <p className="text-sm font-medium text-teal-600">No data sources yet.</p>
                <p className="text-xs text-teal-400">Click "Add Data Source" above to connect a database.</p>
                <button onClick={() => setShowAddDS(true)}
                  className="mx-auto flex items-center gap-2 px-4 py-2 rounded-xl
                             bg-teal-500 text-white text-sm font-semibold
                             hover:bg-teal-600 transition-colors">
                  Add your first data source
                </button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="bg-teal-50/60">
                      {['Name','Type','Host','Database','Status','Added','Actions'].map(h => (
                        <th key={h} className="px-4 py-3 text-left text-[11px] font-bold uppercase
                                               tracking-wider text-teal-500 border-b border-teal-100
                                               whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {dataSources.map(ds => (
                      <tr key={ds.id} className="border-b border-teal-50 hover:bg-teal-50/40 transition-colors">
                        <td className="px-4 py-3 font-semibold text-teal-800">{ds.name}</td>
                        <td className="px-4 py-3">
                          <span className="font-mono text-xs px-2 py-0.5 rounded-lg
                                           bg-teal-50 border border-teal-100 text-teal-600">
                            {ds.db_type}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-teal-500 text-xs font-mono">
                          {ds.host ? `${ds.host}:${ds.port}` : '—'}
                        </td>
                        <td className="px-4 py-3 text-teal-600 text-xs font-mono">{ds.database_name||'—'}</td>
                        <td className="px-4 py-3">
                          <Badge label={ds.is_active?'Active':'Inactive'} variant={ds.is_active?'green':'red'}/>
                        </td>
                        <td className="px-4 py-3 text-teal-400 text-xs whitespace-nowrap">{timeAgo(ds.created_at)}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            <button onClick={() => setEditDS(ds)}
                              className="px-2.5 py-1 rounded-lg text-xs font-semibold border
                                         bg-teal-50 text-teal-600 border-teal-200
                                         hover:bg-teal-100 transition-colors">
                              Edit
                            </button>
                            <button onClick={() => handleToggleActive(ds)}
                              className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-colors
                                          ${ds.is_active
                                            ? 'bg-amber-50 text-amber-600 border-amber-200 hover:bg-amber-100'
                                            : 'bg-emerald-50 text-emerald-600 border-emerald-200 hover:bg-emerald-100'}`}>
                              {ds.is_active ? 'Disable' : 'Enable'}
                            </button>
                            <button onClick={() => handleDeleteDS(ds)}
                              className="px-2.5 py-1 rounded-lg text-xs font-semibold border
                                         bg-red-50 text-red-600 border-red-200
                                         hover:bg-red-100 transition-colors">
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="w-8 h-8 border-2 border-teal-400 border-t-transparent
                          rounded-full animate-spin" />
        </div>
      )}
    </div>
  );
}

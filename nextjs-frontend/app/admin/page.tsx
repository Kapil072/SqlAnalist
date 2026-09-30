'use client';
import { useState, useEffect, useCallback } from 'react';
import {
  fetchAdminStats, fetchAdminUsers, updateAdminUser,
  fetchAuditLogs, fetchDataSources, deleteDataSource,
  AdminStats, AdminUser, AuditLog, DataSource, timeAgo,
} from '@/lib/api';

type Tab = 'overview' | 'users' | 'audit' | 'datasources';

// ── Stat card ─────────────────────────────────────────────────
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

// ── Badge ─────────────────────────────────────────────────────
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

// ── Main component ─────────────────────────────────────────────
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

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  }

  // ── Load data per tab ─────────────────────────────────────
  const loadTab = useCallback(async (t: Tab) => {
    setLoading(true);
    try {
      if (t === 'overview' || t === 'users') {
        const s = await fetchAdminStats();
        setStats(s);
      }
      if (t === 'users') {
        const u = await fetchAdminUsers(0, 100);
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

  // ── Toggle user active/role ───────────────────────────────
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

  async function handleDeleteDS(ds: DataSource) {
    if (!confirm(`Delete "${ds.name}"? This cannot be undone.`)) return;
    try {
      await deleteDataSource(ds.id);
      setDataSources(prev => prev.filter(d => d.id !== ds.id));
      showToast(`"${ds.name}" deleted`);
    } catch (err) { showToast((err as Error).message); }
  }

  // ── Tab button ────────────────────────────────────────────
  function TabBtn({ t, label, icon }: { t: Tab; label: string; icon: React.ReactNode }) {
    return (
      <button onClick={() => setTab(t)}
        className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold
                    transition-all duration-200 border
                    ${tab === t
                      ? 'bg-teal-600 text-white border-teal-600 shadow-teal'
                      : 'bg-white text-teal-600 border-teal-200 hover:bg-teal-50'}`}>
        {icon}
        {label}
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

      {/* Page header */}
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
        <TabBtn t="users" label={`Users${userTotal ? ` (${userTotal})` : ''}`}
          icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>} />
        <TabBtn t="audit" label={`Audit Logs${logTotal ? ` (${logTotal})` : ''}`}
          icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>} />
        <TabBtn t="datasources" label="Data Sources"
          icon={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/></svg>} />
      </div>

      {/* ── OVERVIEW ────────────────────────────────────────── */}
      {tab === 'overview' && stats && (
        <div className="space-y-6 animate-fade-in">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <StatCard label="Total Users"        value={stats.total_users}        color="border-teal-100" />
            <StatCard label="Active Users"       value={stats.active_users}       color="border-emerald-100"
                      sub={`${stats.total_users - stats.active_users} inactive`} />
            <StatCard label="Admins"             value={stats.admin_count}        color="border-teal-100" />
            <StatCard label="Total Queries"      value={stats.total_queries}      color="border-teal-100" />
            <StatCard label="Successful"         value={stats.successful_queries} color="border-emerald-100" />
            <StatCard label="Failed"             value={stats.failed_queries}     color="border-red-100" />
          </div>

          {/* Quick stats bars */}
          {stats.total_queries > 0 && (
            <div className="bg-white rounded-2xl border border-teal-100 shadow-teal p-5 space-y-4">
              <h2 className="font-heading font-bold text-teal-800">Query Success Rate</h2>
              <div className="space-y-3">
                {[
                  { label: 'Successful', val: stats.successful_queries, total: stats.total_queries, color: 'bg-teal-500' },
                  { label: 'Failed',     val: stats.failed_queries,     total: stats.total_queries, color: 'bg-red-400' },
                ].map(item => (
                  <div key={item.label}>
                    <div className="flex justify-between text-xs font-semibold text-teal-600 mb-1">
                      <span>{item.label}</span>
                      <span>{item.val} ({((item.val / item.total) * 100).toFixed(1)}%)</span>
                    </div>
                    <div className="h-2.5 bg-teal-50 rounded-full overflow-hidden border border-teal-100">
                      <div className={`h-full rounded-full ${item.color} transition-all duration-700`}
                           style={{ width: `${(item.val / item.total) * 100}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── USERS ─────────────────────────────────────────── */}
      {tab === 'users' && (
        <div className="bg-white rounded-2xl border border-teal-100 shadow-teal overflow-hidden animate-fade-in">
          <div className="px-5 py-3.5 border-b border-teal-50 flex items-center justify-between">
            <h2 className="font-heading font-bold text-teal-800">
              All Users
              <span className="ml-2 text-sm font-normal text-teal-400">({userTotal})</span>
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-teal-50/60">
                  {['Name', 'Email', 'Role', 'Status', 'Verified', 'Joined', 'Actions'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-[11px] font-bold
                                           uppercase tracking-wider text-teal-500
                                           border-b border-teal-100 whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id}
                      className="border-b border-teal-50 hover:bg-teal-50/40 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-teal-400
                                        to-teal-600 flex items-center justify-center
                                        text-white text-xs font-bold flex-shrink-0">
                          {u.name.charAt(0).toUpperCase()}
                        </div>
                        <span className="font-medium text-teal-800">{u.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-teal-600 font-mono text-xs">{u.email}</td>
                    <td className="px-4 py-3">
                      <Badge label={u.role} variant={u.role === 'admin' ? 'teal' : 'green'} />
                    </td>
                    <td className="px-4 py-3">
                      <Badge label={u.is_active ? 'Active' : 'Inactive'}
                             variant={u.is_active ? 'green' : 'red'} />
                    </td>
                    <td className="px-4 py-3">
                      <Badge label={u.email_verified ? 'Verified' : 'Pending'}
                             variant={u.email_verified ? 'green' : 'amber'} />
                    </td>
                    <td className="px-4 py-3 text-teal-400 text-xs whitespace-nowrap">
                      {timeAgo(u.created_at)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <button onClick={() => toggleActive(u)}
                          className={`px-2.5 py-1 rounded-lg text-xs font-semibold border
                                      transition-colors
                                      ${u.is_active
                                        ? 'bg-red-50 text-red-600 border-red-200 hover:bg-red-100'
                                        : 'bg-emerald-50 text-emerald-600 border-emerald-200 hover:bg-emerald-100'}`}>
                          {u.is_active ? 'Deactivate' : 'Activate'}
                        </button>
                        <button onClick={() => toggleRole(u)}
                          className="px-2.5 py-1 rounded-lg text-xs font-semibold border
                                     bg-teal-50 text-teal-600 border-teal-200
                                     hover:bg-teal-100 transition-colors">
                          {u.role === 'admin' ? 'Make User' : 'Make Admin'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {users.length === 0 && !loading && (
            <p className="text-center text-teal-400 py-10 text-sm">No users found.</p>
          )}
        </div>
      )}

      {/* ── AUDIT LOGS ────────────────────────────────────── */}
      {tab === 'audit' && (
        <div className="space-y-4 animate-fade-in">
          {/* Filter */}
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-teal-700">Filter by status:</span>
            {['', 'success', 'error'].map(f => (
              <button key={f}
                onClick={() => { setLogFilter(f); }}
                className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all
                            ${logFilter === f
                              ? 'bg-teal-600 text-white border-teal-600'
                              : 'bg-white text-teal-600 border-teal-200 hover:bg-teal-50'}`}>
                {f === '' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>

          <div className="bg-white rounded-2xl border border-teal-100 shadow-teal overflow-hidden">
            <div className="px-5 py-3.5 border-b border-teal-50">
              <h2 className="font-heading font-bold text-teal-800">
                Audit Logs
                <span className="ml-2 text-sm font-normal text-teal-400">({logTotal})</span>
              </h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-teal-50/60">
                    {['Question', 'Status', 'Rows', 'Time', 'When'].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-[11px] font-bold
                                             uppercase tracking-wider text-teal-500
                                             border-b border-teal-100 whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {logs.map(log => (
                    <tr key={log.id}
                        className="border-b border-teal-50 hover:bg-teal-50/40 transition-colors group">
                      <td className="px-4 py-3 max-w-xs">
                        <p className="text-teal-800 text-sm truncate">{log.question || '—'}</p>
                        {log.sql_used && (
                          <p className="text-[11px] font-mono text-teal-400 truncate mt-0.5">
                            {log.sql_used}
                          </p>
                        )}
                        {log.error_msg && (
                          <p className="text-[11px] text-red-400 truncate mt-0.5">{log.error_msg}</p>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <Badge
                          label={log.status}
                          variant={log.status === 'success' ? 'green' : 'red'}
                        />
                      </td>
                      <td className="px-4 py-3 text-teal-600 text-xs">{log.row_count ?? '—'}</td>
                      <td className="px-4 py-3 text-teal-400 text-xs whitespace-nowrap">
                        {log.timing_ms ? `${log.timing_ms}ms` : '—'}
                      </td>
                      <td className="px-4 py-3 text-teal-400 text-xs whitespace-nowrap">
                        {timeAgo(log.created_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {logs.length === 0 && !loading && (
              <p className="text-center text-teal-400 py-10 text-sm">No logs found.</p>
            )}
          </div>
        </div>
      )}

      {/* ── DATA SOURCES ──────────────────────────────────── */}
      {tab === 'datasources' && (
        <div className="space-y-4 animate-fade-in">
          <div className="bg-white rounded-2xl border border-teal-100 shadow-teal overflow-hidden">
            <div className="px-5 py-3.5 border-b border-teal-50 flex items-center justify-between">
              <h2 className="font-heading font-bold text-teal-800">
                Data Sources
                <span className="ml-2 text-sm font-normal text-teal-400">
                  ({dataSources.length})
                </span>
              </h2>
            </div>

            {dataSources.length === 0 && !loading ? (
              <div className="text-center py-12">
                <div className="w-12 h-12 rounded-xl bg-teal-50 border border-teal-100
                                flex items-center justify-center mx-auto mb-3">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
                       stroke="currentColor" strokeWidth="1.5" className="text-teal-300">
                    <ellipse cx="12" cy="5" rx="9" ry="3"/>
                    <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
                    <path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/>
                  </svg>
                </div>
                <p className="text-sm text-teal-400">No data sources configured.</p>
                <p className="text-xs text-teal-300 mt-1">
                  Use the API to add connections via <code className="font-mono">POST /data-sources</code>
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="bg-teal-50/60">
                      {['Name', 'Type', 'Host', 'Database', 'Status', 'Added', 'Actions'].map(h => (
                        <th key={h} className="px-4 py-3 text-left text-[11px] font-bold
                                               uppercase tracking-wider text-teal-500
                                               border-b border-teal-100 whitespace-nowrap">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {dataSources.map(ds => (
                      <tr key={ds.id}
                          className="border-b border-teal-50 hover:bg-teal-50/40 transition-colors">
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
                        <td className="px-4 py-3 text-teal-600 text-xs font-mono">
                          {ds.database_name || '—'}
                        </td>
                        <td className="px-4 py-3">
                          <Badge label={ds.is_active ? 'Active' : 'Inactive'}
                                 variant={ds.is_active ? 'green' : 'red'} />
                        </td>
                        <td className="px-4 py-3 text-teal-400 text-xs whitespace-nowrap">
                          {timeAgo(ds.created_at)}
                        </td>
                        <td className="px-4 py-3">
                          <button onClick={() => handleDeleteDS(ds)}
                            className="px-2.5 py-1 rounded-lg text-xs font-semibold border
                                       bg-red-50 text-red-600 border-red-200
                                       hover:bg-red-100 transition-colors">
                            Delete
                          </button>
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

      {/* Loading overlay */}
      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="w-8 h-8 border-2 border-teal-400 border-t-transparent
                          rounded-full animate-spin" />
        </div>
      )}
    </div>
  );
}

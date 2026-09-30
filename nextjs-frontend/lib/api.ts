// ─── API base ────────────────────────────────────────────────
export const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

// ─── Token helpers ───────────────────────────────────────────
export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('sqlanalyst_token');
}

export function getUser(): Record<string, string> | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem('sqlanalyst_user');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveSession(data: { access_token: string; user: Record<string, string> }) {
  localStorage.setItem('sqlanalyst_token', data.access_token);
  localStorage.setItem('sqlanalyst_user', JSON.stringify(data.user));
}

export function clearSession() {
  localStorage.removeItem('sqlanalyst_token');
  localStorage.removeItem('sqlanalyst_user');
  sessionStorage.removeItem('sqlanalyst_session_id');
}

export function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

// ─── Generic fetch with auth ─────────────────────────────────
export async function authFetch(path: string, opts: RequestInit = {}) {
  return fetch(API + path, {
    ...opts,
    headers: { ...authHeaders(), ...(opts.headers as Record<string, string> || {}) },
  });
}

// ─── Typed API calls ─────────────────────────────────────────
export async function apiPost<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    let msg = data.detail;
    if (Array.isArray(msg)) msg = msg.map((e: { msg?: string }) => e.msg || JSON.stringify(e)).join(', ');
    else if (typeof msg === 'object' && msg) msg = JSON.stringify(msg);
    const err = new Error(msg || 'Request failed') as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  return data as T;
}

// ─── Health ──────────────────────────────────────────────────
export interface HealthData {
  status: string;
  target_db?: { connected: boolean; version?: string };
}
export async function fetchHealth(): Promise<HealthData> {
  const res = await authFetch('/health');
  return res.json();
}

// ─── Schema ──────────────────────────────────────────────────
export interface Column { name: string; type: string; nullable?: boolean }
export interface TableInfo { name: string; row_count: number; columns: Column[] }
export interface SchemaData { tables: TableInfo[]; suggestions?: string[] }

export async function fetchSchema(): Promise<SchemaData> {
  const res = await authFetch('/api/schema');
  if (!res.ok) throw new Error('Failed to load schema');
  return res.json();
}

export async function refreshSchema(): Promise<void> {
  await authFetch('/api/schema/refresh', { method: 'POST' });
}

// ─── Chat history ────────────────────────────────────────────
export interface ChatMessage {
  id: string;
  question: string;
  sql_query?: string;
  explanation?: string;
  engine_used?: string;
  session_id?: string;
  created_at: string;
}

export async function fetchChatHistory(limit = 30): Promise<ChatMessage[]> {
  const res = await authFetch(`/chat/history?limit=${limit}`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.messages || [];
}

export async function saveChatMessage(payload: {
  question: string;
  sql_query?: string;
  explanation?: string;
  engine_used?: string;
  session_id?: string;
}): Promise<void> {
  await authFetch('/chat/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

// ─── Auth ────────────────────────────────────────────────────
export async function logout(): Promise<void> {
  await authFetch('/auth/logout', { method: 'POST' }).catch(() => {});
  clearSession();
}

// ─── Time helper ─────────────────────────────────────────────
export function timeAgo(dateStr: string): string {
  const secs = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

// ─── Admin ───────────────────────────────────────────────────
export interface AdminStats {
  total_users: number;
  active_users: number;
  admin_count: number;
  total_queries: number;
  successful_queries: number;
  failed_queries: number;
}

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: string;
  is_active: boolean;
  email_verified: boolean;
  created_at: string;
}

export interface AuditLog {
  id: number;
  user_id: string | null;
  question: string;
  sql_used: string;
  row_count: number;
  status: string;
  error_msg: string | null;
  timing_ms: number;
  created_at: string;
}

export async function fetchAdminStats(): Promise<AdminStats> {
  const res = await authFetch('/admin/stats');
  if (!res.ok) throw new Error('Failed to fetch stats');
  return res.json();
}

export async function fetchAdminUsers(skip = 0, limit = 50): Promise<{ total: number; users: AdminUser[] }> {
  const res = await authFetch(`/admin/users?skip=${skip}&limit=${limit}`);
  if (!res.ok) throw new Error('Failed to fetch users');
  return res.json();
}

export async function updateAdminUser(userId: string, body: { role?: string; is_active?: boolean }): Promise<AdminUser> {
  const res = await authFetch(`/admin/users/${userId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || 'Update failed');
  return data;
}

export async function fetchAuditLogs(skip = 0, limit = 50, status?: string): Promise<{ total: number; logs: AuditLog[] }> {
  const qs = new URLSearchParams({ skip: String(skip), limit: String(limit) });
  if (status) qs.set('status', status);
  const res = await authFetch(`/admin/audit-logs?${qs}`);
  if (!res.ok) throw new Error('Failed to fetch audit logs');
  return res.json();
}

// ─── Data Sources ─────────────────────────────────────────────
export interface DataSource {
  id: string;
  name: string;
  db_type: string;
  host?: string;
  port?: number;
  username?: string;
  database_name?: string;
  is_active: boolean;
  created_at: string;
}

export async function fetchDataSources(): Promise<{ total: number; data_sources: DataSource[] }> {
  const res = await authFetch('/data-sources');
  if (!res.ok) throw new Error('Failed to fetch data sources');
  return res.json();
}

export async function deleteDataSource(id: string): Promise<void> {
  await authFetch(`/data-sources/${id}`, { method: 'DELETE' });
}

// ─── File upload analysis ─────────────────────────────────────
export interface FileAnalysisResult {
  filename: string;
  rows: number;
  columns: string[];
  preview: Record<string, unknown>[];
  analysis: string;
}

export async function uploadFileForAnalysis(file: File): Promise<FileAnalysisResult> {
  const form = new FormData();
  form.append('file', file);
  const res = await authFetch('/api/analyze-file', {
    method: 'POST',
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || 'Upload failed');
  return data;
}

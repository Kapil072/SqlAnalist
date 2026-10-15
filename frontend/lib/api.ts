// ─── API base ────────────────────────────────────────────────
export const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

// ─── Token helpers ───────────────────────────────────────────
export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('sqlanalyst_token');
}

// Checks JWT expiry from the token payload — no external library needed
export function isTokenValid(): boolean {
  if (typeof window === 'undefined') return false;
  const t = localStorage.getItem('sqlanalyst_token');
  if (!t) return false;
  try {
    const payload = JSON.parse(atob(t.split('.')[1]));
    return Date.now() / 1000 < (payload.exp ?? 0) - 30; // 30s buffer
  } catch {
    return false;
  }
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
  // Notify same-tab listeners (e.g. Navbar) — `storage` event only fires in OTHER tabs
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('session-updated', { detail: data.user }));
  }
}

export function clearSession() {
  if (typeof window === 'undefined') return;
  localStorage.removeItem('sqlanalyst_token');
  localStorage.removeItem('sqlanalyst_user');
  sessionStorage.removeItem('sqlanalyst_session_id');
}

// ─── Silent token refresh ────────────────────────────────────
// Access tokens live 15 minutes. The backend also sets an httpOnly
// refresh-token cookie; POST /auth/refresh swaps it for a new access token.
// One refresh at a time — concurrent callers share the same promise.
let refreshInFlight: Promise<boolean> | null = null;

export function refreshAccessToken(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const res = await fetch(API + '/auth/refresh', {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) return false;
      const data = await res.json();
      if (!data?.access_token) return false;
      saveSession(data);
      return true;
    } catch {
      return false;
    } finally {
      // allow a new refresh on the next expiry
      setTimeout(() => {
        refreshInFlight = null;
      }, 0);
    }
  })();
  return refreshInFlight;
}

/** Make sure a non-expired access token is available (refreshing if needed). */
export async function ensureFreshToken(): Promise<boolean> {
  if (isTokenValid()) return true;
  return refreshAccessToken();
}

export function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

// ─── Error text from an API response ─────────────────────────
// FastAPI returns `detail` as a string, or as a list of validation errors
// (422) — turn either into a readable message.
export function errorText(body: unknown, fallback: string): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === 'string' && detail) return detail;
  if (Array.isArray(detail)) {
    const msgs = detail
      .map((e: { msg?: string; loc?: unknown[] }) => {
        const field = Array.isArray(e.loc) ? String(e.loc[e.loc.length - 1] ?? '') : '';
        const msg = (e.msg || '').replace(/^Value error, /, '');
        return field && field !== 'body' ? `${field}: ${msg}` : msg;
      })
      .filter(Boolean);
    if (msgs.length) return msgs.join(' · ');
  }
  return fallback;
}

// ─── Generic fetch with auth ─────────────────────────────────
// Accepts a path ("/api/schema") or a full URL. Refreshes the access token
// when it is about to expire, and retries once on a 401.
export async function authFetch(pathOrUrl: string, opts: RequestInit = {}) {
  const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : API + pathOrUrl;
  const doFetch = () =>
    fetch(url, {
      credentials: 'include',
      ...opts,
      headers: { ...authHeaders(), ...((opts.headers as Record<string, string>) || {}) },
    });

  if (getToken() && !isTokenValid()) await refreshAccessToken();
  let res = await doFetch();
  if (res.status === 401 && getToken()) {
    if (await refreshAccessToken()) {
      res = await doFetch();
    } else {
      clearSession();
    }
  }
  return res;
}

// ─── Typed API calls ─────────────────────────────────────────
export async function apiPost<T = unknown>(path: string, body: unknown): Promise<T> {
  // credentials: 'include' so the refresh-token cookie set by /auth/login,
  // /auth/verify-otp etc. is stored by the browser
  const res = await fetch(API + path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    let msg = data.detail;
    if (Array.isArray(msg))
      msg = msg.map((e: { msg?: string }) => e.msg || JSON.stringify(e)).join(', ');
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

// ─── Server auth settings ────────────────────────────────────
// email_enabled = false: the server sends no email (no sign-up codes,
// no password-reset links), so the UI hides those features.
export interface AuthConfig {
  email_enabled: boolean;
}
export async function fetchAuthConfig(): Promise<AuthConfig> {
  const res = await fetch(`${API}/auth/config`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ─── Schema ──────────────────────────────────────────────────
export interface Column {
  name: string;
  type: string;
  nullable?: boolean;
}
export interface ForeignKey {
  columns: string[];
  ref_table: string;
  ref_columns: string[];
}
export interface TableInfo {
  name: string;
  row_count: number | null;
  columns: Column[];
  primary_key?: string[];
  foreign_keys?: ForeignKey[];
}
export interface SchemaData {
  tables: TableInfo[];
  suggestions?: string[];
}

// ─── Database sources (chat can target any of them) ──────────
// "default" = the database in TARGET_DB_URL; other ids are data sources
// added by an admin in the Admin → Data Sources tab.
export const DEFAULT_SOURCE_ID = 'default';

export interface SourceInfo {
  id: string;
  name: string;
  db_type: string;
  is_default: boolean;
}

export async function fetchSources(): Promise<SourceInfo[]> {
  const res = await authFetch('/sources');
  if (!res.ok) throw new Error('Failed to load databases');
  const data = await res.json();
  return data.sources || [];
}

export async function fetchSourceSchema(sourceId: string): Promise<SchemaData> {
  const res = await authFetch(`/sources/${encodeURIComponent(sourceId)}/schema`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(errorText(err, 'Failed to load schema'));
  }
  return res.json();
}

export async function refreshSourceSchema(sourceId: string): Promise<SchemaData> {
  const res = await authFetch(`/sources/${encodeURIComponent(sourceId)}/refresh`, {
    method: 'POST',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(errorText(err, 'Schema refresh failed'));
  }
  return res.json();
}

const SOURCE_KEY = 'sqlanalyst_source';

export function getSavedSourceId(): string {
  if (typeof window === 'undefined') return DEFAULT_SOURCE_ID;
  try {
    return localStorage.getItem(SOURCE_KEY) || DEFAULT_SOURCE_ID;
  } catch {
    return DEFAULT_SOURCE_ID;
  }
}

export function saveSourceId(id: string) {
  try {
    localStorage.setItem(SOURCE_KEY, id);
  } catch {
    /* ignore */
  }
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
  // The server revokes all tokens for this user and clears the cookie
  await fetch(API + '/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
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
  avatar_url?: string;
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

export async function fetchAdminUsers(
  skip = 0,
  limit = 50,
): Promise<{ total: number; users: AdminUser[] }> {
  const res = await authFetch(`/admin/users?skip=${skip}&limit=${limit}`);
  if (!res.ok) throw new Error('Failed to fetch users');
  return res.json();
}

export async function updateAdminUser(
  userId: string,
  body: { role?: string; is_active?: boolean },
): Promise<AdminUser> {
  const res = await authFetch(`/admin/users/${userId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(errorText(data, 'Update failed'));
  return data;
}

export async function fetchAuditLogs(
  skip = 0,
  limit = 50,
  status?: string,
): Promise<{ total: number; logs: AuditLog[] }> {
  const qs = new URLSearchParams({ skip: String(skip), limit: String(limit) });
  if (status) qs.set('status', status);
  const res = await authFetch(`/admin/audit-logs?${qs}`);
  if (!res.ok) throw new Error('Failed to fetch audit logs');
  return res.json();
}

// ─── Data Sources ─────────────────────────────────────────────
export interface DataSource {
  id: string;
  user_id?: string;
  name: string;
  db_type: string;
  host?: string;
  port?: number;
  username?: string;
  database_name?: string;
  is_active: boolean;
  created_at: string;
}

export interface DataSourceCreate {
  name: string;
  db_type: string;
  host?: string;
  port?: number;
  username?: string;
  database_name?: string;
  password?: string;
}

export async function fetchDataSources(): Promise<{ total: number; data_sources: DataSource[] }> {
  const res = await authFetch('/data-sources');
  if (!res.ok) throw new Error('Failed to fetch data sources');
  return res.json();
}

export async function createDataSource(data: DataSourceCreate): Promise<DataSource> {
  const res = await authFetch('/data-sources', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(errorText(json, 'Failed to create data source'));
  return json;
}

export async function updateDataSource(
  id: string,
  data: Partial<DataSourceCreate & { is_active: boolean }>,
): Promise<DataSource> {
  const res = await authFetch(`/data-sources/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(errorText(json, 'Failed to update data source'));
  return json;
}

export async function testDataSourceConnection(
  data: DataSourceCreate,
): Promise<{ success: boolean; message: string; execution_time_ms?: number }> {
  const res = await authFetch('/data-sources/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(errorText(json, 'Test failed'));
  return json;
}

export async function deleteDataSource(id: string): Promise<void> {
  const res = await authFetch(`/data-sources/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(errorText(json, `Failed to delete data source (HTTP ${res.status})`));
  }
}

/* ============================================================
   SQLAnalyst — Admin Panel JS
   ============================================================ */

const API = 'http://localhost:8000';

/* ── Auth guard ────────────────────────────────────────────── */
function getToken() { return localStorage.getItem('sqlanalyst_token'); }
function getUser()  {
  try { return JSON.parse(localStorage.getItem('sqlanalyst_user')); }
  catch { return null; }
}

function authFetch(path, opts = {}) {
  return fetch(API + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + getToken(),
      ...(opts.headers || {}),
    },
  });
}

window.addEventListener('DOMContentLoaded', () => {
  const token = getToken();
  const user  = getUser();

  if (!token || !user) {
    window.location.href = '/auth.html';
    return;
  }
  if (user.role !== 'admin') {
    window.location.href = '/';
    return;
  }

  // Show admin info in sidebar
  document.getElementById('admin-name').textContent  = user.name;
  document.getElementById('admin-avatar').textContent = user.name.charAt(0).toUpperCase();

  // Load default section
  loadDashboard();
});

/* ── Section switching ─────────────────────────────────────── */
let currentSection = 'dashboard';

function switchSection(name) {
  document.querySelectorAll('.content-section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  document.getElementById('section-' + name).classList.add('active');
  const navEl = document.getElementById('nav-' + name);
  if (navEl) navEl.classList.add('active');

  const titles = { dashboard: 'Dashboard', users: 'User Management', logs: 'Audit Logs' };
  document.getElementById('topbar-title').textContent = titles[name] || name;
  currentSection = name;

  if (name === 'dashboard') loadDashboard();
  else if (name === 'users')     loadUsers();
  else if (name === 'logs')      loadLogs();
}

function refreshCurrentSection() { switchSection(currentSection); }

/* ── Toast ─────────────────────────────────────────────────── */
let _toastTimer;
function toast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast ' + type + ' show';
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.classList.remove('show'); }, 3000);
}

/* ── Last updated timestamp ────────────────────────────────── */
function stampUpdated() {
  const el = document.getElementById('last-updated');
  const now = new Date();
  el.textContent = 'Updated ' + now.toLocaleTimeString();
}

/* ── Dashboard ─────────────────────────────────────────────── */
async function loadDashboard() {
  try {
    const [statsRes, logsRes] = await Promise.all([
      authFetch('/admin/stats'),
      authFetch('/admin/audit-logs?limit=10'),
    ]);

    if (!statsRes.ok) { checkAuthError(statsRes); return; }
    const stats = await statsRes.json();

    document.getElementById('stat-total-users').textContent   = stats.total_users;
    document.getElementById('stat-active-users').textContent  = stats.active_users + ' active';
    document.getElementById('stat-admin-count').textContent   = stats.admin_count;
    document.getElementById('stat-total-queries').textContent = stats.total_queries;
    document.getElementById('stat-success-queries').textContent = stats.successful_queries + ' success';
    document.getElementById('stat-failed-queries').textContent = stats.failed_queries;

    if (logsRes.ok) {
      const logsData = await logsRes.json();
      renderRecentLogs(logsData.logs || []);
    }
    stampUpdated();
  } catch (err) {
    toast('Failed to load dashboard: ' + err.message, 'error');
  }
}

function renderRecentLogs(logs) {
  const container = document.getElementById('recent-logs-container');
  if (!logs.length) {
    container.innerHTML = '<p class="loading-row">No queries yet.</p>';
    return;
  }
  container.innerHTML = `
    <table class="data-table">
      <thead><tr><th>#</th><th>Question</th><th>Status</th><th>Rows</th><th>Time (ms)</th><th>Date</th></tr></thead>
      <tbody>
        ${logs.map(l => `
          <tr>
            <td class="mono">${l.id}</td>
            <td class="question-cell" title="${esc(l.question || '')}">${esc(l.question || '—')}</td>
            <td><span class="badge badge-${l.status}">${l.status}</span></td>
            <td>${l.row_count ?? '—'}</td>
            <td>${l.timing_ms ?? '—'}</td>
            <td>${fmtDate(l.created_at)}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

/* ── Users ─────────────────────────────────────────────────── */
async function loadUsers() {
  document.getElementById('users-tbody').innerHTML = '<tr><td colspan="7" class="loading-row">Loading…</td></tr>';
  try {
    const res = await authFetch('/admin/users?limit=100');
    if (!res.ok) { checkAuthError(res); return; }
    const data = await res.json();
    document.getElementById('users-total').textContent = data.total + ' users';
    renderUsers(data.users || []);
    stampUpdated();
  } catch (err) {
    toast('Failed to load users: ' + err.message, 'error');
  }
}

function renderUsers(users) {
  const tbody = document.getElementById('users-tbody');
  if (!users.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="loading-row">No users found.</td></tr>';
    return;
  }
  tbody.innerHTML = users.map(u => `
    <tr id="user-row-${u.id}">
      <td><strong>${esc(u.name)}</strong></td>
      <td style="color:#94a3b8;">${esc(u.email)}</td>
      <td><span class="badge badge-${u.role}">${u.role}</span></td>
      <td><span class="badge badge-${u.is_active ? 'active' : 'inactive'}">${u.is_active ? 'Active' : 'Inactive'}</span></td>
      <td><span class="badge badge-${u.email_verified ? 'verified' : 'pending'}">${u.email_verified ? 'Verified' : 'Pending'}</span></td>
      <td style="color:#64748b;font-size:0.8rem;">${fmtDate(u.created_at)}</td>
      <td>
        <div class="action-btns">
          <button class="act-btn act-btn-role"
            onclick="toggleRole('${u.id}', '${u.role}')">
            ${u.role === 'admin' ? 'Make User' : 'Make Admin'}
          </button>
          <button class="act-btn ${u.is_active ? 'act-btn-deactivate' : 'act-btn-toggle'}"
            onclick="toggleActive('${u.id}', ${u.is_active})">
            ${u.is_active ? 'Deactivate' : 'Activate'}
          </button>
        </div>
      </td>
    </tr>`).join('');
}

async function toggleRole(userId, currentRole) {
  const newRole = currentRole === 'admin' ? 'user' : 'admin';
  try {
    const res = await authFetch('/admin/users/' + userId, {
      method: 'PATCH',
      body: JSON.stringify({ role: newRole }),
    });
    if (!res.ok) { const d = await res.json(); throw new Error(d.detail); }
    toast('Role updated to ' + newRole, 'success');
    loadUsers();
  } catch (err) { toast('Error: ' + err.message, 'error'); }
}

async function toggleActive(userId, currentActive) {
  try {
    const res = await authFetch('/admin/users/' + userId, {
      method: 'PATCH',
      body: JSON.stringify({ is_active: !currentActive }),
    });
    if (!res.ok) { const d = await res.json(); throw new Error(d.detail); }
    toast((!currentActive ? 'Activated' : 'Deactivated') + ' user', 'success');
    loadUsers();
  } catch (err) { toast('Error: ' + err.message, 'error'); }
}

/* ── Audit Logs ────────────────────────────────────────────── */
async function loadLogs() {
  document.getElementById('logs-tbody').innerHTML = '<tr><td colspan="6" class="loading-row">Loading…</td></tr>';
  const status = document.getElementById('log-status-filter').value;
  const qs = status ? '?status=' + encodeURIComponent(status) + '&limit=100' : '?limit=100';
  try {
    const res = await authFetch('/admin/audit-logs' + qs);
    if (!res.ok) { checkAuthError(res); return; }
    const data = await res.json();
    document.getElementById('logs-total').textContent = data.total + ' entries';
    renderLogs(data.logs || []);
    stampUpdated();
  } catch (err) {
    toast('Failed to load logs: ' + err.message, 'error');
  }
}

function renderLogs(logs) {
  const tbody = document.getElementById('logs-tbody');
  if (!logs.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="loading-row">No logs found.</td></tr>';
    return;
  }
  tbody.innerHTML = logs.map(l => `
    <tr>
      <td class="mono">${l.id}</td>
      <td class="question-cell" title="${esc(l.question || '')}">${esc(l.question || '—')}</td>
      <td><span class="badge badge-${l.status}">${l.status}</span></td>
      <td>${l.row_count ?? '—'}</td>
      <td>${l.timing_ms ?? '—'}</td>
      <td style="color:#64748b;font-size:0.8rem;">${fmtDate(l.created_at)}</td>
    </tr>`).join('');
}

/* ── Logout ────────────────────────────────────────────────── */
async function handleLogout() {
  try {
    await authFetch('/auth/logout', { method: 'POST' });
  } finally {
    localStorage.removeItem('sqlanalyst_token');
    localStorage.removeItem('sqlanalyst_user');
    window.location.href = '/auth.html';
  }
}

/* ── Helpers ───────────────────────────────────────────────── */
function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  } catch { return iso; }
}

function checkAuthError(res) {
  if (res.status === 401 || res.status === 403) {
    toast('Session expired. Redirecting…', 'error');
    setTimeout(() => { window.location.href = '/auth.html'; }, 1500);
  }
}
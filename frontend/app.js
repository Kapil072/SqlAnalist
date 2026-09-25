/* ============================================================
   SQLAnalyst — Main App JS
   Teal theme · Streaming SSE · In-memory RAG · DB chat history
   ============================================================ */

const API = 'http://localhost:8000';
let activeTab = 'chat';
let chartInstances = {};
let chatSessionId = sessionStorage.getItem('sqlanalyst_session_id') || null;

/* ── Auth helpers ─────────────────────────────────────────── */
function getToken() { return localStorage.getItem('sqlanalyst_token'); }
function getUser()  {
  try { return JSON.parse(localStorage.getItem('sqlanalyst_user')); }
  catch { return null; }
}
function authHeaders() {
  const t = getToken();
  return t ? { 'Authorization': 'Bearer ' + t } : {};
}
function authFetch(url, opts = {}) {
  return fetch(url, { ...opts, headers: { ...authHeaders(), ...(opts.headers || {}) } });
}

/* ── Boot ─────────────────────────────────────────────────── */
function initAuth() {
  const token = getToken();
  const user  = getUser();
  if (!token || !user) { window.location.href = '/auth.html'; return false; }

  const nameEl   = document.getElementById('nav-user-name');
  const roleEl   = document.getElementById('nav-user-role');
  const adminBtn = document.getElementById('nav-admin-link');
  const avatarEl = document.getElementById('nav-user-avatar');
  if (nameEl)   nameEl.textContent  = user.name;
  if (roleEl)   roleEl.textContent  = user.role;
  if (avatarEl) avatarEl.textContent = user.name.charAt(0).toUpperCase();
  if (adminBtn) adminBtn.style.display = user.role === 'admin' ? '' : 'none';
  return true;
}

document.addEventListener('DOMContentLoaded', () => {
  if (!initAuth()) return;
  loadSchema();
  checkHealth();
  loadChatHistory();

  const sqlEditor = document.getElementById('sql-editor');
  if (sqlEditor) {
    sqlEditor.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault(); executeCustomSql();
      }
    });
  }
});

/* ── User dropdown ────────────────────────────────────────── */
function toggleUserDropdown() {
  document.getElementById('user-dropdown')?.classList.toggle('open');
}
document.addEventListener('click', e => {
  const menu = document.getElementById('user-menu');
  if (menu && !menu.contains(e.target)) {
    document.getElementById('user-dropdown')?.classList.remove('open');
  }
});

function handleLogout() {
  fetch(API + '/auth/logout', { method: 'POST', headers: authHeaders() }).finally(() => {
    localStorage.removeItem('sqlanalyst_token');
    localStorage.removeItem('sqlanalyst_user');
    window.location.href = '/auth.html';
  });
}

/* ── Health check ─────────────────────────────────────────── */
async function checkHealth() {
  try {
    const res  = await authFetch(API + '/health');
    const data = await res.json();
    const pill = document.getElementById('db-status-pill');
    const text = document.getElementById('db-status-text');
    if (data.status === 'healthy' && data.target_db?.connected) {
      pill.style.background  = 'var(--teal-lightest)';
      pill.style.borderColor = 'var(--border-subtle)';
      pill.style.color       = 'var(--teal-dark)';
      text.textContent = `MySQL ${data.target_db.version?.split('-')[0] || '8.0'} · connected`;
    } else {
      pill.style.background  = '#fff1f2';
      pill.style.borderColor = '#fecdd3';
      pill.style.color       = '#b91c1c';
      text.textContent = 'DB disconnected';
    }
  } catch {}
}

/* ── Tab switching ────────────────────────────────────────── */
function switchTab(tab) {
  activeTab = tab;
  document.getElementById('tab-chat').classList.toggle('active', tab === 'chat');
  document.getElementById('tab-sql').classList.toggle('active', tab === 'sql');
  document.getElementById('view-chat').classList.toggle('active', tab === 'chat');
  document.getElementById('view-sql').classList.toggle('active', tab === 'sql');
}

/* ── Schema ───────────────────────────────────────────────── */
async function loadSchema() {
  const container   = document.getElementById('schema-list-container');
  const tableBadge  = document.getElementById('table-count-badge');
  const totalRecEl  = document.getElementById('total-records-count');
  const dbNameEl    = document.getElementById('meta-db-name');
  const consoleDbEl = document.getElementById('console-db-name');

  try {
    const res  = await authFetch(API + '/api/schema');
    const data = await res.json();

    if (!data.tables || data.tables.length === 0) {
      container.innerHTML = '<div class="empty-state">No tables found.</div>';
      return;
    }

    tableBadge.textContent = data.tables.length + ' Tables';
    let totalRows = 0;
    container.innerHTML = '';

    // Try to get DB name from first table's engine info or fall back to URL hint
    const dbName = 'analytics';
    if (dbNameEl)    dbNameEl.textContent   = dbName;
    if (consoleDbEl) consoleDbEl.textContent = dbName;

    data.tables.forEach(tbl => {
      totalRows += tbl.row_count || 0;

      const card = document.createElement('div');
      card.className = 'table-card';

      const colRows = (tbl.columns || []).map(c => `
        <div class="column-item">
          <span class="col-name">${c.name}</span>
          <span class="col-type">${(c.type || '').split('(')[0]}</span>
        </div>`).join('');

      card.innerHTML = `
        <div class="table-header" onclick="this.parentElement.classList.toggle('open')">
          <div class="table-name-group">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/></svg>
            ${tbl.name}
          </div>
          <span class="table-row-count">${(tbl.row_count || 0).toLocaleString()} rows</span>
        </div>
        <div class="table-columns-list">${colRows}</div>`;

      container.appendChild(card);
    });

    if (totalRecEl) totalRecEl.textContent = totalRows.toLocaleString();

  } catch (err) {
    container.innerHTML = '<div class="empty-state">Failed to load schema.</div>';
  }
}

async function refreshSchema() {
  const btn = document.getElementById('btn-refresh-schema') ||
              document.querySelector('[onclick="refreshSchema()"]');
  if (btn) btn.style.opacity = '0.5';
  try {
    await authFetch(API + '/api/schema/refresh', { method: 'POST' });
    await loadSchema();
  } finally {
    if (btn) btn.style.opacity = '1';
  }
}

/* ── Chat history (DB) ────────────────────────────────────── */
async function loadChatHistory() {
  try {
    const res  = await authFetch(API + '/chat/history?limit=30');
    if (!res.ok) return;
    const data = await res.json();
    renderHistorySidebar(data.messages || []);
  } catch {}
}

function renderHistorySidebar(messages) {
  const section = document.getElementById('history-section');
  const list    = document.getElementById('history-list');
  if (!section || !list) return;

  if (!messages.length) { section.style.display = 'none'; return; }

  section.style.display = '';
  list.innerHTML = messages.map(m => {
    const d   = new Date(m.created_at);
    const ago = _timeAgo(d);
    return `
      <div class="history-item" onclick="runSamplePrompt(${JSON.stringify(m.question)})" title="${escapeHtml(m.question)}">
        <div class="history-question">${escapeHtml(m.question)}</div>
        <div class="history-time">${ago}</div>
      </div>`;
  }).join('');
}

function _timeAgo(date) {
  const secs = Math.floor((Date.now() - date.getTime()) / 1000);
  if (secs < 60)   return 'just now';
  if (secs < 3600) return Math.floor(secs / 60) + 'm ago';
  if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
  return Math.floor(secs / 86400) + 'd ago';
}

async function saveMessageToDB(question, sqlQuery, explanation, engineUsed) {
  try {
    await authFetch(API + '/chat/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        sql_query:   sqlQuery   || null,
        explanation: explanation || null,
        engine_used: engineUsed  || null,
        session_id:  chatSessionId || null,
      }),
    });
  } catch {}
}

/* ── Clear chat ───────────────────────────────────────────── */
function clearChat() {
  document.getElementById('chat-messages').innerHTML = '';
  document.getElementById('welcome-hero').style.display = 'flex';
  chatSessionId = null;
  sessionStorage.removeItem('sqlanalyst_session_id');
}

/* ── Run a sample prompt ──────────────────────────────────── */
function runSamplePrompt(question) {
  switchTab('chat');
  document.getElementById('user-input').value = question;
  document.getElementById('chat-form').requestSubmit();
}

/* ══════════════════════════════════════════════════════════════
   Streaming question handler
   ══════════════════════════════════════════════════════════════ */
async function handleSendQuestion(e) {
  e.preventDefault();

  const input    = document.getElementById('user-input');
  const btn      = document.getElementById('btn-submit');
  const sendText = document.getElementById('send-btn-text');
  const question = input.value.trim();
  if (!question) return;

  document.getElementById('welcome-hero').style.display = 'none';
  appendUserMessage(question);
  input.value   = '';
  btn.disabled  = true;
  sendText.textContent = 'Thinking…';
  scrollToBottom();

  const { cardEl, chartId, setMeta, appendToken, setError, finalize } =
    createStreamingCard();
  document.getElementById('chat-messages').appendChild(cardEl);
  scrollToBottom();

  let finalData = {};

  try {
    const response = await fetch(API + '/ask/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        question,
        session_id: chatSessionId || undefined,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ detail: 'Stream failed' }));
      throw new Error(err.detail || 'Stream request failed');
    }

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop();

      for (const frame of frames) {
        if (!frame.trim()) continue;
        let eventName = 'message', dataStr = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataStr = line.slice(5).trim();
        }
        let payload;
        try { payload = JSON.parse(dataStr); } catch { payload = dataStr; }

        if (eventName === 'meta') {
          if (payload.session_id) {
            chatSessionId = payload.session_id;
            sessionStorage.setItem('sqlanalyst_session_id', chatSessionId);
          }
          finalData.meta = payload;
          setMeta(payload, chartId);
          scrollToBottom();

        } else if (eventName === 'token') {
          appendToken(payload.token || '');
          scrollToBottom();

        } else if (eventName === 'done') {
          finalData.explanation = payload.explanation || '';
          scrollToBottom();

        } else if (eventName === 'error') {
          setError((payload && payload.detail) || 'Unknown error');
          scrollToBottom();
        }
      }
    }

    // Remove "Thinking…" cursor after stream ends
    finalize();

    // Save to DB
    if (finalData.meta) {
      await saveMessageToDB(
        question,
        finalData.meta.sql_query,
        finalData.explanation,
        finalData.meta.engine_used,
      );
      // Refresh sidebar history
      loadChatHistory();
    }

  } catch (err) {
    setError(err.message);
    scrollToBottom();
  } finally {
    btn.disabled = false;
    sendText.textContent = 'Ask AI';
  }
}

/* ── Build a streaming assistant card ────────────────────── */
function createStreamingCard() {
  const cardId  = 'card-' + Date.now();
  const chartId = 'chart-' + Date.now();
  const expId   = 'exp-'   + Date.now();

  const div = document.createElement('div');
  div.className = 'message-assistant';
  div.id = cardId;

  div.innerHTML = `
    <div class="assistant-header">
      <div class="assistant-tag">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
        </svg>
        SQLAnalyst
      </div>
      <div class="assistant-metrics" id="metrics-${cardId}">
        <span class="metric-pill stream-thinking">Generating…</span>
      </div>
    </div>

    <div class="sql-box" id="sqlbox-${cardId}" style="display:none">
      <div class="sql-box-header">
        <span>SQL Query</span>
        <button class="copy-btn" onclick="copySql('${cardId}')">Copy</button>
      </div>
      <pre class="sql-code" id="code-${cardId}"></pre>
    </div>

    <p class="explanation-text" id="${expId}"></p>

    <div id="chartbox-${cardId}" style="display:none">
      <div class="chart-card">
        <div class="chart-title" id="charttitle-${cardId}"></div>
        <div class="chart-canvas-box"><canvas id="${chartId}"></canvas></div>
      </div>
    </div>

    <div id="tablebox-${cardId}" style="display:none" class="table-wrapper">
      <table class="data-table">
        <thead id="thead-${cardId}"></thead>
        <tbody id="tbody-${cardId}"></tbody>
      </table>
    </div>`;

  /* setMeta — called once on [event: meta] */
  function setMeta(data, cId) {
    // Metrics (no RAG pill)
    const metricsEl = document.getElementById('metrics-' + cardId);
    if (metricsEl) {
      metricsEl.innerHTML = `
        <span class="metric-pill">${data.timing_ms}ms</span>
        <span class="metric-pill">${data.row_count} rows</span>
        <span class="metric-pill success">Safe</span>`;
    }

    // SQL box
    const sqlBox = document.getElementById('sqlbox-' + cardId);
    const codeEl = document.getElementById('code-'   + cardId);
    if (sqlBox && codeEl) {
      codeEl.textContent = data.sql_query;
      sqlBox.style.display = '';
    }

    // Table
    if (data.columns?.length) {
      const thead = document.getElementById('thead-' + cardId);
      const tbody = document.getElementById('tbody-' + cardId);
      const tbox  = document.getElementById('tablebox-' + cardId);
      if (thead) thead.innerHTML =
        '<tr>' + data.columns.map(c => `<th>${escapeHtml(c)}</th>`).join('') + '</tr>';
      if (tbody) tbody.innerHTML = data.rows.slice(0, 15).map(row =>
        '<tr>' + row.map(val =>
          `<td>${val !== null && val !== undefined ? escapeHtml(String(val)) : '<span style="color:#7aacac">NULL</span>'}</td>`
        ).join('') + '</tr>'
      ).join('');
      if (tbox) tbox.style.display = '';
    }

    // Chart
    if (data.chart && data.columns?.length && data.rows?.length) {
      const chartbox   = document.getElementById('chartbox-'   + cardId);
      const chartTitle = document.getElementById('charttitle-' + cardId);
      if (chartTitle) chartTitle.textContent = data.chart.title || '';
      if (chartbox)   chartbox.style.display = '';
      renderChart(cId, data);
    }
  }

  /* appendToken — called for every [event: token] */
  function appendToken(chunk) {
    const expEl = document.getElementById(expId);
    if (expEl) expEl.appendChild(document.createTextNode(chunk));
  }

  /* finalize — called after stream ends to clean up any thinking state */
  function finalize() {
    const metricsEl = document.getElementById('metrics-' + cardId);
    if (metricsEl) {
      const thinking = metricsEl.querySelector('.stream-thinking');
      if (thinking) thinking.remove();
    }
  }

  /* setError */
  function setError(msg) {
    div.innerHTML = `
      <div style="color:#b91c1c;font-weight:600;display:flex;align-items:center;gap:8px;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        Query Error
      </div>
      <p style="color:#7f1d1d;font-size:0.88rem;margin-top:6px;background:#fff1f2;
                padding:10px 14px;border-radius:8px;border:1px solid #fecdd3;">
        ${escapeHtml(msg)}
      </p>`;
  }

  return { cardEl: div, chartId, setMeta, appendToken, setError, finalize };
}

/* ── User bubble ──────────────────────────────────────────── */
function appendUserMessage(text) {
  const div = document.createElement('div');
  div.className = 'message-user';
  div.innerHTML = `<div class="user-bubble">${escapeHtml(text)}</div>`;
  document.getElementById('chat-messages').appendChild(div);
}

/* ── Chart renderer ───────────────────────────────────────── */
function renderChart(canvasId, data) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const cfg = data.chart;
  const colNames = data.columns.map(c => c.toLowerCase());
  const xIdx = cfg.x_axis ? colNames.indexOf(cfg.x_axis.toLowerCase()) : 0;
  const yIdx = cfg.y_axis ? colNames.indexOf(cfg.y_axis.toLowerCase()) : (data.columns.length > 1 ? 1 : 0);
  const labels = data.rows.map(r => String(r[xIdx]));
  const values = data.rows.map(r => Number(r[yIdx]) || 0);

  const colors = [
    '#0E9999','#B1E5E6','#7DD3D4','#0B7A7A','#CCFBFA',
    '#085F5F','#34d399','#a7f3d0','#6ee7b7','#10b981'
  ];

  new Chart(canvas.getContext('2d'), {
    type: cfg.type === 'doughnut' ? 'doughnut' : 'bar',
    data: {
      labels,
      datasets: [{
        label: data.columns[yIdx] || 'Value',
        data: values,
        backgroundColor: cfg.type === 'doughnut'
          ? colors.slice(0, labels.length)
          : 'rgba(14,153,153,0.80)',
        borderColor: cfg.type === 'doughnut' ? '#ffffff' : '#0B7A7A',
        borderWidth: cfg.type === 'doughnut' ? 2 : 1.5,
        borderRadius: cfg.type === 'doughnut' ? 0 : 6,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: cfg.type === 'doughnut',
          labels: { color: '#1f4646', font: { family: 'Inter', size: 12 } }
        },
        tooltip: {
          backgroundColor: '#ffffff',
          titleColor: '#0a2929',
          bodyColor: '#4d8585',
          borderColor: '#cceced',
          borderWidth: 1,
          padding: 10,
        }
      },
      scales: cfg.type === 'doughnut' ? {} : {
        x: { ticks: { color: '#4d8585', font: { family: 'Inter', size: 11 } }, grid: { display: false } },
        y: { ticks: { color: '#4d8585', font: { family: 'Inter', size: 11 } }, grid: { color: 'rgba(177,229,230,0.5)' } }
      }
    }
  });
}

/* ── SQL Console ──────────────────────────────────────────── */
async function executeCustomSql() {
  const sql = document.getElementById('sql-editor').value.trim();
  const resultsContainer = document.getElementById('sql-console-results');
  if (!sql) return;

  resultsContainer.innerHTML = '<div class="loading-state">Executing…</div>';

  try {
    const res  = await authFetch(API + '/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Execution failed');

    resultsContainer.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <span style="color:var(--teal-base);font-size:0.87rem;font-weight:600;">
          ${data.row_count} rows · ${data.timing_ms || 0}ms
        </span>
        <span style="font-size:0.72rem;padding:2px 9px;border-radius:999px;
                     background:var(--teal-lightest);color:var(--teal-dark);
                     border:1px solid var(--border-subtle);font-weight:600;">Safe Query</span>
      </div>
      <div class="table-wrapper">
        <table class="data-table">
          <thead><tr>${data.columns.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
          <tbody>
            ${data.rows.map(row =>
              '<tr>' + row.map(val =>
                `<td>${val !== null && val !== undefined ? escapeHtml(String(val)) : '<span style="color:#7aacac">NULL</span>'}</td>`
              ).join('') + '</tr>'
            ).join('')}
          </tbody>
        </table>
      </div>`;
  } catch (err) {
    resultsContainer.innerHTML = `
      <div style="color:#b91c1c;padding:14px;border:1px solid #fecdd3;
                  border-radius:8px;background:#fff1f2;font-size:0.88rem;">
        <strong>Error:</strong> ${escapeHtml(err.message)}
      </div>`;
  }
}

/* ── Copy SQL ─────────────────────────────────────────────── */
function copySql(cardId) {
  const el = document.getElementById('code-' + cardId);
  if (!el) return;
  navigator.clipboard.writeText(el.textContent).then(() => {
    const btn = document.querySelector(`#${cardId} .copy-btn`);
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = '✓ Copied';
      setTimeout(() => btn.textContent = orig, 1600);
    }
  });
}

/* ── Scroll ───────────────────────────────────────────────── */
function scrollToBottom() {
  const el = document.getElementById('messages-scroll');
  if (el) setTimeout(() => el.scrollTop = el.scrollHeight, 40);
}

/* ── HTML escape ──────────────────────────────────────────── */
function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

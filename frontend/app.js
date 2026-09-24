// SQLAnalyst Client Logic
let activeTab = 'chat';
let chartInstances = {};

// Session ID persisted for the lifetime of the browser tab so RAG
// context accumulates across questions in the same conversation.
let chatSessionId = sessionStorage.getItem('sqlanalyst_session_id') || null;

/* ── Auth helpers ──────────────────────────────────────────── */
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

function initAuth() {
  const token = getToken();
  const user  = getUser();
  if (!token || !user) {
    window.location.href = '/auth.html';
    return false;
  }
  // Populate user nav
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

function handleLogout() {
  fetch('http://localhost:8000/auth/logout', { method: 'POST', headers: authHeaders() }).finally(() => {
    localStorage.removeItem('sqlanalyst_token');
    localStorage.removeItem('sqlanalyst_user');
    window.location.href = '/auth.html';
  });
}

document.addEventListener('DOMContentLoaded', () => {
  if (!initAuth()) return;
  loadSchema();
  checkHealth();

  // Ctrl+Enter shortcut in SQL editor
  const sqlEditor = document.getElementById('sql-editor');
  if (sqlEditor) {
    sqlEditor.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        executeCustomSql();
      }
    });
  }
});

// Toggle user dropdown menu
function toggleUserDropdown() {
  const dd = document.getElementById('user-dropdown');
  if (dd) dd.classList.toggle('open');
}
// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
  const menu = document.getElementById('user-menu');
  if (menu && !menu.contains(e.target)) {
    const dd = document.getElementById('user-dropdown');
    if (dd) dd.classList.remove('open');
  }
});

// Check API Health
async function checkHealth() {
  try {
    const res = await authFetch('http://localhost:8000/health');
    const data = await res.json();
    const pill = document.getElementById('db-status-pill');
    const text = document.getElementById('db-status-text');

    if (data.status === 'healthy' && data.target_db?.connected) {
      pill.style.borderColor = 'rgba(16, 185, 129, 0.35)';
      pill.style.background = '#ecfdf5';
      pill.style.color = '#065f46';
      text.textContent = `MySQL ${data.target_db.version || '8.0'} @ localhost:3306`;
    } else {
      pill.style.borderColor = 'rgba(244, 63, 94, 0.35)';
      pill.style.background = '#fff1f2';
      pill.style.color = '#9f1239';
      text.textContent = 'MySQL Disconnected';
    }
  } catch (err) {
    console.error('Health check error:', err);
  }
}

// Switch between AI Chat and Raw SQL Console
function switchTab(tab) {
  activeTab = tab;
  document.getElementById('tab-chat').classList.toggle('active', tab === 'chat');
  document.getElementById('tab-sql').classList.toggle('active', tab === 'sql');
  document.getElementById('view-chat').classList.toggle('active', tab === 'chat');
  document.getElementById('view-sql').classList.toggle('active', tab === 'sql');
}

// Fetch Live Database Schema and Suggestions
async function loadSchema() {
  const container = document.getElementById('schema-list-container');
  const chipsContainer = document.getElementById('suggestion-chips');
  const totalRecElem = document.getElementById('total-records-count');
  const tableBadge = document.getElementById('table-count-badge');

  try {
    const res = await authFetch('http://localhost:8000/api/schema');
    const data = await res.json();

    if (!data.tables || data.tables.length === 0) {
      container.innerHTML = '<div class="empty-state">No tables found.</div>';
      return;
    }

    tableBadge.textContent = `${data.tables.length} Tables`;
    let totalRecords = 0;
    container.innerHTML = '';

    data.tables.forEach((tbl) => {
      totalRecords += (tbl.row_count || 0);

      const card = document.createElement('div');
      card.className = 'table-card';
      card.innerHTML = `
        <div class="table-header" onclick="this.parentElement.classList.toggle('open')">
          <div class="table-name-group">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-blue-500"><path d="M4 6h16M4 12h16M4 18h16"></path></svg>
            <span>${tbl.name}</span>
          </div>
          <span class="table-row-count">${(tbl.row_count || 0).toLocaleString()} rows</span>
        </div>
        <div class="table-columns-list">
          ${tbl.columns.map(c => `
            <div class="column-item">
              <span class="col-name">${c.name}</span>
              <span class="col-type">${c.type.split('(')[0]}</span>
            </div>
          `).join('')}
        </div>
      `;
      container.appendChild(card);
    });

    totalRecElem.textContent = `${totalRecords.toLocaleString()} rows`;

    // Populate suggestions
    if (data.suggestions && chipsContainer) {
      chipsContainer.innerHTML = '';
      data.suggestions.forEach(s => {
        const btn = document.createElement('button');
        btn.className = 'chip-btn';
        btn.innerHTML = `<span class="flex items-center justify-between"><span>${s}</span><svg class="w-3.5 h-3.5 text-blue-500 ml-1.5 opacity-60 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path></svg></span>`;
        btn.onclick = () => runSamplePrompt(s);
        chipsContainer.appendChild(btn);
      });
    }

  } catch (err) {
    console.error('Error loading schema:', err);
    container.innerHTML = '<div class="empty-state">Failed to load schema.</div>';
  }
}

// Clear Chat Session
function clearChat() {
  document.getElementById('chat-messages').innerHTML = '';
  document.getElementById('welcome-hero').style.display = 'flex';
  // Reset in-memory RAG session so history is wiped on the server too
  chatSessionId = null;
  sessionStorage.removeItem('sqlanalyst_session_id');
}

// Run a prompt directly
function runSamplePrompt(question) {
  switchTab('chat');
  document.getElementById('user-input').value = question;
  document.getElementById('chat-form').requestSubmit();
}

// ─────────────────────────────────────────────────────────────────
// Streaming question handler  (replaces the old handleSendQuestion)
// ─────────────────────────────────────────────────────────────────
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
  sendText.textContent = 'Analyzing…';
  scrollToBottom();

  // Create the assistant card immediately (skeleton state)
  const { cardEl, chartId, setMeta, appendToken, setError } =
    createStreamingCard();
  document.getElementById('chat-messages').appendChild(cardEl);
  scrollToBottom();

  try {
    const token   = getToken();
    const headers = {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': 'Bearer ' + token } : {}),
    };

    const response = await fetch('http://localhost:8000/ask/stream', {
      method:  'POST',
      headers,
      body: JSON.stringify({
        question,
        session_id: chatSessionId || undefined,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ detail: 'Stream failed' }));
      throw new Error(err.detail || 'Stream request failed');
    }

    // ── Read the SSE stream ──────────────────────────────────────
    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by double newlines
      const frames = buffer.split('\n\n');
      buffer = frames.pop(); // keep incomplete last frame

      for (const frame of frames) {
        if (!frame.trim()) continue;

        // Parse "event: xxx\ndata: yyy"
        let eventName = 'message';
        let dataStr   = '';

        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dataStr = line.slice(5).trim();
          }
        }

        let payload;
        try { payload = JSON.parse(dataStr); }
        catch { payload = dataStr; }

        // ── Dispatch by event type ───────────────────────────────
        if (eventName === 'meta') {
          // Server confirmed session_id — store it for future turns
          if (payload.session_id) {
            chatSessionId = payload.session_id;
            sessionStorage.setItem('sqlanalyst_session_id', chatSessionId);
          }
          setMeta(payload, chartId);
          scrollToBottom();

        } else if (eventName === 'token') {
          appendToken(payload.token || '');
          scrollToBottom();

        } else if (eventName === 'done') {
          // Stream finished — nothing extra to do; card is already complete
          scrollToBottom();

        } else if (eventName === 'error') {
          setError((payload && payload.detail) || 'Unknown error');
          scrollToBottom();
        }
      }
    }

  } catch (err) {
    setError(err.message);
    scrollToBottom();
  } finally {
    btn.disabled = false;
    sendText.textContent = 'Ask AI';
  }
}

// ─────────────────────────────────────────────────────────────────
// Build a streaming assistant card
// Returns helpers to progressively fill the card.
// ─────────────────────────────────────────────────────────────────
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
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2.2">
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83
                   M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
        </svg>
        <span>SQLAnalyst Intelligence</span>
      </div>
      <div class="assistant-metrics" id="metrics-${cardId}">
        <span class="metric-pill stream-thinking">Thinking…</span>
      </div>
    </div>

    <!-- SQL block (hidden until meta arrives) -->
    <div class="sql-box" id="sqlbox-${cardId}" style="display:none">
      <div class="sql-box-header">
        <span>SQL Query</span>
        <button class="copy-btn" onclick="copySql('${cardId}')">Copy SQL</button>
      </div>
      <pre class="sql-code" id="code-${cardId}"></pre>
    </div>

    <!-- Explanation — tokens are appended here character-by-character -->
    <p class="explanation-text" id="${expId}"></p>

    <!-- Chart placeholder -->
    <div id="chartbox-${cardId}" style="display:none">
      <div class="chart-card">
        <div class="chart-title" id="charttitle-${cardId}"></div>
        <div class="chart-canvas-box">
          <canvas id="${chartId}"></canvas>
        </div>
      </div>
    </div>

    <!-- Data table placeholder -->
    <div id="tablebox-${cardId}" style="display:none" class="table-wrapper">
      <table class="data-table">
        <thead id="thead-${cardId}"></thead>
        <tbody id="tbody-${cardId}"></tbody>
      </table>
    </div>
  `;

  // ── setMeta: called once when [event: meta] arrives ─────────────
  function setMeta(data, cId) {
    // Metrics pill row
    const metricsEl = document.getElementById('metrics-' + cardId);
    if (metricsEl) {
      metricsEl.innerHTML = `
        <span class="metric-pill">${data.timing_ms}ms</span>
        <span class="metric-pill">${data.row_count} rows</span>
        <span class="metric-pill success">Safe Query</span>
        ${data.rag_turns_used > 0
          ? `<span class="metric-pill rag-pill" title="RAG context from ${data.rag_turns_used} past turn(s)">
               🧠 RAG ×${data.rag_turns_used}
             </span>`
          : ''}
      `;
    }

    // SQL box
    const sqlBox  = document.getElementById('sqlbox-' + cardId);
    const codeEl  = document.getElementById('code-'   + cardId);
    if (sqlBox && codeEl) {
      codeEl.textContent = data.sql_query;
      sqlBox.style.display = '';
    }

    // Data table
    if (data.columns && data.columns.length) {
      const thead = document.getElementById('thead-' + cardId);
      const tbody = document.getElementById('tbody-' + cardId);
      const tbox  = document.getElementById('tablebox-' + cardId);

      if (thead) {
        thead.innerHTML =
          '<tr>' + data.columns.map(c => `<th>${escapeHtml(c)}</th>`).join('') + '</tr>';
      }
      if (tbody) {
        tbody.innerHTML = data.rows.slice(0, 15).map(row =>
          '<tr>' + row.map(val =>
            `<td>${val !== null && val !== undefined
              ? escapeHtml(String(val))
              : '<span style="color:#94a3b8">NULL</span>'
            }</td>`
          ).join('') + '</tr>'
        ).join('');
      }
      if (tbox) tbox.style.display = '';
    }

    // Chart
    if (data.chart && data.columns && data.rows) {
      const chartbox   = document.getElementById('chartbox-'  + cardId);
      const chartTitle = document.getElementById('charttitle-' + cardId);
      if (chartTitle) chartTitle.textContent = data.chart.title || '';
      if (chartbox)   chartbox.style.display = '';
      renderChart(cId, data);
    }
  }

  // ── appendToken: called for every [event: token] chunk ──────────
  function appendToken(chunk) {
    const expEl = document.getElementById(expId);
    if (!expEl) return;
    expEl.appendChild(document.createTextNode(chunk));
  }

  // ── setError: replace card content with an error message ────────
  function setError(msg) {
    div.innerHTML = `
      <div style="color:#b91c1c;font-weight:600;display:flex;align-items:center;gap:8px;">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
        Query Error
      </div>
      <p style="color:#7f1d1d;font-size:0.9rem;margin-top:6px;
                background:#fff1f2;padding:10px 14px;border-radius:8px;
                border:1px solid #fecdd3;">${escapeHtml(msg)}</p>
    `;
  }

  return { cardEl: div, chartId, setMeta, appendToken, setError };
}

// Append User Bubble
function appendUserMessage(text) {
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'message-user';
  div.innerHTML = `<div class="user-bubble">${escapeHtml(text)}</div>`;
  container.appendChild(div);
}

// Append Assistant Result Card
function appendAssistantMessage(data) {
  const container = document.getElementById('chat-messages');
  const cardId = 'card-' + Date.now();
  const chartId = 'chart-' + Date.now();

  const div = document.createElement('div');
  div.className = 'message-assistant';
  div.id = cardId;

  // Build HTML
  div.innerHTML = `
    <div class="assistant-header">
      <div class="assistant-tag">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
        <span>SQLAnalyst Intelligence</span>
      </div>
      <div class="assistant-metrics">
        <span class="metric-pill">${data.timing_ms}ms</span>
        <span class="metric-pill">${data.row_count} rows</span>
        <span class="metric-pill success">Safe Query</span>
      </div>
    </div>

    <!-- SQL Block -->
    <div class="sql-box">
      <div class="sql-box-header">
        <span>MySQL Query</span>
        <button class="copy-btn" onclick="copySql('${cardId}')">Copy SQL</button>
      </div>
      <pre class="sql-code" id="code-${cardId}">${escapeHtml(data.sql_query)}</pre>
    </div>

    <!-- Explanation -->
    <p class="explanation-text">${escapeHtml(data.explanation)}</p>

    <!-- Chart if available -->
    ${data.chart ? `
      <div class="chart-card">
        <div class="chart-title">${escapeHtml(data.chart.title)}</div>
        <div class="chart-canvas-box">
          <canvas id="${chartId}"></canvas>
        </div>
      </div>
    ` : ''}

    <!-- Result Data Table -->
    <div class="table-wrapper">
      <table class="data-table">
        <thead>
          <tr>${data.columns.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${data.rows.slice(0, 15).map(row => `
            <tr>${row.map(val => `<td>${val !== null && val !== undefined ? escapeHtml(String(val)) : '<span style="color:#94a3b8">NULL</span>'}</td>`).join('')}</tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;

  container.appendChild(div);

  // Render chart if present
  if (data.chart) {
    renderChart(chartId, data);
  }
}

// Append Error Message
function appendErrorMessage(msg) {
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'message-assistant';
  div.innerHTML = `
    <div style="color:#b91c1c; font-weight:600; display:flex; align-items:center; gap:8px;">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
      Query Error
    </div>
    <p style="color:#7f1d1d; font-size:0.9rem; margin-top:6px; background:#fff1f2; padding:10px 14px; border-radius:8px; border:1px solid #fecdd3;">${escapeHtml(msg)}</p>
  `;
  container.appendChild(div);
}

// Chart.js Visualization Renderer (Clean Studio Slate Light Theme)
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
    '#2563eb', '#0ea5e9', '#10b981', '#f59e0b', '#8b5cf6',
    '#ec4899', '#3b82f6', '#14b8a6', '#f97316', '#a855f7'
  ];

  const ctx = canvas.getContext('2d');
  new Chart(ctx, {
    type: cfg.type === 'doughnut' ? 'doughnut' : 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: data.columns[yIdx] || 'Value',
        data: values,
        backgroundColor: cfg.type === 'doughnut' ? colors.slice(0, labels.length) : 'rgba(37, 99, 235, 0.85)',
        borderColor: cfg.type === 'doughnut' ? '#ffffff' : '#2563eb',
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
          labels: { color: '#475569', font: { family: 'Inter', size: 12 } }
        },
        tooltip: {
          backgroundColor: '#ffffff',
          titleColor: '#0f172a',
          bodyColor: '#475569',
          borderColor: '#e2e8f0',
          borderWidth: 1,
          padding: 10,
          boxShadow: '0 4px 12px rgba(15, 23, 42, 0.08)'
        }
      },
      scales: cfg.type === 'doughnut' ? {} : {
        x: {
          ticks: { color: '#64748b', font: { family: 'Inter', size: 11 } },
          grid: { display: false }
        },
        y: {
          ticks: { color: '#64748b', font: { family: 'Inter', size: 11 } },
          grid: { color: 'rgba(226, 232, 240, 0.8)' }
        }
      }
    }
  });
}

// Execute Raw SQL in Console Tab
async function executeCustomSql() {
  const sql = document.getElementById('sql-editor').value.trim();
  const resultsContainer = document.getElementById('sql-console-results');
  if (!sql) return;

  resultsContainer.innerHTML = '<div class="loading-state">Executing query on MySQL...</div>';

  try {
    const res = await authFetch('http://localhost:8000/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || 'Execution failed');
    }

    resultsContainer.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <span style="color:#2563eb; font-size:0.88rem; font-weight:600;">Returned ${data.row_count} rows in ${data.timing_ms || 0}ms</span>
        <span class="badge" style="background:#ecfdf5; color:#059669; border-color:#a7f3d0;">Safe Query Passed</span>
      </div>
      <div class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>${data.columns.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr>
          </thead>
          <tbody>
            ${data.rows.map(row => `
              <tr>${row.map(val => `<td>${val !== null && val !== undefined ? escapeHtml(String(val)) : '<span style="color:#94a3b8">NULL</span>'}</td>`).join('')}</tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    resultsContainer.innerHTML = `
      <div style="color:#b91c1c; padding:16px; border:1px solid #fecdd3; border-radius:8px; background:#fff1f2;">
        <strong>Execution Error:</strong> ${escapeHtml(err.message)}
      </div>
    `;
  }
}

// Copy SQL to Clipboard
function copySql(cardId) {
  const codeElem = document.getElementById('code-' + cardId);
  if (!codeElem) return;

  navigator.clipboard.writeText(codeElem.textContent).then(() => {
    const btn = document.querySelector(`#${cardId} .copy-btn`);
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = '✓ Copied!';
      setTimeout(() => btn.textContent = orig, 1800);
    }
  });
}

// Helper: Scroll Chat to Bottom
function scrollToBottom() {
  const scroll = document.getElementById('messages-scroll');
  if (scroll) {
    setTimeout(() => {
      scroll.scrollTop = scroll.scrollHeight;
    }, 50);
  }
}

// Helper: HTML Escaping
function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/* ============================================================
   SQLAnalyst — Auth Page JS
   ============================================================ */

const API = 'http://localhost:8000';

/* ── Token storage ─────────────────────────────────────────── */
function saveSession(data) {
  localStorage.setItem('sqlanalyst_token', data.access_token);
  localStorage.setItem('sqlanalyst_user', JSON.stringify(data.user));
}
function clearSession() {
  localStorage.removeItem('sqlanalyst_token');
  localStorage.removeItem('sqlanalyst_user');
}
function getToken() { return localStorage.getItem('sqlanalyst_token'); }
function getUser()  {
  try { return JSON.parse(localStorage.getItem('sqlanalyst_user')); }
  catch { return null; }
}

/* ── Check if already logged in (redirect away from auth page) */
window.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  const resetToken = params.get('reset_token');
  if (resetToken) {
    switchAuthTab('reset', resetToken);
    return;
  }
  if (getToken()) {
    window.location.href = '/';
  }
});

/* ── Tab switching ─────────────────────────────────────────── */
let _resetToken = null;

function switchAuthTab(tab, data) {
  const forms = document.querySelectorAll('.auth-form');
  const tabs  = document.querySelectorAll('.auth-tab');
  forms.forEach(f => { f.classList.remove('active'); f.style.display = 'none'; });
  tabs.forEach(t => t.classList.remove('active'));

  hideAlert();

  if (tab === 'login') {
    show('form-login'); setActive('tab-login');
    document.getElementById('auth-tabs').style.display = '';
  } else if (tab === 'register') {
    show('form-register'); setActive('tab-register');
    document.getElementById('auth-tabs').style.display = '';
  } else if (tab === 'forgot') {
    show('form-forgot');
    document.getElementById('auth-tabs').style.display = 'none';
  } else if (tab === 'reset') {
    _resetToken = data;
    show('form-reset');
    document.getElementById('auth-tabs').style.display = 'none';
  }
}

function show(id) {
  const el = document.getElementById(id);
  el.style.display = 'flex';
  el.classList.add('active');
}
function setActive(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

/* ── Alert helpers ─────────────────────────────────────────── */
function showAlert(msg, type = 'error') {
  const el = document.getElementById('auth-alert');
  el.textContent = msg;
  el.className = 'auth-alert ' + type;
  el.style.display = 'block';
}
function hideAlert() {
  const el = document.getElementById('auth-alert');
  el.style.display = 'none';
}

/* ── Button loading state ──────────────────────────────────── */
function setLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled = loading;
  btn.querySelector('.btn-text').style.display  = loading ? 'none'  : '';
  btn.querySelector('.btn-spinner').style.display = loading ? '' : 'none';
}

/* ── Password visibility toggle ────────────────────────────── */
function togglePw(inputId, btn) {
  const input = document.getElementById(inputId);
  input.type = input.type === 'password' ? 'text' : 'password';
}

/* ── Password strength meter ────────────────────────────────── */
document.addEventListener('input', e => {
  if (e.target.id !== 'reg-password') return;
  const v   = e.target.value;
  const bar = document.getElementById('pw-bar');
  const hint = document.getElementById('pw-hint');
  let score = 0;
  if (v.length >= 8) score++;
  if (/[A-Z]/.test(v)) score++;
  if (/\d/.test(v)) score++;
  if (/[^A-Za-z0-9]/.test(v)) score++;
  const colors = ['', '#ef4444', '#f59e0b', '#6366f1', '#10b981'];
  const labels = ['', 'Too weak', 'Could be stronger', 'Good password', 'Strong password'];
  bar.style.width  = (score / 4 * 100) + '%';
  bar.style.backgroundColor = colors[score] || 'transparent';
  hint.textContent = v ? (labels[score] || '') : '';
});

/* ── API helper ────────────────────────────────────────────── */
async function apiPost(path, body) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    let msg = data.detail;
    if (Array.isArray(msg)) {
      msg = msg.map(e => e.msg || JSON.stringify(e)).join(', ');
    } else if (typeof msg === 'object' && msg !== null) {
      msg = JSON.stringify(msg);
    }
    throw new Error(msg || 'Request failed');
  }
  return data;
}

/* ── Login ─────────────────────────────────────────────────── */
async function handleLogin(e) {
  e.preventDefault();
  hideAlert();
  setLoading('btn-login', true);
  try {
    const data = await apiPost('/auth/login', {
      email:    document.getElementById('login-email').value.trim(),
      password: document.getElementById('login-password').value,
    });
    saveSession(data);
    showAlert('Signed in! Redirecting…', 'success');
    setTimeout(() => { window.location.href = '/'; }, 600);
  } catch (err) {
    showAlert(err.message);
  } finally {
    setLoading('btn-login', false);
  }
}

/* ── Register ──────────────────────────────────────────────── */
async function handleRegister(e) {
  e.preventDefault();
  hideAlert();
  setLoading('btn-register', true);
  try {
    await apiPost('/auth/register', {
      name:     document.getElementById('reg-name').value.trim(),
      email:    document.getElementById('reg-email').value.trim(),
      password: document.getElementById('reg-password').value,
    });
    showAlert('Account created! Check the server console for your verification link (dev mode). Signing you in…', 'success');
    // Auto-login after registration
    setTimeout(async () => {
      try {
        const data = await apiPost('/auth/login', {
          email:    document.getElementById('reg-email').value.trim(),
          password: document.getElementById('reg-password').value,
        });
        saveSession(data);
        window.location.href = '/';
      } catch { switchAuthTab('login'); }
    }, 2000);
  } catch (err) {
    showAlert(err.message);
  } finally {
    setLoading('btn-register', false);
  }
}

/* ── Forgot password ────────────────────────────────────────── */
async function handleForgot(e) {
  e.preventDefault();
  hideAlert();
  setLoading('btn-forgot', true);
  try {
    const data = await apiPost('/auth/forgot-password', {
      email: document.getElementById('forgot-email').value.trim(),
    });
    showAlert(data.detail + ' (Check server logs in dev mode)', 'success');
  } catch (err) {
    showAlert(err.message);
  } finally {
    setLoading('btn-forgot', false);
  }
}

/* ── Reset password ─────────────────────────────────────────── */
async function handleReset(e) {
  e.preventDefault();
  hideAlert();
  setLoading('btn-reset', true);
  try {
    const data = await apiPost('/auth/reset-password', {
      token:        _resetToken,
      new_password: document.getElementById('reset-password').value,
    });
    showAlert(data.detail + ' Redirecting to sign in…', 'success');
    setTimeout(() => switchAuthTab('login'), 2000);
  } catch (err) {
    showAlert(err.message);
  } finally {
    setLoading('btn-reset', false);
  }
}
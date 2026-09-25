/* ============================================================
   SQLAnalyst — Auth Page JS  (with OTP email verification)
   ============================================================ */

const API = 'http://localhost:8000';

// Holds the email address during the OTP step
let _otpEmail  = null;
let _resetToken = null;

/* ── Token storage ─────────────────────────────────────────── */
function saveSession(data) {
  localStorage.setItem('sqlanalyst_token', data.access_token);
  localStorage.setItem('sqlanalyst_user', JSON.stringify(data.user));
}
function getToken() { return localStorage.getItem('sqlanalyst_token'); }
function getUser()  {
  try { return JSON.parse(localStorage.getItem('sqlanalyst_user')); }
  catch { return null; }
}

/* ── Redirect if already logged in ────────────────────────── */
window.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  const resetToken = params.get('reset_token');
  if (resetToken) { switchAuthTab('reset', resetToken); return; }
  if (getToken())  { window.location.href = '/'; return; }
  initOTPBoxes();
});

/* ── Tab switching ─────────────────────────────────────────── */
function switchAuthTab(tab, data) {
  document.querySelectorAll('.auth-form').forEach(f => {
    f.classList.remove('active');
    f.style.display = 'none';
  });
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));

  // Only hide alert when switching between login/register tabs
  // NOT when switching to otp/forgot/reset — those need to show messages
  if (tab === 'login' || tab === 'register') {
    hideAlert();
  }

  const tabBar = document.getElementById('auth-tabs');

  if (tab === 'login') {
    show('form-login');    setActive('tab-login');    tabBar.style.display = '';
  } else if (tab === 'register') {
    show('form-register'); setActive('tab-register'); tabBar.style.display = '';
  } else if (tab === 'otp') {
    show('form-otp');
    tabBar.style.display = 'none';
    const hint = document.getElementById('otp-hint-email');
    if (hint && _otpEmail) {
      hint.innerHTML = `We sent a 6-digit code to <strong>${_otpEmail}</strong>.<br>It expires in 10 minutes.`;
    }
    setTimeout(() => {
      const first = document.querySelector('.otp-digit');
      if (first) first.focus();
    }, 80);
  } else if (tab === 'forgot') {
    show('form-forgot');   tabBar.style.display = 'none';
  } else if (tab === 'reset') {
    _resetToken = data;
    show('form-reset');    tabBar.style.display = 'none';
  }
}

function show(id) {
  const el = document.getElementById(id);
  if (!el) return;
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
  el.innerHTML = msg;                       // innerHTML so emoji/bold work
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
  btn.querySelector('.btn-text').style.display    = loading ? 'none' : '';
  btn.querySelector('.btn-spinner').style.display = loading ? ''     : 'none';
}

/* ── Password visibility toggle ────────────────────────────── */
function togglePw(inputId) {
  const input = document.getElementById(inputId);
  input.type = input.type === 'password' ? 'text' : 'password';
}

/* ── Password strength meter ────────────────────────────────── */
document.addEventListener('input', e => {
  if (e.target.id !== 'reg-password') return;
  const v    = e.target.value;
  const bar  = document.getElementById('pw-bar');
  const hint = document.getElementById('pw-hint');
  let score  = 0;
  if (v.length >= 8)           score++;
  if (/[A-Z]/.test(v))         score++;
  if (/\d/.test(v))            score++;
  if (/[^A-Za-z0-9]/.test(v)) score++;
  const colors = ['', '#ef4444', '#f59e0b', '#6366f1', '#10b981'];
  const labels = ['', 'Too weak', 'Could be stronger', 'Good password', 'Strong password'];
  bar.style.width           = (score / 4 * 100) + '%';
  bar.style.backgroundColor = colors[score] || 'transparent';
  hint.textContent          = v ? (labels[score] || '') : '';
});

/* ── API helper ────────────────────────────────────────────── */
async function apiPost(path, body) {
  const res  = await fetch(API + path, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    let msg = data.detail;
    if (Array.isArray(msg))                  msg = msg.map(e => e.msg || JSON.stringify(e)).join(', ');
    else if (typeof msg === 'object' && msg) msg = JSON.stringify(msg);
    const err = new Error(msg || 'Request failed');
    err.status = res.status;
    err.data   = data;
    throw err;
  }
  return data;
}

/* ── Login ─────────────────────────────────────────────────── */
async function handleLogin(e) {
  e.preventDefault();
  hideAlert();
  setLoading('btn-login', true);
  const emailVal = document.getElementById('login-email').value.trim();
  try {
    const data = await apiPost('/auth/login', {
      email:    emailVal,
      password: document.getElementById('login-password').value,
    });
    saveSession(data);
    showAlert('Signed in! Redirecting…', 'success');
    setTimeout(() => { window.location.href = '/'; }, 600);
  } catch (err) {
    // 403 = account not verified → send a fresh OTP and go to OTP screen
    if (err.status === 403) {
      _otpEmail = emailVal;
      try {
        const r = await apiPost('/auth/send-otp', { email: emailVal });
        switchAuthTab('otp');
        if (r.dev_otp) {
          showAlert(
            `Your OTP code is: <strong style="font-size:1.3em;letter-spacing:6px;display:inline-block;margin-top:4px">${r.dev_otp}</strong><br><small style="opacity:0.8">Enter it in the boxes below.</small>`,
            'success'
          );
          _prefillOTP(r.dev_otp);
        } else {
          showAlert('Verification code sent to your email.', 'success');
        }
      } catch (_) {
        switchAuthTab('otp');
        showAlert('Enter the OTP sent to your email.', 'success');
      }
    } else {
      showAlert(err.message);
    }
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
    const email = document.getElementById('reg-email').value.trim();
    const data  = await apiPost('/auth/register', {
      name:     document.getElementById('reg-name').value.trim(),
      email,
      password: document.getElementById('reg-password').value,
    });

    _otpEmail = email;

    if (data.dev_otp) {
      // Email could not be sent — switch to OTP tab immediately and show code
      switchAuthTab('otp');
      // Show the code in the alert after tab switch
      showAlert(
        `Email could not be sent. Your OTP code is: <strong style="font-size:1.3em;letter-spacing:6px;display:inline-block;margin-top:4px">${data.dev_otp}</strong><br><small style="opacity:0.8">Copy this code and enter it in the boxes below.</small>`,
        'success'
      );
      _prefillOTP(data.dev_otp);
    } else {
      // Email sent — switch to OTP tab immediately
      switchAuthTab('otp');
      showAlert('OTP sent to your email. Enter it below.', 'success');
    }
  } catch (err) {
    showAlert(err.message);
  } finally {
    setLoading('btn-register', false);
  }
}

/* ── OTP helpers ────────────────────────────────────────────── */

// Pre-fill all 6 digit boxes (used when email fails and code shown on screen)
function _prefillOTP(code) {
  const boxes = Array.from(document.querySelectorAll('.otp-digit'));
  const digits = String(code).replace(/\D/g, '').slice(0, 6);
  boxes.forEach((b, i) => {
    b.value = digits[i] || '';
    b.classList.toggle('filled', !!b.value);
  });
}

function initOTPBoxes() {
  const boxes = Array.from(document.querySelectorAll('.otp-digit'));
  boxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      box.value = box.value.replace(/\D/g, '').slice(-1);
      box.classList.toggle('filled', box.value !== '');
      if (box.value && i < boxes.length - 1) boxes[i + 1].focus();
      if (boxes.every(b => b.value)) {
        document.getElementById('form-otp').requestSubmit();
      }
    });

    box.addEventListener('keydown', ev => {
      if (ev.key === 'Backspace') {
        if (box.value) {
          box.value = '';
          box.classList.remove('filled');
        } else if (i > 0) {
          boxes[i - 1].focus();
          boxes[i - 1].value = '';
          boxes[i - 1].classList.remove('filled');
        }
        ev.preventDefault();
      }
    });

    box.addEventListener('paste', ev => {
      ev.preventDefault();
      const text = (ev.clipboardData || window.clipboardData)
        .getData('text').replace(/\D/g, '').slice(0, 6);
      boxes.forEach((b, j) => {
        b.value = text[j] || '';
        b.classList.toggle('filled', !!b.value);
      });
      const next = boxes[Math.min(text.length, boxes.length - 1)];
      next.focus();
      if (text.length === 6) document.getElementById('form-otp').requestSubmit();
    });
  });
}

function getOTPValue() {
  return Array.from(document.querySelectorAll('.otp-digit')).map(b => b.value).join('');
}

function clearOTPBoxes(shake = false) {
  document.querySelectorAll('.otp-digit').forEach(b => {
    b.value = '';
    b.classList.remove('filled');
    if (shake) {
      b.classList.add('error');
      setTimeout(() => b.classList.remove('error'), 400);
    }
  });
  if (!shake) {
    const first = document.querySelector('.otp-digit');
    if (first) first.focus();
  }
}

/* ── Verify OTP ─────────────────────────────────────────────── */
async function handleVerifyOTP(e) {
  e.preventDefault();
  hideAlert();
  const code = getOTPValue();
  if (code.length !== 6) { showAlert('Enter all 6 digits.'); return; }

  setLoading('btn-otp', true);
  try {
    const data = await apiPost('/auth/verify-otp', { email: _otpEmail, code });
    saveSession(data);
    showAlert('Email verified! Signing you in…', 'success');
    setTimeout(() => { window.location.href = '/'; }, 800);
  } catch (err) {
    clearOTPBoxes(true);
    showAlert(err.message);
  } finally {
    setLoading('btn-otp', false);
  }
}

/* ── Resend OTP ─────────────────────────────────────────────── */
async function handleResendOTP() {
  if (!_otpEmail) return;
  hideAlert();
  try {
    const r = await apiPost('/auth/send-otp', { email: _otpEmail });
    clearOTPBoxes();
    if (r.dev_otp) {
      showAlert(
        `📬 Email failed. New code: <strong style="font-size:1.2em;letter-spacing:4px">${r.dev_otp}</strong>`,
        'success'
      );
      _prefillOTP(r.dev_otp);
    } else {
      showAlert('New code sent! Check your inbox.', 'success');
    }
  } catch (err) {
    showAlert(err.message);
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
    showAlert(data.detail, 'success');
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

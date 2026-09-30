'use client';
import {
  useState, useRef, useEffect,
  KeyboardEvent, ClipboardEvent,
} from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { apiPost, saveSession, getToken } from '@/lib/api';

type Tab = 'login' | 'register' | 'otp' | 'forgot';
interface Alert { msg: string; type: 'error' | 'success' | 'info' }

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? '';

// ── Google One-Tap / popup script loader ─────────────────────
declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (cfg: Record<string, unknown>) => void;
          renderButton: (el: HTMLElement, cfg: Record<string, unknown>) => void;
          prompt: () => void;
        };
      };
    };
  }
}

export default function AuthPage() {
  const router = useRouter();
  const [mounted,    setMounted]    = useState(false);
  const [tab,        setTab]        = useState<Tab>('login');
  const [alert,      setAlert]      = useState<Alert | null>(null);
  const [loading,    setLoading]    = useState(false);
  const [gLoading,   setGLoading]   = useState(false);
  const [otpEmail,   setOtpEmail]   = useState('');
  const [otpDigits,  setOtpDigits]  = useState(['','','','','','']);
  const [pw,         setPw]         = useState('');
  const [showPw,     setShowPw]     = useState(false);
  const [showPwReg,  setShowPwReg]  = useState(false);

  const otpRefs     = useRef<Array<HTMLInputElement | null>>([]);
  const googleBtnRef = useRef<HTMLDivElement>(null);

  // Password strength
  const pwScore = (() => {
    let s = 0;
    if (pw.length >= 8)           s++;
    if (/[A-Z]/.test(pw))         s++;
    if (/\d/.test(pw))            s++;
    if (/[^A-Za-z0-9]/.test(pw)) s++;
    return s;
  })();
  const pwBars   = ['', 'bg-red-400', 'bg-amber-400', 'bg-teal-400', 'bg-emerald-500'];
  const pwLabels = ['', 'Too weak', 'Could be stronger', 'Good password', 'Strong password'];

  // ── Mount guard — prevents SSR/hydration mismatch ──────────
  useEffect(() => {
    setMounted(true);
    if (getToken()) router.replace('/dashboard');
  }, [router]);

  // ── Load Google Identity Services script ───────────────────
  useEffect(() => {
    if (!mounted || !GOOGLE_CLIENT_ID ||
        GOOGLE_CLIENT_ID.includes('your-google')) return;

    const script = document.createElement('script');
    script.src   = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => initGoogle();
    document.head.appendChild(script);
    return () => { document.head.removeChild(script); };
  }, [mounted]); // eslint-disable-line react-hooks/exhaustive-deps

  function initGoogle() {
    if (!window.google || !GOOGLE_CLIENT_ID) return;
    window.google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback:  handleGoogleCredential,
      ux_mode:   'popup',
    });
    if (googleBtnRef.current) {
      window.google.accounts.id.renderButton(googleBtnRef.current, {
        theme: 'outline',
        size:  'large',
        text:  'continue_with',
        shape: 'rectangular',
        width: '100%',
      });
    }
  }

  // Re-render Google button when tab changes back to login/register
  useEffect(() => {
    if ((tab === 'login' || tab === 'register') &&
        window.google && googleBtnRef.current) {
      setTimeout(() => {
        if (googleBtnRef.current && window.google) {
          window.google!.accounts.id.renderButton(googleBtnRef.current, {
            theme: 'outline', size: 'large',
            text: 'continue_with', shape: 'rectangular', width: '100%',
          });
        }
      }, 50);
    }
  }, [tab]);

  // ── Google credential callback ─────────────────────────────
  async function handleGoogleCredential(response: { credential: string }) {
    setGLoading(true);
    try {
      const data = await apiPost<{ access_token: string; user: Record<string,string> }>(
        '/auth/google',
        { credential: response.credential }
      );
      saveSession(data);
      showAlert('Signed in with Google! Redirecting…', 'success');
      setTimeout(() => router.push('/dashboard'), 600);
    } catch (err: unknown) {
      showAlert((err as Error).message);
    } finally {
      setGLoading(false);
    }
  }

  // ── Helpers ────────────────────────────────────────────────
  const showAlert = (msg: string, type: Alert['type'] = 'error') =>
    setAlert({ msg, type });
  const hideAlert = () => setAlert(null);

  function switchTab(t: Tab) {
    if (t === 'login' || t === 'register') hideAlert();
    setTab(t);
    if (t === 'otp') setTimeout(() => otpRefs.current[0]?.focus(), 80);
  }

  // ── OTP boxes ──────────────────────────────────────────────
  function handleOtpInput(i: number, val: string) {
    const v = val.replace(/\D/g,'').slice(-1);
    const next = [...otpDigits];
    next[i] = v;
    setOtpDigits(next);
    if (v && i < 5) otpRefs.current[i+1]?.focus();
    if (next.every(d => d)) submitOTP(next.join(''));
  }

  function handleOtpKey(i: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace') {
      e.preventDefault();
      const next = [...otpDigits];
      if (next[i]) { next[i]=''; setOtpDigits(next); }
      else if (i > 0) {
        next[i-1]=''; setOtpDigits(next);
        otpRefs.current[i-1]?.focus();
      }
    }
  }

  function handleOtpPaste(e: ClipboardEvent<HTMLInputElement>) {
    e.preventDefault();
    const text = e.clipboardData.getData('text').replace(/\D/g,'').slice(0,6);
    const next = Array(6).fill('');
    text.split('').forEach((c,i) => { next[i]=c; });
    setOtpDigits(next);
    otpRefs.current[Math.min(text.length,5)]?.focus();
    if (text.length===6) submitOTP(text);
  }

  function prefillOTP(code: string) {
    const digits = String(code).replace(/\D/g,'').slice(0,6).split('');
    const next   = Array(6).fill('');
    digits.forEach((d,i) => { next[i]=d; });
    setOtpDigits(next);
  }

  // ── Auth handlers ──────────────────────────────────────────
  async function handleLogin(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); hideAlert(); setLoading(true);
    const fd = new FormData(e.currentTarget);
    try {
      const data = await apiPost<{ access_token: string; user: Record<string,string> }>(
        '/auth/login',
        { email: fd.get('email'), password: fd.get('password') }
      );
      saveSession(data);
      showAlert('Signed in! Redirecting…','success');
      setTimeout(() => router.push('/dashboard'), 600);
    } catch (err: unknown) {
      const error = err as Error & { status?: number };
      if (error.status === 403) {
        setOtpEmail(String(fd.get('email')||''));
        try {
          const r = await apiPost<{ dev_otp?: string }>(
            '/auth/send-otp', { email: fd.get('email') }
          );
          switchTab('otp');
          if (r.dev_otp) { showAlert(`Your OTP: ${r.dev_otp}`, 'success'); prefillOTP(r.dev_otp); }
          else showAlert('Verification code sent to your email.','success');
        } catch { switchTab('otp'); }
      } else { showAlert(error.message); }
    } finally { setLoading(false); }
  }

  async function handleRegister(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); hideAlert(); setLoading(true);
    const fd    = new FormData(e.currentTarget);
    const email = String(fd.get('email')||'');
    try {
      const data = await apiPost<{ dev_otp?: string }>(
        '/auth/register',
        { name: fd.get('name'), email, password: fd.get('password') }
      );
      setOtpEmail(email); switchTab('otp');
      if (data.dev_otp) {
        showAlert(`OTP (email failed): ${data.dev_otp}`, 'success');
        prefillOTP(data.dev_otp);
      } else { showAlert('OTP sent to your email. Enter it below.','success'); }
    } catch (err: unknown) { showAlert((err as Error).message); }
    finally { setLoading(false); }
  }

  async function submitOTP(code: string) {
    if (code.length !== 6) return;
    hideAlert(); setLoading(true);
    try {
      const data = await apiPost<{ access_token: string; user: Record<string,string> }>(
        '/auth/verify-otp', { email: otpEmail, code }
      );
      saveSession(data);
      showAlert('Verified! Signing you in…','success');
      setTimeout(() => router.push('/dashboard'), 700);
    } catch (err: unknown) {
      showAlert((err as Error).message);
      setOtpDigits(['','','','','','']);
      otpRefs.current[0]?.focus();
    } finally { setLoading(false); }
  }

  async function handleResend() {
    if (!otpEmail) return;
    try {
      const r = await apiPost<{ dev_otp?: string }>('/auth/send-otp', { email: otpEmail });
      setOtpDigits(['','','','','','']);
      if (r.dev_otp) { showAlert(`New code: ${r.dev_otp}`,'success'); prefillOTP(r.dev_otp); }
      else showAlert('New code sent! Check your inbox.','success');
    } catch (err: unknown) { showAlert((err as Error).message); }
  }

  async function handleForgot(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setLoading(true);
    const fd = new FormData(e.currentTarget);
    try {
      const data = await apiPost<{ detail: string }>(
        '/auth/forgot-password', { email: fd.get('email') }
      );
      showAlert(data.detail,'success');
    } catch (err: unknown) { showAlert((err as Error).message); }
    finally { setLoading(false); }
  }

  // ── Shared input class ─────────────────────────────────────
  const inputCls = `w-full px-4 py-2.5 rounded-xl border border-teal-200 bg-white/60
                    text-teal-900 placeholder-teal-300 text-sm outline-none
                    focus:border-teal-500 focus:ring-2 focus:ring-teal-200/60
                    transition-all duration-200`;

  const btnCls = `w-full py-2.5 rounded-xl font-semibold text-sm
                  bg-gradient-to-r from-teal-500 to-teal-600 text-white
                  shadow-teal hover:from-teal-600 hover:to-teal-700
                  disabled:opacity-50 disabled:cursor-not-allowed
                  transition-all duration-200 hover:-translate-y-0.5 active:translate-y-0`;

  const alertCls = alert?.type === 'success'
    ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
    : alert?.type === 'info'
    ? 'bg-blue-50 border-blue-200 text-blue-700'
    : 'bg-red-50 border-red-200 text-red-700';

  const googleConfigured = GOOGLE_CLIENT_ID &&
    !GOOGLE_CLIENT_ID.includes('your-google');

  // Prevent SSR render
  if (!mounted) return null;

  return (
    <div className="min-h-screen flex items-center justify-center p-4
                    bg-gradient-to-br from-teal-50 via-teal-100 to-cyan-100">

      {/* Decorative blobs */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden -z-10">
        <div className="absolute -top-32 -left-32 w-96 h-96 bg-teal-200/40
                        rounded-full blur-3xl" />
        <div className="absolute -bottom-32 -right-32 w-96 h-96 bg-cyan-200/30
                        rounded-full blur-3xl" />
      </div>

      <div className="w-full max-w-[420px] flex flex-col items-center gap-5">

        {/* Brand */}
        <div className="flex items-center gap-3 select-none">
          <Image src="/logo.png" alt="SQLAnalyst" width={44} height={44}
                 className="rounded-xl object-contain shadow-teal" />
          <div className="flex flex-col leading-none">
            <span className="font-heading text-2xl font-extrabold text-teal-800
                             tracking-tight">
              SQLAnalyst
            </span>
            <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-teal-400 mt-0.5">
              AI Data Intelligence
            </span>
          </div>
        </div>

        {/* Card */}
        <div className="w-full bg-white/75 backdrop-blur-xl rounded-2xl
                        border border-white/80 shadow-[0_8px_32px_rgba(14,153,153,0.12)]
                        p-7 space-y-5">

          {/* Tab bar — only on login/register */}
          {(tab === 'login' || tab === 'register') && (
            <div className="flex bg-teal-50/80 rounded-xl p-1 gap-1 border border-teal-100">
              {(['login','register'] as const).map(t => (
                <button key={t} onClick={() => switchTab(t)}
                  className={`flex-1 py-2 rounded-lg text-sm font-semibold
                              transition-all duration-200
                              ${tab === t
                                ? 'bg-white text-teal-800 shadow-sm border border-teal-200/80'
                                : 'text-teal-500 hover:text-teal-700'}`}>
                  {t === 'login' ? 'Sign In' : 'Register'}
                </button>
              ))}
            </div>
          )}

          {/* Alert */}
          {alert && (
            <div className={`px-4 py-3 rounded-xl border text-sm leading-snug
                             animate-fade-in ${alertCls}`}>
              {alert.msg}
            </div>
          )}

          {/* ════ LOGIN ════ */}
          {tab === 'login' && (
            <div className="space-y-4">
              <form onSubmit={handleLogin} className="space-y-4">
                <Field label="Email">
                  <input name="email" type="text" required autoComplete="username"
                    placeholder="admin@sqlanalyst.com"
                    className={inputCls} />
                </Field>

                <Field label="Password">
                  <div className="relative">
                    <input name="password" type={showPw ? 'text' : 'password'}
                      required autoComplete="current-password"
                      placeholder="Enter your password"
                      className={inputCls + ' pr-10'} />
                    <button type="button"
                      onClick={() => setShowPw(v => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2
                                 text-teal-400 hover:text-teal-600 transition-colors">
                      <EyeIcon open={showPw} />
                    </button>
                  </div>
                </Field>

                <div className="flex justify-end">
                  <button type="button" onClick={() => switchTab('forgot')}
                    className="text-xs text-teal-500 hover:text-teal-700
                               hover:underline transition-colors">
                    Forgot password?
                  </button>
                </div>

                <button type="submit" disabled={loading} className={btnCls}>
                  {loading
                    ? <Spinner /> : 'Sign In'
                  }
                </button>
              </form>

              {/* Divider + Google */}
              {googleConfigured && (
                <>
                  <Divider />
                  <div ref={googleBtnRef} className="w-full" />
                  {gLoading && (
                    <p className="text-center text-xs text-teal-500">
                      Signing in with Google…
                    </p>
                  )}
                </>
              )}

              <p className="text-center text-sm text-teal-600">
                No account?{' '}
                <button onClick={() => switchTab('register')}
                  className="font-semibold text-teal-700 hover:underline">
                  Create one free
                </button>
              </p>
            </div>
          )}

          {/* ════ REGISTER ════ */}
          {tab === 'register' && (
            <div className="space-y-4">
              <form onSubmit={handleRegister} className="space-y-4">
                <Field label="Full name">
                  <input name="name" type="text" required autoComplete="name"
                    placeholder="Jane Smith" className={inputCls} />
                </Field>

                <Field label="Email address">
                  <input name="email" type="email" required autoComplete="email"
                    placeholder="you@example.com" className={inputCls} />
                </Field>

                <Field label="Password">
                  <div className="relative">
                    <input name="password" type={showPwReg ? 'text' : 'password'}
                      required autoComplete="new-password"
                      placeholder="Min 8 chars, 1 uppercase, 1 number"
                      value={pw} onChange={e => setPw(e.target.value)}
                      className={inputCls + ' pr-10'} />
                    <button type="button"
                      onClick={() => setShowPwReg(v => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2
                                 text-teal-400 hover:text-teal-600 transition-colors">
                      <EyeIcon open={showPwReg} />
                    </button>
                  </div>
                  {pw && (
                    <div className="mt-1.5 space-y-1">
                      <div className="flex gap-1">
                        {[1,2,3,4].map(n => (
                          <div key={n}
                            className={`h-1 flex-1 rounded-full transition-all duration-300
                                        ${pwScore >= n ? pwBars[pwScore] : 'bg-teal-100'}`} />
                        ))}
                      </div>
                      <p className="text-xs text-teal-500">{pwLabels[pwScore]}</p>
                    </div>
                  )}
                </Field>

                <button type="submit" disabled={loading} className={btnCls}>
                  {loading ? <Spinner /> : 'Create Account'}
                </button>
              </form>

              {googleConfigured && (
                <>
                  <Divider />
                  <div ref={googleBtnRef} className="w-full" />
                </>
              )}

              <p className="text-center text-sm text-teal-600">
                Already have an account?{' '}
                <button onClick={() => switchTab('login')}
                  className="font-semibold text-teal-700 hover:underline">
                  Sign in
                </button>
              </p>
            </div>
          )}

          {/* ════ OTP ════ */}
          {tab === 'otp' && (
            <div className="flex flex-col items-center gap-4">
              {/* Icon */}
              <div className="w-16 h-16 rounded-2xl bg-teal-50 border border-teal-200
                              flex items-center justify-center shadow-sm">
                <svg width="30" height="30" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" strokeWidth="1.8" className="text-teal-500">
                  <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1
                           0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
                  <polyline points="22,6 12,13 2,6"/>
                </svg>
              </div>

              <div className="text-center space-y-1">
                <h2 className="font-heading text-lg font-bold text-teal-800">
                  Check your email
                </h2>
                <p className="text-sm text-teal-600 leading-snug">
                  We sent a 6-digit code to{' '}
                  <span className="font-semibold text-teal-700 break-all">
                    {otpEmail}
                  </span>
                  <br />
                  <span className="text-xs text-teal-400">Expires in 10 minutes</span>
                </p>
              </div>

              {/* 6 digit boxes */}
              <div className="flex gap-2.5">
                {otpDigits.map((d, i) => (
                  <input key={i}
                    ref={el => { otpRefs.current[i] = el; }}
                    type="text" inputMode="numeric" maxLength={1}
                    value={d}
                    onChange={e => handleOtpInput(i, e.target.value)}
                    onKeyDown={e => handleOtpKey(i, e)}
                    onPaste={i === 0 ? handleOtpPaste : undefined}
                    className={`w-11 h-13 text-center text-xl font-bold rounded-xl
                                border-2 bg-teal-50/80 text-teal-800 outline-none
                                caret-transparent transition-all duration-150
                                ${d
                                  ? 'border-teal-500 bg-teal-100 shadow-sm'
                                  : 'border-teal-200 focus:border-teal-500 focus:ring-2 focus:ring-teal-200/60'}`}
                    style={{ height: '52px' }}
                  />
                ))}
              </div>

              <button
                disabled={loading || otpDigits.join('').length !== 6}
                onClick={() => submitOTP(otpDigits.join(''))}
                className={btnCls}>
                {loading ? <Spinner /> : 'Verify & Sign In'}
              </button>

              <p className="text-sm text-teal-600">
                Did not receive it?{' '}
                <button onClick={handleResend}
                  className="font-semibold text-teal-700 hover:underline">
                  Resend code
                </button>
              </p>

              <button onClick={() => switchTab('register')}
                className="flex items-center gap-1.5 text-sm text-teal-400
                           hover:text-teal-600 transition-colors">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" strokeWidth="2">
                  <polyline points="15 18 9 12 15 6"/>
                </svg>
                Back
              </button>
            </div>
          )}

          {/* ════ FORGOT PASSWORD ════ */}
          {tab === 'forgot' && (
            <div className="space-y-4">
              <div className="text-center space-y-1">
                <h2 className="font-heading text-lg font-bold text-teal-800">
                  Reset your password
                </h2>
                <p className="text-sm text-teal-500">
                  Enter your email and we will send a reset link.
                </p>
              </div>

              <form onSubmit={handleForgot} className="space-y-4">
                <input name="email" type="email" required
                  placeholder="you@example.com" className={inputCls} />
                <button type="submit" disabled={loading} className={btnCls}>
                  {loading ? <Spinner /> : 'Send Reset Link'}
                </button>
              </form>

              <button onClick={() => switchTab('login')}
                className="flex items-center gap-1.5 text-sm text-teal-400
                           hover:text-teal-600 transition-colors mx-auto">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" strokeWidth="2">
                  <polyline points="15 18 9 12 15 6"/>
                </svg>
                Back to sign in
              </button>
            </div>
          )}
        </div>

        <p className="text-xs text-teal-400">
          &copy; 2026 SQLAnalyst &mdash; AI-Powered Data Intelligence
        </p>
      </div>
    </div>
  );
}

// ── Small reusable sub-components ─────────────────────────────
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-[11px] font-bold uppercase tracking-wider text-teal-600">
        {label}
      </label>
      {children}
    </div>
  );
}

function Divider() {
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 h-px bg-teal-100" />
      <span className="text-xs text-teal-400 font-medium">or continue with</span>
      <div className="flex-1 h-px bg-teal-100" />
    </div>
  );
}

function Spinner() {
  return (
    <span className="flex items-center justify-center gap-2">
      <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="10" stroke="currentColor"
                strokeWidth="3" strokeOpacity="0.25"/>
        <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3"
              strokeLinecap="round"/>
      </svg>
      Please wait…
    </span>
  );
}

function EyeIcon({ open }: { open: boolean }) {
  return open ? (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="2">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45
               0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5
               18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
      <line x1="1" y1="1" x2="23" y2="23"/>
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="2">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  );
}

'use client';
import { useState, useRef, useEffect, KeyboardEvent, ClipboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { apiPost, saveSession, getToken, fetchAuthConfig } from '@/lib/api';
import { AnimatePresence, motion, spring, ease } from '@/components/motion';

type Tab = 'login' | 'register' | 'otp' | 'forgot' | 'reset';
interface Alert {
  msg: string;
  type: 'error' | 'success' | 'info';
}

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? '';
// Show "Continue with Google" only when a real client ID is configured
const GOOGLE_ENABLED = !!GOOGLE_CLIENT_ID && !GOOGLE_CLIENT_ID.includes('your-google');

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
  const [mounted, setMounted] = useState(false);
  const [tab, setTab] = useState<Tab>('login');
  const [alert, setAlert] = useState<Alert | null>(null);
  const [loading, setLoading] = useState(false);
  const [gLoading, setGLoading] = useState(false);
  const [otpEmail, setOtpEmail] = useState('');
  const [otpDigits, setOtpDigits] = useState(['', '', '', '', '', '']);
  const [pw, setPw] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [showPwReg, setShowPwReg] = useState(false);
  const [resetToken, setResetToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showResetPw, setShowResetPw] = useState(false);
  const [devResetUrl, setDevResetUrl] = useState('');
  // Hidden until the server confirms it can send email
  const [emailEnabled, setEmailEnabled] = useState(false);

  const otpRefs = useRef<Array<HTMLInputElement | null>>([]);
  const googleBtnRef = useRef<HTMLDivElement>(null);

  // Password strength
  const pwScore = (() => {
    let s = 0;
    if (pw.length >= 8) s++;
    if (/[A-Z]/.test(pw)) s++;
    if (/\d/.test(pw)) s++;
    if (/[^A-Za-z0-9]/.test(pw)) s++;
    return s;
  })();
  const pwBars = ['', 'bg-red-400', 'bg-amber-400', 'bg-teal-400', 'bg-emerald-500'];
  const pwLabels = ['', 'Too weak', 'Could be stronger', 'Good password', 'Strong password'];

  // ── Mount guard — prevents SSR/hydration mismatch ──────────
  useEffect(() => {
    setMounted(true);
    if (getToken()) {
      router.replace('/dashboard');
      return;
    }
    // Check URL query parameters for password reset token or OAuth errors
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const token = params.get('reset_token') || params.get('token');
      if (token) {
        setResetToken(token);
        setTab('reset');
      }
      const err = params.get('error');
      if (err === 'google_not_configured') {
        showAlert(
          'Google sign-in is not available yet. Please sign in with your email and password.',
          'info',
        );
      } else if (err === 'google_denied') {
        showAlert('Google sign-in was cancelled.', 'error');
      } else if (err === 'google_failed') {
        showAlert('Google authentication failed. Please try again.', 'error');
      } else if (err === 'account_disabled') {
        showAlert('This account has been deactivated. Please contact an administrator.', 'error');
      }
    }
  }, [router]);

  // ── Ask the server whether email features are on ───────────
  useEffect(() => {
    fetchAuthConfig()
      .then(cfg => setEmailEnabled(cfg.email_enabled))
      .catch(() => setEmailEnabled(false));
  }, []);

  // ── Load Google Identity Services script ───────────────────
  useEffect(() => {
    if (!mounted || !GOOGLE_ENABLED) return;

    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => initGoogle();
    document.head.appendChild(script);
    return () => {
      document.head.removeChild(script);
    };
  }, [mounted]); // eslint-disable-line react-hooks/exhaustive-deps

  function initGoogle() {
    if (!window.google || !GOOGLE_CLIENT_ID) return;
    window.google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: handleGoogleCredential,
      ux_mode: 'popup',
      auto_select: true,
    });
    try {
      window.google.accounts.id.prompt();
    } catch {}
    if (googleBtnRef.current) {
      window.google.accounts.id.renderButton(googleBtnRef.current, {
        theme: 'outline',
        size: 'large',
        text: 'continue_with',
        shape: 'rectangular',
        width: '100%',
      });
    }
  }

  // Re-render Google button when tab changes back to login/register
  useEffect(() => {
    if ((tab === 'login' || tab === 'register') && window.google && googleBtnRef.current) {
      setTimeout(() => {
        if (googleBtnRef.current && window.google) {
          window.google!.accounts.id.renderButton(googleBtnRef.current, {
            theme: 'outline',
            size: 'large',
            text: 'continue_with',
            shape: 'rectangular',
            width: '100%',
          });
        }
      }, 50);
    }
  }, [tab]);

  // ── Google credential callback ─────────────────────────────
  async function handleGoogleCredential(response: { credential: string }) {
    setGLoading(true);
    try {
      const data = await apiPost<{ access_token: string; user: Record<string, string> }>(
        '/auth/google/token', // correct endpoint
        { credential: response.credential },
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
  const showAlert = (msg: string, type: Alert['type'] = 'error') => setAlert({ msg, type });
  const hideAlert = () => setAlert(null);

  function switchTab(t: Tab) {
    if (t === 'login' || t === 'register') hideAlert();
    setTab(t);
    if (t === 'otp') setTimeout(() => otpRefs.current[0]?.focus(), 80);
  }

  // ── OTP boxes ──────────────────────────────────────────────
  function handleOtpInput(i: number, val: string) {
    const v = val.replace(/\D/g, '').slice(-1);
    const next = [...otpDigits];
    next[i] = v;
    setOtpDigits(next);
    if (v && i < 5) otpRefs.current[i + 1]?.focus();
    if (next.every(d => d)) submitOTP(next.join(''));
  }

  function handleOtpKey(i: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace') {
      e.preventDefault();
      const next = [...otpDigits];
      if (next[i]) {
        next[i] = '';
        setOtpDigits(next);
      } else if (i > 0) {
        next[i - 1] = '';
        setOtpDigits(next);
        otpRefs.current[i - 1]?.focus();
      }
    }
  }

  function handleOtpPaste(e: ClipboardEvent<HTMLInputElement>) {
    e.preventDefault();
    const text = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    const next = Array(6).fill('');
    text.split('').forEach((c, i) => {
      next[i] = c;
    });
    setOtpDigits(next);
    otpRefs.current[Math.min(text.length, 5)]?.focus();
    if (text.length === 6) submitOTP(text);
  }

  function prefillOTP(code: string) {
    const digits = String(code).replace(/\D/g, '').slice(0, 6).split('');
    const next = Array(6).fill('');
    digits.forEach((d, i) => {
      next[i] = d;
    });
    setOtpDigits(next);
  }

  // ── Auth handlers ──────────────────────────────────────────
  async function handleLogin(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    hideAlert();
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    try {
      const data = await apiPost<{ access_token: string; user: Record<string, string> }>(
        '/auth/login',
        { email: fd.get('email'), password: fd.get('password') },
      );
      saveSession(data);
      showAlert('Signed in! Redirecting…', 'success');
      setTimeout(() => router.push('/dashboard'), 600);
    } catch (err: unknown) {
      const error = err as Error & { status?: number };
      if (error.status === 403) {
        setOtpEmail(String(fd.get('email') || ''));
        try {
          const r = await apiPost<{ dev_otp?: string; email_sent?: boolean; detail?: string }>(
            '/auth/send-otp',
            { email: fd.get('email') },
          );
          switchTab('otp');
          if (r.dev_otp) {
            showAlert(`Your OTP: ${r.dev_otp}`, 'success');
            prefillOTP(r.dev_otp);
          } else if (r.email_sent === false)
            showAlert(r.detail || 'Could not send the code. Try again later.', 'error');
          else showAlert('Verification code sent to your email.', 'success');
        } catch {
          switchTab('otp');
        }
      } else {
        showAlert(error.message);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleRegister(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    hideAlert();
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    const email = String(fd.get('email') || '');
    try {
      const data = await apiPost<{
        access_token?: string;
        user?: Record<string, string>;
        dev_otp?: string;
        email_sent?: boolean;
        message?: string;
      }>('/auth/register', { name: fd.get('name'), email, password: fd.get('password') });
      // Email verification is off: the account is ready and already signed in
      if (data.access_token && data.user) {
        saveSession({ access_token: data.access_token, user: data.user });
        showAlert('Account created! Redirecting…', 'success');
        setTimeout(() => router.push('/dashboard'), 600);
        return;
      }
      setOtpEmail(email);
      switchTab('otp');
      if (data.dev_otp) {
        // Only returned by the backend in development mode
        showAlert(`OTP (email failed, dev mode): ${data.dev_otp}`, 'success');
        prefillOTP(data.dev_otp);
      } else if (data.email_sent === false) {
        showAlert(
          data.message || 'We could not send the verification email. Use "Resend" to try again.',
          'error',
        );
      } else {
        showAlert('OTP sent to your email. Enter it below.', 'success');
      }
    } catch (err: unknown) {
      showAlert((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function submitOTP(code: string) {
    if (code.length !== 6) return;
    hideAlert();
    setLoading(true);
    try {
      const data = await apiPost<{ access_token: string; user: Record<string, string> }>(
        '/auth/verify-otp',
        { email: otpEmail, code },
      );
      saveSession(data);
      showAlert('Verified! Signing you in…', 'success');
      setTimeout(() => router.push('/dashboard'), 700);
    } catch (err: unknown) {
      showAlert((err as Error).message);
      setOtpDigits(['', '', '', '', '', '']);
      otpRefs.current[0]?.focus();
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    if (!otpEmail) return;
    try {
      const r = await apiPost<{ dev_otp?: string; email_sent?: boolean; detail?: string }>(
        '/auth/send-otp',
        { email: otpEmail },
      );
      setOtpDigits(['', '', '', '', '', '']);
      if (r.dev_otp) {
        showAlert(`New code: ${r.dev_otp}`, 'success');
        prefillOTP(r.dev_otp);
      } else if (r.email_sent === false)
        showAlert(r.detail || 'Could not send the code. Try again later.', 'error');
      else showAlert('New code sent! Check your inbox.', 'success');
    } catch (err: unknown) {
      showAlert((err as Error).message);
    }
  }

  async function handleForgot(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setDevResetUrl('');
    const fd = new FormData(e.currentTarget);
    try {
      const data = await apiPost<{
        detail: string;
        dev_reset_url?: string;
        dev_reset_token?: string;
      }>('/auth/forgot-password', { email: fd.get('email') });
      showAlert(data.detail, 'success');
      if (data.dev_reset_url || data.dev_reset_token) {
        const url = data.dev_reset_url || '';
        const token = data.dev_reset_token || '';
        setDevResetUrl(url);
        if (token) setResetToken(token);
      }
    } catch (err: unknown) {
      showAlert((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleResetPassword(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!resetToken) {
      showAlert('Password reset token is missing. Please request a new link.');
      return;
    }
    if (newPassword.length < 8) {
      showAlert('Password must be at least 8 characters');
      return;
    }
    if (!/[A-Z]/.test(newPassword)) {
      showAlert('Password must contain at least one uppercase letter');
      return;
    }
    if (!/\d/.test(newPassword)) {
      showAlert('Password must contain at least one number');
      return;
    }
    if (newPassword !== confirmPassword) {
      showAlert('Passwords do not match');
      return;
    }
    setLoading(true);
    try {
      const res = await apiPost<{ detail: string }>('/auth/reset-password', {
        token: resetToken,
        new_password: newPassword,
      });
      showAlert(res.detail || 'Password reset successfully! Please sign in.', 'success');
      setNewPassword('');
      setConfirmPassword('');
      setResetToken('');
      setDevResetUrl('');
      if (typeof window !== 'undefined') {
        window.history.replaceState({}, document.title, window.location.pathname);
      }
      setTab('login');
    } catch (err: unknown) {
      showAlert((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // ── Shared input class ─────────────────────────────────────
  const inputCls = `w-full px-4 py-2.5 rounded-xl border border-slate-200 bg-white
                    text-slate-900 placeholder-slate-400 text-sm outline-none
                    focus:border-teal-500 focus:ring-2 focus:ring-teal-200/60
                    transition-all duration-200`;

  const btnCls = `w-full py-2.5 rounded-xl font-semibold text-sm
                  bg-teal-600 text-white
                  shadow-sm hover:bg-teal-700
                  disabled:opacity-50 disabled:cursor-not-allowed
                  transition-all duration-200 hover:-translate-y-0.5 active:translate-y-0`;

  const alertCls =
    alert?.type === 'success'
      ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
      : alert?.type === 'info'
        ? 'bg-blue-50 border-blue-200 text-blue-700'
        : 'bg-red-50 border-red-200 text-red-700';

  if (!mounted) return null;

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4
                    bg-gradient-to-br from-teal-50 via-teal-100 to-cyan-100"
    >
      {/* Decorative blobs */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden -z-10">
        <motion.div
          className="absolute -top-32 -left-32 w-96 h-96 bg-teal-200/40
                        rounded-full blur-3xl"
          animate={{ x: [0, 80, 0], y: [0, 50, 0] }}
          transition={{ duration: 16, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.div
          className="absolute -bottom-32 -right-32 w-96 h-96 bg-cyan-200/30
                        rounded-full blur-3xl"
          animate={{ x: [0, -70, 0], y: [0, -40, 0] }}
          transition={{ duration: 18, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.div
          className="absolute top-1/3 right-1/4 w-64 h-64 bg-teal-100/50 rounded-full blur-3xl"
          animate={{ scale: [1, 1.2, 1] }}
          transition={{ duration: 10, repeat: Infinity, ease: 'easeInOut' }}
        />
      </div>

      <div className="w-full max-w-[420px] flex flex-col items-center gap-5">
        {/* Brand */}
        <motion.div
          className="flex items-center gap-3 select-none"
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={ease}
        >
          <Image
            src="/logo.png"
            alt="SQLAnalyst"
            width={44}
            height={44}
            className="rounded-xl object-contain shadow-sm"
          />
          <div className="flex flex-col leading-none">
            <span
              className="font-heading text-2xl font-extrabold text-slate-900
                             tracking-tight"
            >
              SQLAnalyst
            </span>
            <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-slate-400 mt-0.5">
              AI Data Intelligence
            </span>
          </div>
        </motion.div>

        {/* Card */}
        <motion.div
          initial={{ opacity: 0, y: 20, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ ...ease, duration: 0.45, delay: 0.08 }}
          className="w-full bg-white/75 backdrop-blur-xl rounded-2xl
                        border border-white/80 shadow-[0_8px_32px_rgba(14,153,153,0.12)]
                        p-7 space-y-5"
        >
          {/* Tab bar — only on login/register */}
          {(tab === 'login' || tab === 'register') && (
            <div className="flex bg-teal-50/80 rounded-xl p-1 gap-1 border border-slate-200">
              {(['login', 'register'] as const).map(t => (
                <button
                  key={t}
                  onClick={() => switchTab(t)}
                  className={`relative flex-1 py-2 rounded-lg text-sm font-semibold
                              transition-colors duration-200
                              ${tab === t ? 'text-slate-900' : 'text-slate-500 hover:text-teal-700'}`}
                >
                  {tab === t && (
                    <motion.span
                      layoutId="auth-tab"
                      transition={spring}
                      className="absolute inset-0 rounded-lg bg-white shadow-sm border border-slate-200"
                    />
                  )}
                  <span className="relative">{t === 'login' ? 'Sign In' : 'Register'}</span>
                </button>
              ))}
            </div>
          )}

          {/* Alert */}
          <AnimatePresence mode="popLayout">
            {alert && (
              <motion.div
                key={alert.msg}
                initial={{ opacity: 0, y: -8, scale: 0.98 }}
                animate={{
                  opacity: 1,
                  y: 0,
                  scale: 1,
                  x: alert.type === 'error' ? [0, -5, 5, -3, 3, 0] : 0,
                }}
                exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.15 } }}
                transition={{ duration: 0.35 }}
                className={`px-4 py-3 rounded-xl border text-sm leading-snug ${alertCls}`}
              >
                {alert.msg}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Each step slides in when the tab changes (no exit wait, so refs mount right away) */}
          <motion.div
            key={tab}
            initial={{
              opacity: 0,
              x: tab === 'register' ? 16 : tab === 'login' ? -16 : 0,
              y: tab === 'login' || tab === 'register' ? 0 : 10,
            }}
            animate={{ opacity: 1, x: 0, y: 0 }}
            transition={ease}
          >
            {/* ════ LOGIN ════ */}
            {tab === 'login' && (
              <div className="space-y-4">
                <form onSubmit={handleLogin} className="space-y-4">
                  <Field label="Email">
                    <input
                      name="email"
                      type="text"
                      required
                      autoComplete="username"
                      placeholder="admin@sqlanalyst.com"
                      className={inputCls}
                    />
                  </Field>

                  <Field label="Password">
                    <div className="relative">
                      <input
                        name="password"
                        type={showPw ? 'text' : 'password'}
                        required
                        autoComplete="current-password"
                        placeholder="Enter your password"
                        className={inputCls + ' pr-10'}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPw(v => !v)}
                        className="absolute right-3 top-1/2 -translate-y-1/2
                                 text-slate-400 hover:text-teal-600 transition-colors"
                      >
                        <EyeIcon open={showPw} />
                      </button>
                    </div>
                  </Field>

                  {emailEnabled && (
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={() => switchTab('forgot')}
                        className="text-xs text-slate-500 hover:text-teal-700
                                 hover:underline transition-colors"
                      >
                        Forgot password?
                      </button>
                    </div>
                  )}

                  <button type="submit" disabled={loading} className={btnCls}>
                    {loading ? <Spinner /> : 'Sign In'}
                  </button>
                </form>

                {/* Divider + Google */}
                {GOOGLE_ENABLED && (
                  <>
                    <Divider />
                    <a
                      href={`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'}/auth/google/redirect`}
                      className="w-full flex items-center justify-center gap-3 px-4 py-2.5
                             rounded-xl border border-gray-300 bg-white text-gray-700
                             text-sm font-semibold hover:bg-gray-50 hover:border-gray-400
                             transition-all duration-200 shadow-sm"
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24">
                        <path
                          fill="#4285F4"
                          d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                        />
                        <path
                          fill="#34A853"
                          d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                        />
                        <path
                          fill="#FBBC05"
                          d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                        />
                        <path
                          fill="#EA4335"
                          d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                        />
                      </svg>
                      Continue with Google
                    </a>
                  </>
                )}
                {gLoading && (
                  <p className="text-center text-xs text-slate-500">Signing in with Google…</p>
                )}

                <p className="text-center text-sm text-teal-700">
                  No account?{' '}
                  <button
                    onClick={() => switchTab('register')}
                    className="font-semibold text-teal-700 hover:underline"
                  >
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
                    <input
                      name="name"
                      type="text"
                      required
                      autoComplete="name"
                      placeholder="Jane Smith"
                      className={inputCls}
                    />
                  </Field>

                  <Field label="Email address">
                    <input
                      name="email"
                      type="email"
                      required
                      autoComplete="email"
                      placeholder="you@example.com"
                      className={inputCls}
                    />
                  </Field>

                  <Field label="Password">
                    <div className="relative">
                      <input
                        name="password"
                        type={showPwReg ? 'text' : 'password'}
                        required
                        autoComplete="new-password"
                        placeholder="Min 8 chars, 1 uppercase, 1 number"
                        value={pw}
                        onChange={e => setPw(e.target.value)}
                        className={inputCls + ' pr-10'}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPwReg(v => !v)}
                        className="absolute right-3 top-1/2 -translate-y-1/2
                                 text-slate-400 hover:text-teal-600 transition-colors"
                      >
                        <EyeIcon open={showPwReg} />
                      </button>
                    </div>
                    {pw && (
                      <div className="mt-1.5 space-y-1">
                        <div className="flex gap-1">
                          {[1, 2, 3, 4].map(n => (
                            <div
                              key={n}
                              className={`h-1 flex-1 rounded-full transition-all duration-300
                                        ${pwScore >= n ? pwBars[pwScore] : 'bg-teal-100'}`}
                            />
                          ))}
                        </div>
                        <p className="text-xs text-slate-500">{pwLabels[pwScore]}</p>
                      </div>
                    )}
                  </Field>

                  <button type="submit" disabled={loading} className={btnCls}>
                    {loading ? <Spinner /> : 'Create Account'}
                  </button>
                </form>

                {GOOGLE_ENABLED && (
                  <>
                    <Divider />
                    <a
                      href={`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'}/auth/google/redirect`}
                      className="w-full flex items-center justify-center gap-3 px-4 py-2.5
                             rounded-xl border border-gray-300 bg-white text-gray-700
                             text-sm font-semibold hover:bg-gray-50 hover:border-gray-400
                             transition-all duration-200 shadow-sm"
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24">
                        <path
                          fill="#4285F4"
                          d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                        />
                        <path
                          fill="#34A853"
                          d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                        />
                        <path
                          fill="#FBBC05"
                          d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                        />
                        <path
                          fill="#EA4335"
                          d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                        />
                      </svg>
                      Continue with Google
                    </a>
                  </>
                )}

                <p className="text-center text-sm text-teal-700">
                  Already have an account?{' '}
                  <button
                    onClick={() => switchTab('login')}
                    className="font-semibold text-teal-700 hover:underline"
                  >
                    Sign in
                  </button>
                </p>
              </div>
            )}

            {/* ════ OTP ════ */}
            {tab === 'otp' && (
              <div className="flex flex-col items-center gap-4">
                {/* Icon */}
                <div
                  className="w-16 h-16 rounded-2xl bg-teal-50 border border-slate-200
                              flex items-center justify-center shadow-sm"
                >
                  <svg
                    width="30"
                    height="30"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    className="text-slate-500"
                  >
                    <path
                      d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1
                           0-2-.9-2-2V6c0-1.1.9-2 2-2z"
                    />
                    <polyline points="22,6 12,13 2,6" />
                  </svg>
                </div>

                <div className="text-center space-y-1">
                  <h2 className="font-heading text-lg font-bold text-slate-900">
                    Check your email
                  </h2>
                  <p className="text-sm text-teal-700 leading-snug">
                    We sent a 6-digit code to{' '}
                    <span className="font-semibold text-teal-700 break-all">{otpEmail}</span>
                    <br />
                    <span className="text-xs text-slate-400">Expires in 10 minutes</span>
                  </p>
                </div>

                {/* 6 digit boxes */}
                <div className="flex gap-2.5">
                  {otpDigits.map((d, i) => (
                    <input
                      key={i}
                      ref={el => {
                        otpRefs.current[i] = el;
                      }}
                      type="text"
                      inputMode="numeric"
                      maxLength={1}
                      value={d}
                      onChange={e => handleOtpInput(i, e.target.value)}
                      onKeyDown={e => handleOtpKey(i, e)}
                      onPaste={i === 0 ? handleOtpPaste : undefined}
                      className={`w-11 h-13 text-center text-xl font-bold rounded-xl
                                border-2 bg-teal-50/80 text-slate-900 outline-none
                                caret-transparent transition-all duration-150
                                ${
                                  d
                                    ? 'border-teal-500 bg-teal-100 shadow-sm'
                                    : 'border-slate-200 focus:border-teal-500 focus:ring-2 focus:ring-teal-200/60'
                                }`}
                      style={{ height: '52px' }}
                    />
                  ))}
                </div>

                <button
                  disabled={loading || otpDigits.join('').length !== 6}
                  onClick={() => submitOTP(otpDigits.join(''))}
                  className={btnCls}
                >
                  {loading ? <Spinner /> : 'Verify & Sign In'}
                </button>

                <p className="text-sm text-teal-700">
                  Did not receive it?{' '}
                  <button
                    onClick={handleResend}
                    className="font-semibold text-teal-700 hover:underline"
                  >
                    Resend code
                  </button>
                </p>

                <button
                  onClick={() => switchTab('register')}
                  className="flex items-center gap-1.5 text-sm text-slate-400
                           hover:text-teal-600 transition-colors"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                  Back
                </button>
              </div>
            )}

            {/* ════ FORGOT PASSWORD ════ */}
            {tab === 'forgot' && (
              <div className="space-y-4">
                <div className="text-center space-y-1">
                  <h2 className="font-heading text-lg font-bold text-slate-900">
                    Reset your password
                  </h2>
                  <p className="text-sm text-slate-500">
                    Enter your email and we will send a reset link.
                  </p>
                </div>

                <form onSubmit={handleForgot} className="space-y-4">
                  <input
                    name="email"
                    type="email"
                    required
                    placeholder="you@example.com"
                    className={inputCls}
                  />
                  <button type="submit" disabled={loading} className={btnCls}>
                    {loading ? <Spinner /> : 'Send Reset Link'}
                  </button>
                </form>

                {devResetUrl && (
                  <div className="p-3.5 bg-teal-50 border border-slate-200 rounded-xl space-y-2 text-center animate-fade-in">
                    <p className="text-xs font-semibold text-slate-900">
                      Direct Reset Link (Local Dev / Fallback):
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setTab('reset');
                        showAlert('Ready to set your new password.', 'info');
                      }}
                      className="w-full py-2 px-3 rounded-lg text-xs font-bold bg-teal-600 text-white hover:bg-teal-700 transition-colors shadow-sm"
                    >
                      Click to reset password now &rarr;
                    </button>
                  </div>
                )}

                <button
                  onClick={() => switchTab('login')}
                  className="flex items-center gap-1.5 text-sm text-slate-400
                           hover:text-teal-600 transition-colors mx-auto"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                  Back to sign in
                </button>
              </div>
            )}

            {/* ════ RESET PASSWORD ════ */}
            {tab === 'reset' && (
              <div className="space-y-4">
                <div className="text-center space-y-1">
                  <h2 className="font-heading text-lg font-bold text-slate-900">
                    Choose a new password
                  </h2>
                  <p className="text-sm text-slate-500">
                    Enter your new password below to update your account.
                  </p>
                </div>

                <form onSubmit={handleResetPassword} className="space-y-4">
                  <Field label="New Password">
                    <div className="relative">
                      <input
                        type={showResetPw ? 'text' : 'password'}
                        required
                        value={newPassword}
                        onChange={e => setNewPassword(e.target.value)}
                        placeholder="Min 8 chars, 1 uppercase, 1 number"
                        className={`${inputCls} pr-10`}
                      />
                      <button
                        type="button"
                        onClick={() => setShowResetPw(s => !s)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-teal-600 transition-colors"
                      >
                        {showResetPw ? (
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                            <line x1="1" y1="1" x2="23" y2="23" />
                          </svg>
                        ) : (
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                            <circle cx="12" cy="12" r="3" />
                          </svg>
                        )}
                      </button>
                    </div>
                  </Field>

                  <Field label="Confirm New Password">
                    <input
                      type="password"
                      required
                      value={confirmPassword}
                      onChange={e => setConfirmPassword(e.target.value)}
                      placeholder="Re-enter your new password"
                      className={inputCls}
                    />
                  </Field>

                  <button type="submit" disabled={loading} className={btnCls}>
                    {loading ? <Spinner /> : 'Update Password'}
                  </button>
                </form>

                <button
                  type="button"
                  onClick={() => switchTab('login')}
                  className="flex items-center gap-1.5 text-sm text-slate-400 hover:text-teal-600 transition-colors mx-auto"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                  Back to sign in
                </button>
              </div>
            )}
          </motion.div>
        </motion.div>

        <p className="text-xs text-slate-400">
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
      <label className="block text-[11px] font-bold uppercase tracking-wider text-teal-700">
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
      <span className="text-xs text-slate-400 font-medium">or continue with</span>
      <div className="flex-1 h-px bg-teal-100" />
    </div>
  );
}

function Spinner() {
  return (
    <span className="flex items-center justify-center gap-2">
      <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
        <path
          d="M12 2a10 10 0 0 1 10 10"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
      Please wait…
    </span>
  );
}

function EyeIcon({ open }: { open: boolean }) {
  return open ? (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path
        d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45
               0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5
               18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"
      />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  ) : (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

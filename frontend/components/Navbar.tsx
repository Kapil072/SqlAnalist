'use client';
import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import Image from 'next/image';
import { getUser, logout, authFetch, getToken, SourceInfo } from '@/lib/api';
import Avatar from '@/components/Avatar';
import Icon, { IconName } from '@/components/Icon';
import { AnimatePresence, motion, spring } from '@/components/motion';

interface Props {
  dbStatus?: { ok: boolean; version?: string };
  onNewChat?: () => void;
  /** Shows the sidebar button (dashboard only) */
  onToggleSidebar?: () => void;
  /** Database switcher (dashboard only): default database + admin-added data sources */
  sources?: SourceInfo[];
  sourceId?: string;
  onSourceChange?: (id: string) => void;
  /** Set when the selected database could not be read */
  sourceError?: string;
}

interface UserData {
  id?: string;
  name?: string;
  email?: string;
  role?: string;
  avatar_url?: string;
  email_verified?: string;
}

export default function Navbar({
  dbStatus,
  onNewChat,
  onToggleSidebar,
  sources,
  sourceId,
  onSourceChange,
  sourceError,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [userOpen, setUserOpen] = useState(false);
  const [user, setUser] = useState<UserData | null>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const fetchingRef = useRef(false); // guard against save → event → fetch loop

  // Load from localStorage immediately, then fetch fresh from /auth/me
  useEffect(() => {
    const local = getUser();
    if (local) setUser(local);

    async function fetchMe() {
      if (!getToken() || fetchingRef.current) return;
      fetchingRef.current = true;
      try {
        const res = await authFetch('/auth/me');
        if (res.ok) {
          const data = await res.json();
          const updated: UserData = {
            id: String(data.id || ''),
            name: data.name || '',
            email: data.email || '',
            role: data.role || 'user',
            avatar_url: data.avatar_url || '',
            email_verified: String(data.email_verified ?? 'false'),
          };
          setUser(updated);
          // Persist WITHOUT triggering the session-updated event
          localStorage.setItem('sqlanalyst_user', JSON.stringify(updated));
        }
      } catch {
        /* silently ignore */
      } finally {
        fetchingRef.current = false;
      }
    }
    fetchMe();

    // Session updates (same tab after Google login, or another tab)
    const onUpdate = () => {
      const u = getUser();
      if (u) setUser(u);
      fetchMe();
    };
    window.addEventListener('session-updated', onUpdate);
    window.addEventListener('storage', onUpdate);
    return () => {
      window.removeEventListener('session-updated', onUpdate);
      window.removeEventListener('storage', onUpdate);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Close the user menu on outside click or Escape
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) setUserOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setUserOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  async function handleLogout() {
    await logout();
    router.push('/auth');
  }

  const isAdmin = user?.role === 'admin';
  const tabs: { href: string; label: string; icon: IconName; active: boolean }[] = [
    { href: '/dashboard', label: 'Ask AI', icon: 'chat', active: pathname === '/dashboard' },
    {
      href: '/dashboard/sql',
      label: 'SQL Console',
      icon: 'terminal',
      active: pathname === '/dashboard/sql',
    },
  ];
  if (isAdmin)
    tabs.push({
      href: '/admin',
      label: 'Admin',
      icon: 'shield',
      active: !!pathname?.startsWith('/admin'),
    });

  const current = sources?.find(src => src.id === sourceId);
  const dbOk = current?.is_default ? (dbStatus?.ok ?? true) : !sourceError;

  return (
    <header
      className="h-14 flex items-center gap-3 px-3 sm:px-4 bg-white border-b border-slate-200
                 z-40 flex-shrink-0"
    >
      {onToggleSidebar && (
        <button
          onClick={onToggleSidebar}
          title="Show or hide the tables panel"
          aria-label="Toggle tables panel"
          className="btn-icon"
        >
          <Icon name="sidebar" size={18} />
        </button>
      )}

      {/* Brand */}
      <Link
        href="/dashboard"
        className={`${onToggleSidebar ? 'hidden sm:flex' : 'flex'} items-center gap-2 select-none flex-shrink-0`}
      >
        <motion.span whileHover={{ rotate: -8, scale: 1.08 }} transition={spring} className="flex">
          <Image
            src="/logo.png"
            alt="SQLAnalyst"
            width={28}
            height={28}
            className="rounded-lg object-contain"
          />
        </motion.span>
        <span className="hidden md:inline font-heading font-bold text-[15px] text-slate-900 tracking-tight">
          SQLAnalyst
        </span>
      </Link>

      {/* Main navigation */}
      <nav className="flex items-center gap-0.5 ml-1 sm:ml-3" aria-label="Main">
        {tabs.map(t => (
          <Link
            key={t.href}
            href={t.href}
            title={t.label}
            aria-current={t.active ? 'page' : undefined}
            className={`relative flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-lg text-sm font-medium transition-colors
              ${t.active ? 'text-teal-800' : 'text-slate-500 hover:text-slate-900 hover:bg-slate-100'}`}
          >
            {/* Active pill glides between tabs */}
            {t.active && (
              <motion.span
                layoutId="nav-pill"
                transition={spring}
                className="absolute inset-0 rounded-lg bg-teal-50 ring-1 ring-teal-100"
              />
            )}
            <Icon name={t.icon} size={15} className="relative" />
            <span className="relative hidden sm:inline">{t.label}</span>
          </Link>
        ))}
      </nav>

      <div className="flex-1" />

      {/* Database switcher — questions and SQL go to the database chosen here */}
      {onSourceChange && sources && (
        <label
          title={
            sourceError
              ? `Cannot use this database: ${sourceError}`
              : 'Choose which database your questions go to'
          }
          className={`relative flex items-center gap-2 h-9 pl-3 pr-2 rounded-xl border text-sm min-w-0 flex-shrink
            ${dbOk ? 'border-slate-200 bg-white hover:border-slate-300' : 'border-red-200 bg-red-50'}`}
        >
          <span className="relative flex w-2 h-2 flex-shrink-0">
            {dbOk && (
              <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60 animate-ping" />
            )}
            <span
              className={`relative inline-flex w-2 h-2 rounded-full ${dbOk ? 'bg-emerald-500' : 'bg-red-500'}`}
            />
          </span>
          <Icon name="database" size={14} className="text-slate-400 hidden sm:block" />
          <select
            aria-label="Database"
            value={sourceId}
            onChange={e => onSourceChange(e.target.value)}
            className="appearance-none bg-transparent pr-5 font-medium text-slate-800 cursor-pointer
                       focus:outline-none min-w-0 w-full max-w-[220px] truncate"
          >
            {sources.length === 0 && <option value={sourceId}>default</option>}
            {sources.map(src => (
              <option key={src.id} value={src.id}>
                {src.name}
                {src.is_default ? ' (default)' : ` · ${src.db_type}`}
              </option>
            ))}
          </select>
          <Icon
            name="chevronDown"
            size={14}
            className="absolute right-2 text-slate-400 pointer-events-none"
          />
        </label>
      )}

      {onNewChat && (
        <button
          onClick={onNewChat}
          title="New conversation"
          className="btn-secondary h-9 px-3 hidden sm:inline-flex"
        >
          <Icon name="plus" size={15} />
          <span className="hidden lg:inline">New chat</span>
        </button>
      )}

      {/* User menu */}
      <div className="relative flex-shrink-0" ref={dropRef}>
        <button
          onClick={() => setUserOpen(o => !o)}
          aria-haspopup="menu"
          aria-expanded={userOpen}
          className="flex items-center gap-2 p-1 sm:pr-2 rounded-xl hover:bg-slate-100 transition-colors"
        >
          <Avatar
            src={user?.avatar_url}
            email={user?.email}
            name={user?.name}
            className="w-8 h-8 rounded-full"
            fallbackClassName="text-xs"
          />
          <motion.span
            className="hidden sm:block text-slate-400"
            animate={{ rotate: userOpen ? 180 : 0 }}
            transition={spring}
          >
            <Icon name="chevronDown" size={14} />
          </motion.span>
        </button>

        <AnimatePresence>
          {userOpen && (
            <motion.div
              role="menu"
              initial={{ opacity: 0, scale: 0.95, y: -6 }}
              animate={{ opacity: 1, scale: 1, y: 0, transition: spring }}
              exit={{ opacity: 0, scale: 0.97, y: -4, transition: { duration: 0.12 } }}
              style={{ transformOrigin: 'top right' }}
              className="absolute right-0 top-full mt-2 w-64 card shadow-lg z-50 overflow-hidden"
            >
              <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-100">
                <Avatar
                  src={user?.avatar_url}
                  email={user?.email}
                  name={user?.name}
                  className="w-10 h-10 rounded-full"
                  fallbackClassName="text-sm"
                />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-900 truncate">
                    {user?.name || 'User'}
                  </p>
                  <p className="text-xs text-slate-500 truncate">{user?.email || ''}</p>
                  <span
                    className={`mt-1 inline-block text-[10px] font-semibold uppercase tracking-wider rounded px-1.5 py-0.5
                    ${isAdmin ? 'bg-teal-50 text-teal-700' : 'bg-slate-100 text-slate-600'}`}
                  >
                    {user?.role || 'user'}
                  </span>
                </div>
              </div>
              <div className="p-1.5">
                {onNewChat && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      setUserOpen(false);
                      onNewChat();
                    }}
                    className="sm:hidden w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-slate-700 hover:bg-slate-100"
                  >
                    <Icon name="plus" size={15} /> New chat
                  </button>
                )}
                {isAdmin && (
                  <Link
                    role="menuitem"
                    href="/admin"
                    onClick={() => setUserOpen(false)}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-slate-700 hover:bg-slate-100"
                  >
                    <Icon name="shield" size={15} /> Admin panel
                  </Link>
                )}
                <button
                  role="menuitem"
                  onClick={handleLogout}
                  className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-red-600 hover:bg-red-50"
                >
                  <Icon name="logout" size={15} /> Sign out
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </header>
  );
}

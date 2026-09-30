'use client';
import { useState, useEffect, useRef } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { getUser, logout } from '@/lib/api';

interface Props {
  dbStatus?: { ok: boolean; version?: string };
  onNewChat?: () => void;
  onRefreshSchema?: () => void;
}

export default function Navbar({ dbStatus, onNewChat, onRefreshSchema }: Props) {
  const router   = useRouter();
  const pathname = usePathname();
  const [userOpen, setUserOpen] = useState(false);
  const [user, setUser] = useState<Record<string, string> | null>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setUser(getUser()); }, []);

  // Close dropdown on outside click
  useEffect(() => {
    function handle(e: MouseEvent) {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) {
        setUserOpen(false);
      }
    }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, []);

  async function handleLogout() {
    await logout();
    router.push('/auth');
  }

  const isAdmin     = user?.role === 'admin';
  const onDashboard = pathname === '/dashboard';
  const onSql       = pathname === '/dashboard/sql';
  const onAdminPage = pathname?.startsWith('/admin');

  return (
    <header className="h-14 min-h-[56px] flex items-center justify-between px-5
                       bg-white/70 backdrop-blur-md border-b border-teal-200/60
                       shadow-sm z-50 flex-shrink-0">

      {/* Left — Brand */}
      <Link href="/dashboard" className="flex items-center gap-2.5 select-none">
        <Image src="/logo.png" alt="SQLAnalyst" width={30} height={30}
               className="rounded-lg object-contain flex-shrink-0" />
        <div className="hidden sm:flex flex-col leading-none">
          <span className="font-heading font-extrabold text-base text-teal-800 tracking-tight">
            SQLAnalyst
          </span>
          <span className="text-[9px] font-semibold uppercase tracking-widest text-teal-400">
            AI Intelligence
          </span>
        </div>
      </Link>

      {/* Center — Tab buttons */}
      <div className="flex items-center bg-teal-50/80 rounded-xl p-1 gap-1
                      border border-teal-200/60">
        <Link href="/dashboard"
          className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-semibold
                      transition-all duration-200
                      ${onDashboard && !onSql
                        ? 'bg-white text-teal-800 shadow-sm border border-teal-200/60'
                        : 'text-teal-500 hover:text-teal-700 hover:bg-white/50'}`}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" strokeWidth="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          AI Analyst
        </Link>
        <Link href="/dashboard/sql"
          className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-semibold
                      transition-all duration-200
                      ${onSql
                        ? 'bg-white text-teal-800 shadow-sm border border-teal-200/60'
                        : 'text-teal-500 hover:text-teal-700 hover:bg-white/50'}`}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" strokeWidth="2">
            <polyline points="4 17 10 11 4 5"/>
            <line x1="12" y1="19" x2="20" y2="19"/>
          </svg>
          SQL Console
        </Link>
        {isAdmin && (
          <Link href="/admin"
            className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-semibold
                        transition-all duration-200
                        ${onAdminPage
                          ? 'bg-white text-teal-800 shadow-sm border border-teal-200/60'
                          : 'text-teal-500 hover:text-teal-700 hover:bg-white/50'}`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
            Admin
          </Link>
        )}
      </div>

      {/* Right — status + actions + user */}
      <div className="flex items-center gap-2">

        {/* DB status pill */}
        {dbStatus !== undefined && (
          <div className={`hidden md:flex items-center gap-1.5 px-3 py-1 rounded-full
                           text-xs font-semibold border transition-all
                           ${dbStatus.ok
                             ? 'bg-teal-50 border-teal-200 text-teal-700'
                             : 'bg-red-50 border-red-200 text-red-700'}`}>
            <span className={`w-2 h-2 rounded-full animate-pulse-dot
                              ${dbStatus.ok ? 'bg-teal-500' : 'bg-red-500'}`} />
            {dbStatus.ok
              ? `MySQL ${dbStatus.version?.split('-')[0] || '8.0'}`
              : 'Disconnected'}
          </div>
        )}

        {/* Refresh schema */}
        {onRefreshSchema && (
          <button onClick={onRefreshSchema}
            title="Refresh schema"
            className="w-8 h-8 flex items-center justify-center rounded-lg border
                       border-teal-200 bg-white/60 text-teal-500 hover:text-teal-700
                       hover:bg-teal-50 transition-all duration-150">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="2">
              <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>
            </svg>
          </button>
        )}

        {/* New chat */}
        {onNewChat && (
          <button onClick={onNewChat}
            title="New conversation"
            className="w-8 h-8 flex items-center justify-center rounded-lg border
                       border-teal-200 bg-white/60 text-teal-500 hover:text-teal-700
                       hover:bg-teal-50 transition-all duration-150">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19"/>
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
          </button>
        )}

        {/* User dropdown */}
        <div className="relative" ref={dropRef}>
          <button onClick={() => setUserOpen(o => !o)}
            className="flex items-center gap-2 pl-1 pr-2.5 py-1 rounded-xl
                       bg-teal-50 border border-teal-200 hover:bg-teal-100
                       transition-all duration-150 select-none">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-teal-500 to-teal-700
                            flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
              {user?.name?.charAt(0).toUpperCase() || 'U'}
            </div>
            <div className="hidden sm:flex flex-col leading-none text-left">
              <span className="text-xs font-semibold text-teal-800">
                {user?.name || 'User'}
              </span>
              <span className="text-[10px] font-bold uppercase tracking-wider
                               text-teal-500 bg-teal-100 rounded px-1 w-fit mt-0.5">
                {user?.role || 'user'}
              </span>
            </div>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="2"
                 className={`text-teal-400 transition-transform duration-200
                            ${userOpen ? 'rotate-180' : ''}`}>
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>

          {userOpen && (
            <div className="absolute right-0 top-full mt-1.5 w-44 bg-white rounded-xl
                            border border-teal-100 shadow-teal-lg z-50 overflow-hidden
                            animate-fade-in">
              {isAdmin && (
                <Link href="/admin"
                  className="flex items-center gap-2 px-4 py-2.5 text-sm text-teal-700
                             hover:bg-teal-50 transition-colors"
                  onClick={() => setUserOpen(false)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                       stroke="currentColor" strokeWidth="2">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                  </svg>
                  Admin Panel
                </Link>
              )}
              <button onClick={handleLogout}
                className="w-full flex items-center gap-2 px-4 py-2.5 text-sm
                           text-red-600 hover:bg-red-50 transition-colors">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" strokeWidth="2">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                  <polyline points="16 17 21 12 16 7"/>
                  <line x1="21" y1="12" x2="9" y2="12"/>
                </svg>
                Sign Out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

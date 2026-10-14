'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Navbar from '@/components/Navbar';
import LoadingScreen from '@/components/LoadingScreen';
import { authFetch, clearSession, ensureFreshToken, getToken } from '@/lib/api';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [msg, setMsg] = useState('Checking access…');

  useEffect(() => {
    const expired = () => {
      setMsg('Session expired. Redirecting to login…');
      clearSession();
      setTimeout(() => router.replace('/auth'), 800);
    };

    (async () => {
      if (!getToken()) {
        setMsg('No session found. Redirecting to login…');
        setTimeout(() => router.replace('/auth'), 800);
        return;
      }
      // Refresh the access token via the refresh cookie if it has expired
      if (!(await ensureFreshToken())) {
        expired();
        return;
      }

      let res: Response;
      try {
        res = await authFetch('/auth/me');
      } catch (err) {
        setMsg('Cannot reach server: ' + (err as Error).message);
        setTimeout(() => router.replace('/auth'), 1500);
        return;
      }
      if (res.status === 401) {
        expired();
        return;
      }
      if (!res.ok) {
        setMsg('Error ' + res.status + '. Redirecting…');
        setTimeout(() => router.replace('/dashboard'), 1000);
        return;
      }
      const me = await res.json();
      if (me.role !== 'admin') {
        setMsg('Access denied — admin only.');
        setTimeout(() => router.replace('/dashboard'), 1000);
        return;
      }
      // Update localStorage with correct role from API
      localStorage.setItem(
        'sqlanalyst_user',
        JSON.stringify({
          id: me.id,
          name: me.name,
          email: me.email,
          role: me.role,
          email_verified: me.email_verified,
        }),
      );
      setReady(true);
    })();
  }, [router]);

  if (!ready) {
    return <LoadingScreen message="Loading Administration Console…" subMessage={msg} />;
  }

  return (
    <div
      className="flex flex-col h-screen overflow-hidden
                    bg-slate-50"
    >
      <Navbar />
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}

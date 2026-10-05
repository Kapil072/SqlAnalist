'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Navbar from '@/components/Navbar';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [msg, setMsg] = useState('Checking access…');

  useEffect(() => {
    const token = localStorage.getItem('sqlanalyst_token');

    // No token at all
    if (!token) {
      setMsg('No session found. Redirecting to login…');
      setTimeout(() => router.replace('/auth'), 800);
      return;
    }

    // Check token expiry by decoding JWT
    try {
      const parts = token.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(atob(parts[1]));
        const expiry = payload.exp * 1000;
        if (Date.now() > expiry) {
          setMsg('Session expired. Redirecting to login…');
          localStorage.removeItem('sqlanalyst_token');
          localStorage.removeItem('sqlanalyst_user');
          setTimeout(() => router.replace('/auth'), 800);
          return;
        }
      }
    } catch { /* bad token format */ }

    // Call /auth/me directly with raw fetch
    fetch((process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000') + '/auth/me', {
      headers: { 'Authorization': 'Bearer ' + token }
    })
    .then(async res => {
      if (res.status === 401) {
        setMsg('Session expired. Redirecting to login…');
        localStorage.removeItem('sqlanalyst_token');
        localStorage.removeItem('sqlanalyst_user');
        setTimeout(() => router.replace('/auth'), 800);
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
      localStorage.setItem('sqlanalyst_user', JSON.stringify({
        id: me.id, name: me.name, email: me.email,
        role: me.role, email_verified: me.email_verified
      }));
      setReady(true);
    })
    .catch(err => {
      setMsg('Cannot reach server: ' + err.message);
      setTimeout(() => router.replace('/auth'), 1500);
    });
  }, [router]);

  if (!ready) {
    return (
      <div className="flex items-center justify-center min-h-screen
                      bg-gradient-to-br from-teal-50 to-teal-100">
        <div className="flex flex-col items-center gap-4 text-center p-6">
          <div className="w-10 h-10 rounded-full border-2 border-teal-500
                          border-t-transparent animate-spin" />
          <p className="text-sm font-medium text-teal-600">{msg}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden
                    bg-gradient-to-br from-teal-50 to-teal-100">
      <Navbar />
      <main className="flex-1 overflow-y-auto">
        {children}
      </main>
    </div>
  );
}

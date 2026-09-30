'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getToken, getUser } from '@/lib/api';
import Navbar from '@/components/Navbar';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router   = useRouter();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const token = getToken();
    const user  = getUser();
    if (!token || !user)          { router.replace('/auth');      return; }
    if (user.role !== 'admin')    { router.replace('/dashboard'); return; }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!mounted) {
    return (
      <div className="flex items-center justify-center min-h-screen
                      bg-gradient-to-br from-teal-50 to-teal-100">
        <div className="w-10 h-10 rounded-full border-2 border-teal-500
                        border-t-transparent animate-spin" />
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

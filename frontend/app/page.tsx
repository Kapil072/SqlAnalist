'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getToken } from '@/lib/api';

export default function Root() {
  const router = useRouter();
  useEffect(() => {
    if (getToken()) router.replace('/dashboard');
    else router.replace('/auth');
  }, [router]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-gradient-to-br from-teal-50 to-teal-100">
      <div className="w-10 h-10 rounded-full border-2 border-teal-500 border-t-transparent animate-spin" />
    </div>
  );
}

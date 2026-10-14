'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getToken } from '@/lib/api';
import LoadingScreen from '@/components/LoadingScreen';

export default function Root() {
  const router = useRouter();
  useEffect(() => {
    if (getToken()) router.replace('/dashboard');
    else router.replace('/auth');
  }, [router]);

  return (
    <LoadingScreen message="Welcome to SQLAnalyst" subMessage="Redirecting to your workspace" />
  );
}

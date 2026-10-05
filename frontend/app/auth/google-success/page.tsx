'use client';
import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { saveSession } from '@/lib/api';

function GoogleSuccessInner() {
  const router = useRouter();
  const params = useSearchParams();

  useEffect(() => {
    const token = params.get('token');
    const name  = params.get('name')  || '';
    const email = params.get('email') || '';
    const role  = params.get('role')  || 'user';
    const id    = params.get('id')    || '';

    if (!token) { router.replace('/auth?error=google_failed'); return; }

    saveSession({
      access_token: token,
      user: { id, name, email, role, email_verified: 'true' },
    });
    router.replace('/dashboard');
  }, [params, router]);

  return (
    <div className="flex items-center justify-center min-h-screen
                    bg-gradient-to-br from-teal-50 to-teal-100">
      <div className="flex flex-col items-center gap-3">
        <div className="w-10 h-10 rounded-full border-2 border-teal-500
                        border-t-transparent animate-spin" />
        <p className="text-sm text-teal-600 font-medium">Signing you in with Google…</p>
      </div>
    </div>
  );
}

export default function GoogleSuccessPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center min-h-screen
                      bg-gradient-to-br from-teal-50 to-teal-100">
        <div className="w-10 h-10 rounded-full border-2 border-teal-500
                        border-t-transparent animate-spin" />
      </div>
    }>
      <GoogleSuccessInner />
    </Suspense>
  );
}

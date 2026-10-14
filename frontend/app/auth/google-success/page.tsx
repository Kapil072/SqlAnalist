'use client';
import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { saveSession } from '@/lib/api';
import LoadingScreen from '@/components/LoadingScreen';

function GoogleSuccessInner() {
  const router = useRouter();
  const query = useSearchParams();

  useEffect(() => {
    // The backend puts the token in the URL fragment (#token=...) so it is
    // never sent to any server or written to logs. Fall back to the query
    // string for older backends.
    const hash = typeof window !== 'undefined' ? window.location.hash.replace(/^#/, '') : '';
    const params = hash ? new URLSearchParams(hash) : query;

    const token = params.get('token');
    const name = params.get('name') || '';
    const email = params.get('email') || '';
    const role = params.get('role') || 'user';
    const id = params.get('id') || '';
    const avatar_url = params.get('avatar_url') || '';

    // Remove the token from the address bar / browser history
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', window.location.pathname);
    }

    if (!token) {
      router.replace('/auth?error=google_failed');
      return;
    }

    saveSession({
      access_token: token,
      user: { id, name, email, role, avatar_url, email_verified: 'true' },
    });
    router.replace('/dashboard');
  }, [query, router]);

  return (
    <LoadingScreen
      message="Signing you in with Google…"
      subMessage="Syncing your profile and redirecting to dashboard"
    />
  );
}

export default function GoogleSuccessPage() {
  return (
    <Suspense
      fallback={
        <LoadingScreen
          message="Signing you in with Google…"
          subMessage="Connecting to your Google profile"
        />
      }
    >
      <GoogleSuccessInner />
    </Suspense>
  );
}

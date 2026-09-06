'use client';

import React from 'react';
import { useAuth } from '@/hooks/useAuth';
import { LandingPage } from '@/components/LandingPage';
import { Dashboard } from '@/components/Dashboard';
import { Loader2 } from 'lucide-react';

export default function HomePage() {
  const { user, loading, authError, signInWithGoogle, signOutUser } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-[var(--color-base)] flex flex-col items-center justify-center text-[var(--color-text-primary)] gap-4">
        <div className="p-6 rounded-md bg-[var(--color-surface)] border border-[var(--color-divider)] flex flex-col items-center gap-3">
          <Loader2 className="w-5 h-5 animate-spin text-[var(--color-accent)]" />
          <span className="text-xs font-mono text-[var(--color-text-secondary)]">
            Verifying cryptographic session...
          </span>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <LandingPage
        onSignIn={signInWithGoogle}
        loading={loading}
        error={authError}
      />
    );
  }

  return <Dashboard user={user} onSignOut={signOutUser} />;
}

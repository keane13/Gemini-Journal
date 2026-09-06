'use client';

/**
 * @file app/security/self-test/page.tsx
 * FEATURE 10: /security/self-test
 *
 * Authenticated. Every check on this page attacks the running application and reports
 * what actually came back — no mocks, no hardcoded outcomes, no simulated delays.
 */

import React from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { SelfTestRunner } from '@/components/security/SelfTestRunner';

export default function SelfTestPage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--ink-base)]">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--paper-muted)]" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--ink-base)] px-6">
        <div
          className="max-w-md text-[var(--paper)]"
          style={{ fontFamily: 'var(--face-ui)' }}
        >
          <h1 className="mb-2 text-lg">Sign in required</h1>
          <p className="mb-4 text-[13px] text-[var(--paper-muted)]">
            The self-test runs against your own session, using your own token. It cannot run
            without one.
          </p>
          <button
            type="button"
            onClick={() => router.push('/')}
            className="rounded-[4px] bg-[var(--paper)] px-4 py-2 text-[13px] text-[var(--ink-base)] transition-opacity duration-[120ms] hover:opacity-90"
          >
            Go to sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--ink-base)] text-[var(--paper)]">
      <div className="mx-auto max-w-3xl px-6 py-12">
        <header className="mb-8 border-b border-[var(--ink-rule)] pb-6">
          <button
            type="button"
            onClick={() => router.push('/')}
            className="mb-6 text-[13px] text-[var(--paper-muted)] transition-colors duration-[120ms] hover:text-[var(--paper)]"
            style={{ fontFamily: 'var(--face-ui)' }}
          >
            Back to journal
          </button>

          <h1
            className="text-[26px] leading-tight"
            style={{ fontFamily: 'var(--face-body)' }}
          >
            Adversarial self-test
          </h1>

          <p
            className="mt-3 max-w-[60ch] text-[14px] leading-relaxed text-[var(--paper-muted)]"
            style={{ fontFamily: 'var(--face-ui)' }}
          >
            These checks attack this application while it is running, using your own session
            token, and report whatever the backend actually returns. Nothing here is
            simulated: each verdict is derived from a real HTTP status, a real Firestore
            response, or a real model reply, and you can expand any check to read the raw
            response for yourself.
          </p>

          <p
            className="mt-3 max-w-[60ch] text-[13px] leading-relaxed text-[var(--paper-faint)]"
            style={{ fontFamily: 'var(--face-ui)' }}
          >
            A failing check is displayed exactly as prominently as a passing one. If
            something here is red, believe it.
          </p>
        </header>

        <SelfTestRunner user={user} />
      </div>
    </div>
  );
}

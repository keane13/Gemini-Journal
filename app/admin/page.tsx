'use client';

/**
 * @file app/admin/page.tsx
 * FEATURE 7: Admin console entry point.
 *
 * Client-side gating here is a convenience, not a control. Every /api/admin/* endpoint
 * independently verifies the role claim from the cryptographically signed token, so
 * rendering this page without the claim yields nothing but denials.
 */

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { AdminConsole } from '@/components/AdminConsole';

interface RoleInfo {
  uid: string;
  role: 'user' | 'admin';
  bootstrapEligible: boolean;
}

export default function AdminPage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  const [roleInfo, setRoleInfo] = useState<RoleInfo | null>(null);
  const [checking, setChecking] = useState(true);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * The role probe runs inside the effect; the bootstrap handler re-runs it by bumping
   * `reloadToken`. This keeps state updates out of the synchronous effect body.
   */
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (loading) return;

    let cancelled = false;

    (async () => {
      if (!user) {
        if (!cancelled) setChecking(false);
        return;
      }
      try {
        const token = await user.getIdToken(true);
        const res = await fetch('/api/admin/claims', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const info = res.ok ? await res.json() : null;
        if (!cancelled) setRoleInfo(info);
      } catch {
        if (!cancelled) setRoleInfo(null);
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loading, user, reloadToken]);

  const bootstrap = async () => {
    if (!user) return;
    setBootstrapping(true);
    setNotice(null);
    try {
      const token = await user.getIdToken(true);
      const res = await fetch('/api/admin/claims', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'admin' }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.message || body?.error || 'Bootstrap failed.');
      // The claim only lands on the next token refresh.
      await user.getIdToken(true);
      setNotice('Administrator role granted. Reloading console...');
      setReloadToken((t) => t + 1);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Bootstrap failed.');
    } finally {
      setBootstrapping(false);
    }
  };

  if (loading || checking) {
    return (
      <div className="min-h-screen bg-[var(--color-base)] flex items-center justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-[var(--color-accent)]" />
      </div>
    );
  }

  if (!user) {
    return (
      <Gate
        icon={ShieldAlert}
        title="Sign in required"
        body="The admin console requires an authenticated session."
        action={{ label: 'Go to sign in', onClick: () => router.push('/') }}
      />
    );
  }

  if (roleInfo?.role === 'admin') {
    return <AdminConsole user={user} onExit={() => router.push('/')} />;
  }

  return (
    <Gate
      icon={ShieldAlert}
      title="Administrator role required"
      body={
        roleInfo?.bootstrapEligible
          ? 'This account appears in the bootstrap allowlist. You may grant yourself the administrator role once; the grant is audited.'
          : 'This account does not hold the administrator role. Role claims are set server-side and cannot be requested from the client.'
      }
      notice={notice}
      action={
        roleInfo?.bootstrapEligible
          ? { label: bootstrapping ? 'Granting...' : 'Grant myself admin', onClick: bootstrap }
          : { label: 'Back to journal', onClick: () => router.push('/') }
      }
    />
  );
}

const Gate: React.FC<{
  icon: React.ElementType;
  title: string;
  body: string;
  notice?: string | null;
  action: { label: string; onClick: () => void };
}> = ({ icon: Icon, title, body, notice, action }) => (
  <div className="min-h-screen bg-[var(--color-base)] flex items-center justify-center px-6">
    <div className="max-w-md w-full rounded-md border border-[var(--color-divider)] bg-[var(--color-surface)] p-6 flex flex-col gap-3 text-[var(--color-text-primary)]">
      <Icon className="w-6 h-6 text-[var(--color-accent)]" />
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="text-sm text-[var(--color-text-secondary)]">{body}</p>
      {notice ? (
        <div className="rounded border border-[var(--color-divider)] bg-[var(--color-base)] px-3 py-2 font-mono text-xs">
          {notice}
        </div>
      ) : null}
      <button
        onClick={action.onClick}
        className="self-start mt-1 inline-flex items-center gap-2 text-xs font-mono px-4 py-2 rounded bg-[var(--color-accent)] text-[var(--ink-base)] hover:opacity-90 transition-opacity"
      >
        <ShieldCheck className="w-3.5 h-3.5" />
        {action.label}
      </button>
    </div>
  </div>
);

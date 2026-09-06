'use client';

/**
 * @file components/AdminConsole.tsx
 * FEATURE 7: Blind Admin Console.
 *
 * Renders operational health only. There is no component here that can display journal
 * content, because there is no endpoint that would return it. The "Prove it" panel calls
 * the real backend and shows the verbatim PERMISSION_DENIED that Firestore returns for an
 * administrator's attempted read of another account's entries.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { User } from 'firebase/auth';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  EyeOff,
  Gauge,
  Loader2,
  Lock,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Timer,
  UserX,
} from 'lucide-react';

interface Cell {
  value: number | null;
  suppressed: boolean;
  users: number | null;
}

interface FleetMetrics {
  periodStart: string;
  periodEnd: string;
  days: number;
  smallCellThreshold: number;
  dailyActiveUsers: Cell;
  entriesCreated: Cell;
  modelCalls: Cell;
  latency: { p50Ms: Cell; p95Ms: Cell; p95IsLowerBound: boolean; samples: number };
  tokenSpend: { input: Cell; output: Cell; total: Cell };
  redactionHistogram: Array<{ category: string; cell: Cell }>;
  errorsByCode: Array<{ code: string; cell: Cell; ratePerThousand: number | null }>;
  rateLimitHits: Cell;
  missingDays: string[];
}

interface ProveResult {
  verdict: 'BLIND_CONFIRMED' | 'DENIED_BUT_CONTROL_FAILED' | 'UNEXPECTED_ACCESS';
  explanation: string;
  whyItFails: string;
  targetExists: boolean;
  probes: {
    target: ProbeView;
    control: ProbeView;
  };
}

interface ProbeView {
  label: string;
  method: string;
  url: string;
  attributedTo: string;
  httpStatus: number;
  firestoreStatus: string | null;
  message?: string | null;
  rawResponse: string;
  expected: string;
  passed: boolean;
}

interface AdminConsoleProps {
  user: User;
  onExit: () => void;
}

const numberFormat = new Intl.NumberFormat();

/** Renders a metric, or the suppression notice when the cell is withheld. */
const MetricValue: React.FC<{ cell: Cell; suffix?: string; threshold: number }> = ({
  cell,
  suffix,
  threshold,
}) => {
  if (cell.suppressed) {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-[var(--color-text-secondary)]"
        title={`Withheld: fewer than ${threshold} distinct users contributed to this figure.`}
      >
        <Lock className="w-3.5 h-3.5" />
        <span className="font-mono text-sm">withheld</span>
      </span>
    );
  }
  return (
    <span className="font-mono text-2xl text-[var(--color-text-primary)]">
      {numberFormat.format(cell.value ?? 0)}
      {suffix ? <span className="text-sm text-[var(--color-text-secondary)] ml-1">{suffix}</span> : null}
    </span>
  );
};

const StatCard: React.FC<{
  label: string;
  icon: React.ElementType;
  cell: Cell;
  suffix?: string;
  threshold: number;
  hint?: string;
}> = ({ label, icon: Icon, cell, suffix, threshold, hint }) => (
  <div className="rounded-md border border-[var(--color-divider)] bg-[var(--color-surface)] p-4 flex flex-col gap-2">
    <div className="flex items-center gap-2 text-[var(--color-text-secondary)]">
      <Icon className="w-3.5 h-3.5" />
      <span className="text-[11px] font-mono uppercase tracking-wider">{label}</span>
    </div>
    <MetricValue cell={cell} suffix={suffix} threshold={threshold} />
    {hint ? <span className="text-[11px] text-[var(--color-text-secondary)]">{hint}</span> : null}
  </div>
);

export const AdminConsole: React.FC<AdminConsoleProps> = ({ user, onExit }) => {
  const [metrics, setMetrics] = useState<FleetMetrics | null>(null);
  const [days, setDays] = useState(7);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [targetUid, setTargetUid] = useState('');
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const [proving, setProving] = useState(false);
  const [proof, setProof] = useState<ProveResult | null>(null);
  const [proofError, setProofError] = useState<string | null>(null);

  /**
   * Always requests a fresh ID token. Destructive endpoints check `auth_time`, so a
   * stale cached token would be rejected server-side.
   */
  const authHeader = useCallback(async () => {
    const token = await user.getIdToken(/* forceRefresh */ true);
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }, [user]);

  /**
   * Fetching lives inside the effect and re-runs when `days` or `reloadToken` changes.
   * Handlers request a reload by bumping the token rather than invoking the fetch
   * directly, which keeps state updates out of the synchronous effect body and lets the
   * cleanup flag drop responses that arrive after unmount or after a newer request.
   */
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`/api/admin/metrics?days=${days}`, { headers: await authHeader() });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.message || body?.error || 'Failed to load metrics.');
        if (!cancelled) setMetrics(body.metrics);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load metrics.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [days, reloadToken, authHeader]);

  const refreshMetrics = () => {
    setLoading(true);
    setError(null);
    setReloadToken((t) => t + 1);
  };

  const runAction = async (action: 'suspend' | 'reinstate' | 'revoke_sessions') => {
    if (!targetUid.trim()) {
      setActionNotice('Enter a target account uid first.');
      return;
    }
    setActionBusy(action);
    setActionNotice(null);
    try {
      const res = await fetch('/api/admin/actions', {
        method: 'POST',
        headers: await authHeader(),
        body: JSON.stringify({ action, targetUid: targetUid.trim() }),
      });
      const body = await res.json();
      setActionNotice(
        res.ok
          ? `${action} succeeded for ${targetUid.trim()}. ${body?.note ?? ''}`.trim()
          : `${body?.error ?? 'ERROR'}: ${body?.message ?? 'Action failed.'}`
      );
    } catch (err) {
      setActionNotice(err instanceof Error ? err.message : 'Action failed.');
    } finally {
      setActionBusy(null);
    }
  };

  const runProof = async () => {
    if (!targetUid.trim()) {
      setProofError('Enter the uid of a real account other than your own.');
      return;
    }
    setProving(true);
    setProof(null);
    setProofError(null);
    try {
      const res = await fetch('/api/admin/prove', {
        method: 'POST',
        headers: await authHeader(),
        body: JSON.stringify({ targetUid: targetUid.trim() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.message || body?.error || 'Proof run failed.');
      setProof(body);
    } catch (err) {
      setProofError(err instanceof Error ? err.message : 'Proof run failed.');
    } finally {
      setProving(false);
    }
  };

  const threshold = metrics?.smallCellThreshold ?? 5;

  return (
    <div className="min-h-screen bg-[var(--color-base)] text-[var(--color-text-primary)]">
      {/* ---------------------------------------------------------------- */}
      {/* Header: the product statement is the first thing an operator sees */}
      {/* ---------------------------------------------------------------- */}
      <header className="border-b border-[var(--color-divider)] bg-[var(--color-surface)]">
        <div className="max-w-6xl mx-auto px-6 py-5 flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4">
            <button
              onClick={onExit}
              className="inline-flex items-center gap-2 text-xs font-mono text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back to journal
            </button>
            <span className="inline-flex items-center gap-2 text-[11px] font-mono text-[var(--color-text-secondary)]">
              <BadgeCheck className="w-3.5 h-3.5 text-[var(--color-accent)]" />
              {user.email} · role=admin
            </span>
          </div>

          <div className="flex items-start gap-3">
            <EyeOff className="w-6 h-6 text-[var(--color-accent)] shrink-0 mt-0.5" />
            <div>
              <h1 className="text-xl font-semibold tracking-tight">
                This console cannot read user entries.
              </h1>
              <p className="text-sm text-[var(--color-text-secondary)] mt-1 max-w-3xl">
                Administrators manage accounts, not content. Journal documents are gated on
                ownership in Firestore rules, which never consult the admin role. Every figure
                below is a precomputed aggregate; any cell backed by fewer than {threshold}{' '}
                distinct users is withheld. Use <strong>Prove it</strong> to watch the backend
                refuse this console a real user&apos;s entries, live.
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-6 flex flex-col gap-8">
        {/* ------------------------------ Fleet health ------------------------------ */}
        <section className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <h2 className="text-sm font-mono uppercase tracking-wider text-[var(--color-text-secondary)] inline-flex items-center gap-2">
              <Activity className="w-4 h-4" />
              Operational health
            </h2>
            <div className="flex items-center gap-2">
              <select
                value={days}
                onChange={(e) => {
                  setLoading(true);
                  setDays(Number(e.target.value));
                }}
                className="bg-[var(--color-surface)] border border-[var(--color-divider)] rounded px-2 py-1 text-xs font-mono"
              >
                <option value={1}>Last 1 day</option>
                <option value={7}>Last 7 days</option>
                <option value={30}>Last 30 days</option>
              </select>
              <button
                onClick={refreshMetrics}
                disabled={loading}
                className="inline-flex items-center gap-1.5 text-xs font-mono px-2.5 py-1.5 rounded border border-[var(--color-divider)] hover:bg-[var(--color-surface-elevated)] transition-colors disabled:opacity-50"
              >
                {loading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" />
                )}
                Refresh
              </button>
            </div>
          </div>

          {error ? (
            <div className="rounded-md border border-[var(--color-alert)] bg-[var(--color-alert-dim)] px-4 py-3 text-sm">
              {error}
            </div>
          ) : null}

          {metrics ? (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <StatCard
                  label="Daily active users"
                  icon={Activity}
                  cell={metrics.dailyActiveUsers}
                  threshold={threshold}
                />
                <StatCard
                  label="Entries created"
                  icon={Activity}
                  cell={metrics.entriesCreated}
                  threshold={threshold}
                />
                <StatCard
                  label="Model latency p50"
                  icon={Timer}
                  cell={metrics.latency.p50Ms}
                  suffix="ms"
                  threshold={threshold}
                  hint={`${numberFormat.format(metrics.latency.samples)} samples`}
                />
                <StatCard
                  label="Model latency p95"
                  icon={Timer}
                  cell={metrics.latency.p95Ms}
                  suffix={metrics.latency.p95IsLowerBound ? 'ms+' : 'ms'}
                  threshold={threshold}
                  hint={metrics.latency.p95IsLowerBound ? 'lower bound (overflow bucket)' : undefined}
                />
                <StatCard
                  label="Tokens in"
                  icon={Gauge}
                  cell={metrics.tokenSpend.input}
                  threshold={threshold}
                />
                <StatCard
                  label="Tokens out"
                  icon={Gauge}
                  cell={metrics.tokenSpend.output}
                  threshold={threshold}
                />
                <StatCard
                  label="Total token spend"
                  icon={Gauge}
                  cell={metrics.tokenSpend.total}
                  threshold={threshold}
                />
                <StatCard
                  label="Rate-limit hits"
                  icon={ShieldAlert}
                  cell={metrics.rateLimitHits}
                  threshold={threshold}
                />
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                {/* Redaction histogram */}
                <div className="rounded-md border border-[var(--color-divider)] bg-[var(--color-surface)] p-4">
                  <h3 className="text-[11px] font-mono uppercase tracking-wider text-[var(--color-text-secondary)] mb-3">
                    Redaction categories across the fleet
                  </h3>
                  {metrics.redactionHistogram.length === 0 ? (
                    <p className="text-xs text-[var(--color-text-secondary)]">
                      Nothing to show: every category is backed by fewer than {threshold} users and
                      is withheld.
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {metrics.redactionHistogram.map((row) => {
                        const max = metrics.redactionHistogram[0]?.cell.value || 1;
                        const pct = Math.round(((row.cell.value ?? 0) / max) * 100);
                        return (
                          <li key={row.category} className="flex items-center gap-3">
                            <span className="w-32 shrink-0 font-mono text-xs text-[var(--color-text-secondary)]">
                              {row.category}
                            </span>
                            <span className="flex-1 h-2 rounded bg-[var(--color-surface-elevated)] overflow-hidden">
                              <span
                                className="block h-full bg-[var(--color-accent)]"
                                style={{ width: `${pct}%` }}
                              />
                            </span>
                            <span className="font-mono text-xs w-14 text-right">
                              {numberFormat.format(row.cell.value ?? 0)}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>

                {/* Errors by code */}
                <div className="rounded-md border border-[var(--color-divider)] bg-[var(--color-surface)] p-4">
                  <h3 className="text-[11px] font-mono uppercase tracking-wider text-[var(--color-text-secondary)] mb-3">
                    Error rates by code
                  </h3>
                  {metrics.errorsByCode.length === 0 ? (
                    <p className="text-xs text-[var(--color-text-secondary)]">
                      No error code reaches the {threshold}-user reporting threshold.
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {metrics.errorsByCode.map((row) => (
                        <li
                          key={row.code}
                          className="flex items-center justify-between gap-3 font-mono text-xs"
                        >
                          <span className="text-[var(--color-text-secondary)]">{row.code}</span>
                          <span>
                            {numberFormat.format(row.cell.value ?? 0)}
                            {row.ratePerThousand !== null ? (
                              <span className="text-[var(--color-text-secondary)] ml-2">
                                {row.ratePerThousand}/1k calls
                              </span>
                            ) : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              {metrics.missingDays.length > 0 ? (
                <p className="text-[11px] font-mono text-[var(--color-text-secondary)]">
                  No aggregate document for {metrics.missingDays.length} day(s) in range; those days
                  contribute nothing rather than being estimated.
                </p>
              ) : null}
            </>
          ) : null}
        </section>

        {/* ------------------------------ Account actions ------------------------------ */}
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-mono uppercase tracking-wider text-[var(--color-text-secondary)] inline-flex items-center gap-2">
            <UserX className="w-4 h-4" />
            Account actions
          </h2>
          <div className="rounded-md border border-[var(--color-divider)] bg-[var(--color-surface)] p-4 flex flex-col gap-3">
            <label className="text-xs font-mono text-[var(--color-text-secondary)]">
              Target account uid
              <input
                value={targetUid}
                onChange={(e) => setTargetUid(e.target.value)}
                placeholder="e.g. 8Kx2mQ..."
                className="mt-1 w-full bg-[var(--color-base)] border border-[var(--color-divider)] rounded px-3 py-2 font-mono text-sm text-[var(--color-text-primary)]"
              />
            </label>

            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => runAction('suspend')}
                disabled={actionBusy !== null}
                className="inline-flex items-center gap-1.5 text-xs font-mono px-3 py-2 rounded border border-[var(--color-alert)] text-[var(--color-alert)] hover:bg-[var(--color-alert-dim)] transition-colors disabled:opacity-50"
              >
                {actionBusy === 'suspend' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <UserX className="w-3.5 h-3.5" />
                )}
                Suspend account
              </button>
              <button
                onClick={() => runAction('reinstate')}
                disabled={actionBusy !== null}
                className="inline-flex items-center gap-1.5 text-xs font-mono px-3 py-2 rounded border border-[var(--color-divider)] hover:bg-[var(--color-surface-elevated)] transition-colors disabled:opacity-50"
              >
                {actionBusy === 'reinstate' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <ShieldCheck className="w-3.5 h-3.5" />
                )}
                Reinstate
              </button>
              <button
                onClick={() => runAction('revoke_sessions')}
                disabled={actionBusy !== null}
                className="inline-flex items-center gap-1.5 text-xs font-mono px-3 py-2 rounded border border-[var(--color-divider)] hover:bg-[var(--color-surface-elevated)] transition-colors disabled:opacity-50"
              >
                {actionBusy === 'revoke_sessions' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" />
                )}
                Revoke sessions
              </button>
            </div>

            <p className="text-[11px] text-[var(--color-text-secondary)]">
              Destructive actions require a sign-in within the last 5 minutes and write an
              immutable audit record before they run. If the audit append fails, the action is
              refused.
            </p>

            {actionNotice ? (
              <div className="rounded border border-[var(--color-divider)] bg-[var(--color-base)] px-3 py-2 font-mono text-xs">
                {actionNotice}
              </div>
            ) : null}
          </div>
        </section>

        {/* ------------------------------ Prove it ------------------------------ */}
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-mono uppercase tracking-wider text-[var(--color-text-secondary)] inline-flex items-center gap-2">
            <Lock className="w-4 h-4" />
            Prove it
          </h2>
          <div className="rounded-md border border-[var(--color-divider)] bg-[var(--color-surface)] p-4 flex flex-col gap-3">
            <p className="text-sm text-[var(--color-text-secondary)]">
              This runs two real reads against Firestore using your own administrator token: one
              against the target account&apos;s journal entries (expected to be denied), and one
              against your own (expected to succeed, proving the token works and the denial is an
              authorization decision).
            </p>

            <button
              onClick={runProof}
              disabled={proving}
              className="self-start inline-flex items-center gap-2 text-xs font-mono px-4 py-2 rounded bg-[var(--color-accent)] text-[var(--ink-base)] hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {proving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Lock className="w-3.5 h-3.5" />}
              Attempt to read this user&apos;s journal
            </button>

            {proofError ? (
              <div className="rounded border border-[var(--color-alert)] bg-[var(--color-alert-dim)] px-3 py-2 text-xs">
                {proofError}
              </div>
            ) : null}

            {proof ? (
              <div className="flex flex-col gap-3">
                <div
                  className={`rounded border px-3 py-2 text-sm flex items-start gap-2 ${
                    proof.verdict === 'BLIND_CONFIRMED'
                      ? 'border-[var(--color-accent)] bg-[var(--color-accent-dim)]'
                      : 'border-[var(--color-alert)] bg-[var(--color-alert-dim)]'
                  }`}
                >
                  {proof.verdict === 'BLIND_CONFIRMED' ? (
                    <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0" />
                  ) : (
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                  )}
                  <div>
                    <div className="font-mono text-xs mb-1">{proof.verdict}</div>
                    <div>{proof.explanation}</div>
                  </div>
                </div>

                {[proof.probes.target, proof.probes.control].map((probe, i) => (
                  <div
                    key={i}
                    className="rounded border border-[var(--color-divider)] bg-[var(--color-base)] p-3 flex flex-col gap-1.5"
                  >
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <span className="text-xs font-medium">{probe.label}</span>
                      <span
                        className={`font-mono text-[11px] px-2 py-0.5 rounded ${
                          probe.passed
                            ? 'bg-[var(--color-accent-dim)] text-[var(--color-accent)]'
                            : 'bg-[var(--color-alert-dim)] text-[var(--color-alert)]'
                        }`}
                      >
                        HTTP {probe.httpStatus}
                        {probe.firestoreStatus ? ` · ${probe.firestoreStatus}` : ''}
                      </span>
                    </div>
                    <div className="font-mono text-[11px] text-[var(--color-text-secondary)] break-all">
                      {probe.method} {probe.url}
                    </div>
                    <div className="font-mono text-[11px] text-[var(--color-text-secondary)]">
                      as {probe.attributedTo} · expected: {probe.expected}
                    </div>
                    <pre className="payload-dump mt-1 max-h-40 overflow-auto rounded bg-[var(--color-surface-elevated)] p-2 font-mono text-[11px] whitespace-pre-wrap break-all">
                      {probe.rawResponse}
                    </pre>
                  </div>
                ))}

                <p className="text-[11px] text-[var(--color-text-secondary)]">{proof.whyItFails}</p>
              </div>
            ) : null}
          </div>
        </section>
      </main>
    </div>
  );
};

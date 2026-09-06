'use client';

/**
 * @file components/security/SelfTestRunner.tsx
 * FEATURE 10: the checklist.
 *
 * Failures are rendered exactly as prominently as passes — same type size, same weight,
 * same position, differing only in the mark and its colour. A security page that makes
 * its failures quiet is worse than no security page, because it manufactures confidence.
 *
 * Colour follows the design system: --system for a pass, --alarm-text for a failure,
 * --paper-faint for a skip. --annotation is not used here at all; amber means masked
 * personal data everywhere in this product and must not be borrowed for "warning".
 */

import React, { useCallback, useEffect, useState } from 'react';
import { User } from 'firebase/auth';
import { Check, ChevronRight, Clipboard, Loader2, Minus, X } from 'lucide-react';

type CheckStatus = 'pending' | 'running' | 'pass' | 'fail' | 'skipped' | 'error';

interface CheckDefinition {
  id: string;
  title: string;
  directive: string;
  directiveSource: string;
  testFile: string;
  expectation: string;
}

interface CheckResult {
  id: string;
  status: 'pass' | 'fail' | 'skipped' | 'error';
  observed: string;
  skipReason?: string;
  elapsedMs: number;
  raw: string;
  detail?: Record<string, unknown>;
}

interface Manifest {
  checks: CheckDefinition[];
  canRun: boolean;
  authAgeSeconds: number;
  freshAuthWindowSeconds: number;
  isAdmin: boolean;
  fixtureConfigured: boolean;
  runsPerWindow: number;
  /** Published source tree, when one is configured. Null means render paths unlinked. */
  sourceBaseUrl: string | null;
  note: string;
}

/**
 * The covering test file, linked when a source base URL is configured and rendered as
 * plain text when it is not. On a page whose entire premise is that its claims can be
 * checked, a link that goes nowhere is worse than no link at all.
 */
const TestFileRef: React.FC<{ path: string; baseUrl: string | null }> = ({ path, baseUrl }) =>
  baseUrl ? (
    <a
      href={`${baseUrl}/${path}`}
      target="_blank"
      rel="noopener noreferrer"
      className="underline decoration-[var(--ink-rule)] underline-offset-2 transition-colors duration-[120ms] hover:text-[var(--paper)]"
    >
      <code>{path}</code>
    </a>
  ) : (
    <code>{path}</code>
  );

const STATUS_COLOR: Record<CheckStatus, string> = {
  pending: 'var(--paper-faint)',
  running: 'var(--paper-muted)',
  pass: 'var(--system)',
  fail: 'var(--alarm-text)',
  error: 'var(--alarm-text)',
  skipped: 'var(--paper-faint)',
};

const StatusMark: React.FC<{ status: CheckStatus }> = ({ status }) => {
  const color = STATUS_COLOR[status];
  if (status === 'running') {
    return <Loader2 className="h-4 w-4 animate-spin" style={{ color }} aria-hidden="true" />;
  }
  if (status === 'pass') return <Check className="h-4 w-4" style={{ color }} aria-hidden="true" />;
  if (status === 'fail' || status === 'error') {
    return <X className="h-4 w-4" style={{ color }} aria-hidden="true" />;
  }
  if (status === 'skipped') {
    return <Minus className="h-4 w-4" style={{ color }} aria-hidden="true" />;
  }
  return (
    <span
      className="block h-1.5 w-1.5 rounded-full"
      style={{ backgroundColor: color }}
      aria-hidden="true"
    />
  );
};

const STATUS_WORD: Record<CheckStatus, string> = {
  pending: 'pending',
  running: 'running',
  pass: 'pass',
  fail: 'FAIL',
  error: 'ERROR',
  skipped: 'skipped',
};

/**
 * Reads a response without ever throwing an opaque parse error.
 *
 * `res.json()` on an empty body produces "Unexpected end of JSON input", which tells the
 * reader nothing about what actually failed. On a page whose whole purpose is showing
 * people what really happened, that is the worst possible error message. This surfaces
 * the status and whatever the body actually contained instead.
 */
async function readJson(res: Response): Promise<{ ok: boolean; data: any; error?: string }> {
  const text = await res.text().catch(() => '');

  if (!text.trim()) {
    return {
      ok: false,
      data: null,
      error: `The server returned an empty response (HTTP ${res.status}). Check the dev-server console for the underlying error.`,
    };
  }

  try {
    const data = JSON.parse(text);
    return { ok: res.ok, data, error: res.ok ? undefined : data?.message || data?.error };
  } catch {
    return {
      ok: false,
      data: null,
      error: `HTTP ${res.status}: ${text.slice(0, 300)}`,
    };
  }
}

export const SelfTestRunner: React.FC<{ user: User }> = ({ user }) => {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [statuses, setStatuses] = useState<Record<string, CheckStatus>>({});
  const [results, setResults] = useState<Record<string, CheckResult>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [finished, setFinished] = useState(false);
  // False when the run could not be recorded server-side. Reported, never hidden.
  const [persisted, setPersisted] = useState(true);

  const authHeaders = useCallback(async () => {
    const token = await user.getIdToken();
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }, [user]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/security/self-test', { headers: await authHeaders() });
        const { ok, data, error } = await readJson(res);
        if (!ok) throw new Error(error || 'Failed to load the check manifest.');
        if (!cancelled) {
          setManifest(data);
          setStatuses(
            Object.fromEntries(data.checks.map((c: CheckDefinition) => [c.id, 'pending']))
          );
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authHeaders]);

  const run = async () => {
    if (!manifest) return;
    setRunning(true);
    setError(null);
    setFinished(false);
    setResults({});
    setStatuses(Object.fromEntries(manifest.checks.map((c) => [c.id, 'pending'])));

    try {
      const headers = await authHeaders();

      const startRes = await fetch('/api/security/self-test', {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: 'start' }),
      });
      const start = await readJson(startRes);
      if (!start.ok) throw new Error(start.error || 'Could not start the run.');
      const runId: string = start.data.runId;
      if (start.data.persisted === false) setPersisted(false);

      // Sequential on purpose: RATE_LIMIT exhausts the quota, so order matters.
      for (const check of manifest.checks) {
        setStatuses((s) => ({ ...s, [check.id]: 'running' }));

        const res = await fetch('/api/security/self-test', {
          method: 'POST',
          headers,
          body: JSON.stringify({ action: 'run', runId, checkId: check.id }),
        });
        const { ok, data, error } = await readJson(res);

        if (!ok || !data?.result) {
          setStatuses((s) => ({ ...s, [check.id]: 'error' }));
          setResults((r) => ({
            ...r,
            [check.id]: {
              id: check.id,
              status: 'error',
              observed: error || 'The runner refused this check.',
              elapsedMs: 0,
              raw: data ? JSON.stringify(data, null, 2) : (error ?? ''),
            },
          }));
          continue;
        }

        if (data.persisted === false) setPersisted(false);
        const result: CheckResult = data.result;
        setResults((r) => ({ ...r, [check.id]: result }));
        setStatuses((s) => ({ ...s, [check.id]: result.status }));
      }

      await fetch('/api/security/self-test', {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: 'finalize', runId }),
      });
      setFinished(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The run failed.');
    } finally {
      setRunning(false);
    }
  };

  const summaryText = useCallback(() => {
    if (!manifest) return '';
    const counts = Object.values(results).reduce(
      (acc, r) => {
        if (r.status === 'pass') acc.pass += 1;
        else if (r.status === 'skipped') acc.skipped += 1;
        else acc.fail += 1;
        return acc;
      },
      { pass: 0, fail: 0, skipped: 0 }
    );

    const lines = [
      'Adversarial Self-Test — Personal Gemini Journal',
      `Run at: ${new Date().toISOString()}`,
      `Result: ${counts.pass} passed, ${counts.fail} failed, ${counts.skipped} skipped`,
      '',
    ];

    for (const check of manifest.checks) {
      const r = results[check.id];
      if (!r) {
        lines.push(`[ ] ${check.id} — not run`);
        continue;
      }
      const mark = r.status === 'pass' ? 'PASS' : r.status === 'skipped' ? 'SKIP' : 'FAIL';
      lines.push(`[${mark}] ${check.id} (${r.elapsedMs}ms)`);
      lines.push(`      ${r.observed}`);
      if (r.skipReason) lines.push(`      reason: ${r.skipReason}`);
      lines.push(`      directive: ${check.directiveSource}`);
      lines.push(`      covered by: ${check.testFile}`);
      lines.push('');
    }

    lines.push('Every check executed against the running application. No mocked results.');
    return lines.join('\n');
  }, [manifest, results]);

  const copySummary = async () => {
    try {
      await navigator.clipboard.writeText(summaryText());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not write to the clipboard.');
    }
  };

  if (error && !manifest) {
    return (
      <p className="text-[var(--alarm-text)]" style={{ fontFamily: 'var(--face-ui)' }}>
        {error}
      </p>
    );
  }
  if (!manifest) {
    return (
      <p className="text-[var(--paper-muted)]" style={{ fontFamily: 'var(--face-ui)' }}>
        Loading checks…
      </p>
    );
  }

  const counts = Object.values(results).reduce(
    (acc, r) => {
      if (r.status === 'pass') acc.pass += 1;
      else if (r.status === 'skipped') acc.skipped += 1;
      else acc.fail += 1;
      return acc;
    },
    { pass: 0, fail: 0, skipped: 0 }
  );

  return (
    <div style={{ fontFamily: 'var(--face-ui)' }} className="flex flex-col gap-6">
      {/* ---- Controls ---- */}
      <div className="flex flex-wrap items-center gap-4 border-b border-[var(--ink-rule)] pb-5">
        <button
          type="button"
          onClick={run}
          disabled={running || !manifest.canRun}
          className="rounded-[4px] bg-[var(--paper)] px-4 py-2 text-[13px] text-[var(--ink-base)] transition-opacity duration-[120ms] hover:opacity-90 disabled:opacity-30"
        >
          {running ? 'Running…' : 'Run the checks'}
        </button>

        {finished || Object.keys(results).length > 0 ? (
          <button
            type="button"
            onClick={copySummary}
            className="inline-flex items-center gap-1.5 text-[13px] text-[var(--paper-muted)] transition-colors duration-[120ms] hover:text-[var(--paper)]"
          >
            <Clipboard className="h-3.5 w-3.5" />
            {copied ? 'Copied' : 'Copy summary'}
          </button>
        ) : null}

        <span className="ml-auto text-[13px] tabular-nums">
          <span style={{ color: 'var(--system)' }}>{counts.pass} pass</span>
          <span className="mx-2 text-[var(--paper-faint)]">·</span>
          <span style={{ color: counts.fail > 0 ? 'var(--alarm-text)' : 'var(--paper-faint)' }}>
            {counts.fail} fail
          </span>
          <span className="mx-2 text-[var(--paper-faint)]">·</span>
          <span className="text-[var(--paper-faint)]">{counts.skipped} skipped</span>
        </span>
      </div>

      {!manifest.canRun ? (
        <p className="text-[13px] text-[var(--alarm-text)]">
          Re-authentication required. This page runs real attacks against the live system, so
          it needs a sign-in within the last{' '}
          {manifest.freshAuthWindowSeconds / 60} minutes. Sign out and back in, then reload.
        </p>
      ) : null}

      {!manifest.fixtureConfigured ? (
        <p className="text-[13px] text-[var(--paper-muted)]">
          No fixture tenant is configured (<code>SELFTEST_FIXTURE_UID</code>), so the
          cross-tenant checks will report as skipped rather than passing. They are never
          pointed at a real account.
        </p>
      ) : null}

      <p className="text-[13px] text-[var(--paper-muted)]">{manifest.note}</p>

      {!persisted ? (
        <p className="rounded-[4px] border border-[var(--alarm)] px-3 py-2 text-[13px] text-[var(--alarm-text)]">
          <strong>This run was not recorded server-side.</strong> Firestore persistence is
          unavailable, so results are held in memory on a single instance. Every check below
          still ran for real against the live application — but the tamper-evident record
          that normally makes these verdicts server-authored is missing for this run.
        </p>
      ) : null}

      {error ? <p className="text-[13px] text-[var(--alarm-text)]">{error}</p> : null}

      {/* ---- Checklist ---- */}
      <ol className="flex flex-col">
        {manifest.checks.map((check, i) => {
          const status = statuses[check.id] ?? 'pending';
          const result = results[check.id];
          const isOpen = expanded[check.id];

          return (
            <li key={check.id} className="border-b border-[var(--ink-rule)] py-5 last:border-b-0">
              <div className="flex items-start gap-3">
                <span className="mt-1 flex h-4 w-4 shrink-0 items-center justify-center">
                  <StatusMark status={status} />
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="text-[14px] text-[var(--paper)]">
                      {i + 1}. {check.title}
                    </span>
                    <span
                      className="text-[12px] tabular-nums"
                      style={{ color: STATUS_COLOR[status] }}
                    >
                      {STATUS_WORD[status]}
                      {result ? ` · ${result.elapsedMs}ms` : ''}
                    </span>
                    <code className="text-[11px] text-[var(--paper-faint)]">{check.id}</code>
                  </div>

                  {/* What was actually observed. */}
                  {result ? (
                    <p
                      className="mt-1.5 text-[13px]"
                      style={{
                        color:
                          result.status === 'pass'
                            ? 'var(--paper-muted)'
                            : result.status === 'skipped'
                              ? 'var(--paper-faint)'
                              : 'var(--alarm-text)',
                      }}
                    >
                      {result.observed}
                    </p>
                  ) : (
                    <p className="mt-1.5 text-[13px] text-[var(--paper-faint)]">
                      Expects: {check.expectation}
                    </p>
                  )}

                  {result?.skipReason ? (
                    <p className="mt-1 text-[12px] text-[var(--paper-faint)]">
                      {result.skipReason}
                    </p>
                  ) : null}

                  {/* The directive this check enforces, and where it is covered offline. */}
                  <p className="mt-2 text-[12px] text-[var(--paper-faint)]">
                    <span className="text-[var(--paper-muted)]">Directive:</span>{' '}
                    {check.directive}
                  </p>
                  <p className="mt-1 text-[12px] text-[var(--paper-faint)]">
                    {check.directiveSource}
                    <span className="mx-2">·</span>
                    <TestFileRef
                      path={check.testFile}
                      baseUrl={manifest.sourceBaseUrl}
                    />
                  </p>

                  {result?.raw ? (
                    <>
                      <button
                        type="button"
                        onClick={() =>
                          setExpanded((e) => ({ ...e, [check.id]: !e[check.id] }))
                        }
                        aria-expanded={Boolean(isOpen)}
                        className="mt-2 inline-flex items-center gap-1 text-[12px] text-[var(--paper-muted)] transition-colors duration-[120ms] hover:text-[var(--paper)]"
                      >
                        <ChevronRight
                          className={`h-3 w-3 transition-transform duration-[120ms] ${isOpen ? 'rotate-90' : ''}`}
                        />
                        {isOpen ? 'Hide raw response' : 'Show raw response'}
                      </button>

                      {isOpen ? (
                        <pre className="payload-dump mt-2 max-h-80 overflow-auto rounded-[4px] bg-[var(--ink-raised)] p-3 text-[11px] leading-relaxed whitespace-pre-wrap break-words text-[var(--paper-muted)]">
                          {result.raw}
                          {result.detail
                            ? `\n\n--- detail ---\n${JSON.stringify(result.detail, null, 2)}`
                            : ''}
                        </pre>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
};

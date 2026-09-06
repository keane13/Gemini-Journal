'use client';

/**
 * @file components/RetentionSettings.tsx
 * FEATURE 11: Managed Forgetting — the control.
 *
 * The copy here does real work. Most products describe deletion in the passive voice and
 * hedge about backups; this one has to say plainly that forgetting is irreversible, and
 * be believable when it does. It also has to defuse the reasonable fear that forgetting
 * degrades the product — it does not, because Recall and Patterns already run on the
 * redacted text, and that is stated rather than left to be discovered.
 *
 * Shortening the window destroys data in the same request, so it demands a typed phrase.
 * Lengthening it does not, because nothing is lost by keeping details longer.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { User } from 'firebase/auth';
import { AlertTriangle, Check, Clock, Loader2, X } from 'lucide-react';

type RetentionWindow = 30 | 90 | 365 | 'never';

interface Policy {
  window: RetentionWindow;
  updatedAt: string;
}

interface RetentionState {
  policy: Policy;
  options: RetentionWindow[];
  minimumDays: number;
  kmsConfigured: boolean;
  shortenConfirmPhrase: string;
  copy: {
    what: string;
    afterwards: string;
    retrieval: string;
    irreversible: string;
  };
}

const LABELS: Record<string, string> = {
  '30': '30 days',
  '90': '90 days',
  '365': 'One year',
  never: 'Never forget',
};

function rank(w: RetentionWindow): number {
  return w === 'never' ? Number.POSITIVE_INFINITY : w;
}

export const RetentionSettings: React.FC<{ user: User; onClose: () => void }> = ({
  user,
  onClose,
}) => {
  const [state, setState] = useState<RetentionState | null>(null);
  const [selected, setSelected] = useState<RetentionWindow | null>(null);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const authHeaders = useCallback(async () => {
    const token = await user.getIdToken();
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }, [user]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/retention/settings', { headers: await authHeaders() });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.message || 'Failed to load retention settings.');
        if (!cancelled) {
          setState(body);
          setSelected(body.policy.window);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authHeaders, reloadToken]);

  const isShortening =
    state && selected !== null && rank(selected) < rank(state.policy.window);
  const changed = state && selected !== null && selected !== state.policy.window;

  const save = async () => {
    if (!state || selected === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/retention/settings', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({
          window: selected,
          confirm: isShortening ? confirm : undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.message || 'Failed to update retention.');

      setNotice(
        body.shortened
          ? body.note || 'Window shortened. Details outside it have been destroyed.'
          : 'Retention window updated.'
      );
      setConfirm('');
      setReloadToken((t) => t + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update retention.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-lg border border-[var(--ink-rule)] bg-[var(--ink-raised)] text-[var(--paper)]"
        style={{ fontFamily: 'var(--face-ui)' }}
      >
        <header className="sticky top-0 flex items-center justify-between gap-4 border-b border-[var(--ink-rule)] bg-[var(--ink-raised)] px-5 py-4">
          <h2 className="inline-flex items-center gap-2 text-sm font-semibold">
            <Clock className="h-4 w-4 text-[var(--paper-muted)]" />
            What this journal forgets
          </h2>
          <button
            onClick={onClose}
            className="text-[var(--paper-muted)] transition-colors duration-[120ms] hover:text-[var(--paper)]"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {!state ? (
          <div className="flex items-center gap-2 px-5 py-6 text-[13px] text-[var(--paper-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : (
          <div className="flex flex-col gap-5 px-5 py-5">
            <div className="flex flex-col gap-2 text-[13px] leading-relaxed text-[var(--paper-muted)]">
              <p>{state.copy.what}</p>
              <p>
                {state.copy.afterwards.split('"')[0]}
                <span className="text-[var(--annotation)]">
                  &quot;Dia minta aku follow up ke [EMAIL_1]&quot;
                </span>
                .
              </p>
            </div>

            {/* The reassurance that matters most: forgetting costs nothing. */}
            <p className="border-l border-[var(--ink-rule)] pl-3 text-[13px] leading-relaxed text-[var(--paper-muted)]">
              {state.copy.retrieval}
            </p>

            {!state.kmsConfigured ? (
              <p className="rounded-[4px] border border-[var(--alarm)] px-3 py-2 text-[12px] text-[var(--alarm-text)]">
                Cloud KMS is not configured on this deployment, so no rehydration payload is
                being stored at all — details are never recoverable regardless of this
                setting. The app never falls back to storing them unencrypted.
              </p>
            ) : null}

            {/* Options */}
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-[12px] text-[var(--paper-faint)]">
                Keep the details for
              </legend>
              {state.options.map((option) => {
                const active = selected === option;
                const shortensFromHere = rank(option) < rank(state.policy.window);
                return (
                  <label
                    key={String(option)}
                    className="flex cursor-pointer items-start gap-2.5 text-[13px]"
                  >
                    <input
                      type="radio"
                      name="retention"
                      className="mt-1"
                      checked={active}
                      onChange={() => {
                        setSelected(option);
                        setConfirm('');
                      }}
                    />
                    <span>
                      <span className="text-[var(--paper)]">{LABELS[String(option)]}</span>
                      {option === 90 ? (
                        <span className="ml-2 text-[11px] text-[var(--paper-faint)]">
                          default
                        </span>
                      ) : null}
                      {shortensFromHere ? (
                        <span className="ml-2 text-[11px] text-[var(--alarm-text)]">
                          destroys details now
                        </span>
                      ) : null}
                      {option === 'never' ? (
                        <span className="mt-0.5 block text-[12px] text-[var(--paper-faint)]">
                          Details are kept until you change this. Nothing is destroyed
                          automatically.
                        </span>
                      ) : null}
                    </span>
                  </label>
                );
              })}
              <p className="mt-1 text-[11px] text-[var(--paper-faint)]">
                Shorter than {state.minimumDays} days is not offered: the details would be
                gone before you had a chance to read your own reflection back, which is data
                loss rather than a privacy control.
              </p>
            </fieldset>

            {/* Irreversibility, stated where the decision is made. */}
            <p className="text-[12px] leading-relaxed text-[var(--paper-muted)]">
              <strong className="text-[var(--paper)]">This cannot be undone.</strong>{' '}
              {state.copy.irreversible}
            </p>

            {isShortening ? (
              <label className="flex flex-col gap-1.5 text-[12px] text-[var(--alarm-text)]">
                <span className="inline-flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Shortening destroys details immediately. Type{' '}
                  <code>{state.shortenConfirmPhrase}</code> to confirm.
                </span>
                <input
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="rounded-[4px] border border-[var(--alarm)] bg-[var(--ink-base)] px-2 py-2 text-[13px] text-[var(--paper)]"
                />
              </label>
            ) : null}

            {notice ? (
              <p className="rounded-[4px] border border-[var(--ink-rule)] px-3 py-2 text-[12px] text-[var(--paper)]">
                {notice}
              </p>
            ) : null}
            {error ? (
              <p className="rounded-[4px] border border-[var(--alarm)] px-3 py-2 text-[12px] text-[var(--alarm-text)]">
                {error}
              </p>
            ) : null}

            <div className="flex items-center gap-3">
              <button
                onClick={save}
                disabled={
                  busy ||
                  !changed ||
                  (Boolean(isShortening) && confirm !== state.shortenConfirmPhrase)
                }
                className="inline-flex items-center gap-2 rounded-[4px] bg-[var(--paper)] px-4 py-2 text-[13px] text-[var(--ink-base)] transition-opacity duration-[120ms] hover:opacity-90 disabled:opacity-30"
              >
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                Save
              </button>
              <span className="text-[12px] text-[var(--paper-faint)]">
                Currently: {LABELS[String(state.policy.window)]}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

'use client';

/**
 * @file components/DigestSettings.tsx
 * FEATURE 8: Weekly digest opt-in, with a live preview of the exact outgoing email.
 *
 * The preview is not a mock-up. It is rendered server-side by renderDigestEmail -- the
 * same function the scheduled job calls -- from this user's real counters. What appears
 * here is byte-for-byte what would arrive in their inbox, which is the point: payload
 * minimization is something the user can check for themselves rather than take on trust.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { User } from 'firebase/auth';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Mail,
  MailCheck,
  ShieldCheck,
  X,
} from 'lucide-react';

interface DigestState {
  enabled: boolean;
  gmailConnected: boolean;
  address: string | null;
  payload: {
    isoWeek: string;
    entriesWritten: number;
    moodDirection: string;
    recurringThemeCount: number;
    overdueCommitmentCount: number;
  };
  preview: { subject: string; text: string; html: string };
  guarantees: Record<string, unknown>;
}

interface DigestSettingsProps {
  user: User;
  onClose: () => void;
}

declare global {
  interface Window {
    google?: any;
  }
}

const GIS_SRC = 'https://accounts.google.com/gsi/client';

function loadGis(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') return reject(new Error('no window'));
    if (window.google?.accounts?.oauth2) return resolve();

    const existing = document.querySelector(`script[src="${GIS_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Failed to load Google script.')));
      return;
    }

    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Google Identity Services.'));
    document.head.appendChild(script);
  });
}

export const DigestSettings: React.FC<DigestSettingsProps> = ({ user, onClose }) => {
  const [state, setState] = useState<DigestState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<'rendered' | 'text'>('rendered');

  const authHeaders = useCallback(async () => {
    const token = await user.getIdToken();
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }, [user]);

  /**
   * Settings and preview are fetched inside the effect. Handlers request a refresh by
   * bumping `reloadToken`, keeping state updates out of the synchronous effect body.
   */
  const [reloadToken, setReloadToken] = useState(0);
  const reload = () => setReloadToken((t) => t + 1);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch('/api/digest/settings', { headers: await authHeaders() });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.message || 'Failed to load digest settings.');
        if (!cancelled) setState(body);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load digest settings.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authHeaders, reloadToken]);

  /** Incremental consent: requests gmail.send alone, separate from sign-in. */
  const connectGmail = async () => {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      await loadGis();

      const cfgRes = await fetch('/api/digest/connect', { headers: await authHeaders() });
      const cfg = await cfgRes.json();
      if (!cfg?.clientId) {
        throw new Error('Gmail OAuth client is not configured on the server.');
      }

      const code: string = await new Promise((resolve, reject) => {
        const client = window.google.accounts.oauth2.initCodeClient({
          client_id: cfg.clientId,
          scope: cfg.scope,
          ux_mode: 'popup',
          callback: (response: any) => {
            if (response?.code) resolve(response.code);
            else reject(new Error(response?.error || 'Authorization was cancelled.'));
          },
        });
        client.requestCode();
      });

      const res = await fetch('/api/digest/connect', {
        method: 'POST',
        headers: await authHeaders(),
        // 'postmessage' is the redirect URI for the GIS popup code flow.
        body: JSON.stringify({ code, redirectUri: 'postmessage' }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.message || 'Failed to connect Gmail.');

      setNotice('Gmail connected. The digest is still off — turn it on below when ready.');
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect Gmail.');
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const res = await fetch('/api/digest/settings', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ enabled }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.message || 'Failed to update setting.');
      setNotice(
        enabled
          ? 'Weekly digest on. It will arrive once a week, on schedule.'
          : 'Weekly digest off, and the Gmail grant has been revoked.'
      );
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update setting.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-3xl max-h-[90vh] overflow-auto rounded-lg border border-[var(--color-divider)] bg-[var(--color-surface)] text-[var(--color-text-primary)]">
        <header className="sticky top-0 flex items-center justify-between gap-4 border-b border-[var(--color-divider)] bg-[var(--color-surface)] px-5 py-4">
          <h2 className="inline-flex items-center gap-2 text-sm font-semibold">
            <Mail className="w-4 h-4 text-[var(--color-accent)]" />
            Weekly digest
          </h2>
          <button
            onClick={onClose}
            className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="px-5 py-5 flex flex-col gap-5">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading your settings...
            </div>
          ) : (
            <>
              {/* What it is */}
              <p className="text-sm text-[var(--color-text-secondary)]">
                Once a week, a short summary of your own journaling activity, sent{' '}
                <strong className="text-[var(--color-text-primary)]">
                  from your own Google account to yourself
                </strong>
                . No third-party email service ever receives it. It is off unless you turn it on,
                and it arrives on a fixed schedule — never because of anything you wrote.
              </p>

              {/* Guarantees */}
              <ul className="grid sm:grid-cols-2 gap-2 text-xs">
                {[
                  'Counts only — no entry text',
                  'No entry titles',
                  'Nothing Gemini wrote',
                  'Only the gmail.send scope',
                  'Overdue commitments by count',
                  'Never triggered by mood',
                ].map((item) => (
                  <li
                    key={item}
                    className="inline-flex items-center gap-2 text-[var(--color-text-secondary)]"
                  >
                    <ShieldCheck className="w-3.5 h-3.5 text-[var(--color-accent)] shrink-0" />
                    {item}
                  </li>
                ))}
              </ul>

              {/* Controls */}
              <div className="rounded-md border border-[var(--color-divider)] bg-[var(--color-base)] p-4 flex flex-col gap-3">
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <div className="text-sm">
                    <div className="font-medium">
                      {state?.enabled ? 'Weekly digest is on' : 'Weekly digest is off'}
                    </div>
                    <div className="text-xs text-[var(--color-text-secondary)]">
                      {state?.address ? `Would be sent to ${state.address}` : 'No address on file'}
                    </div>
                  </div>

                  {!state?.gmailConnected ? (
                    <button
                      onClick={connectGmail}
                      disabled={busy}
                      className="inline-flex items-center gap-2 rounded bg-[var(--color-accent)] px-4 py-2 font-mono text-xs text-[var(--ink-base)] hover:opacity-90 disabled:opacity-50"
                    >
                      {busy ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <MailCheck className="w-3.5 h-3.5" />
                      )}
                      Connect Gmail (send only)
                    </button>
                  ) : (
                    <button
                      onClick={() => toggle(!state.enabled)}
                      disabled={busy}
                      className={`inline-flex items-center gap-2 rounded px-4 py-2 font-mono text-xs transition-colors disabled:opacity-50 ${
                        state.enabled
                          ? 'border border-[var(--color-divider)] hover:bg-[var(--color-surface-elevated)]'
                          : 'bg-[var(--color-accent)] text-[var(--ink-base)] hover:opacity-90'
                      }`}
                    >
                      {busy ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <CheckCircle2 className="w-3.5 h-3.5" />
                      )}
                      {state.enabled ? 'Turn off' : 'Turn on'}
                    </button>
                  )}
                </div>

                {state?.gmailConnected ? (
                  <p className="text-[11px] text-[var(--color-text-secondary)]">
                    Turning it off also revokes the Gmail grant — the app stops being able to send
                    at all, not just stops sending.
                  </p>
                ) : null}
              </div>

              {notice ? (
                <div className="rounded border border-[var(--color-accent)] bg-[var(--color-accent-dim)] px-3 py-2 text-xs">
                  {notice}
                </div>
              ) : null}
              {error ? (
                <div className="rounded border border-[var(--color-alert)] bg-[var(--color-alert-dim)] px-3 py-2 text-xs inline-flex items-start gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  {error}
                </div>
              ) : null}

              {/* Live preview */}
              {state?.preview ? (
                <section className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <h3 className="text-[11px] font-mono uppercase tracking-wider text-[var(--color-text-secondary)]">
                      Exactly what would be sent
                    </h3>
                    <div className="flex gap-1">
                      {(['rendered', 'text'] as const).map((mode) => (
                        <button
                          key={mode}
                          onClick={() => setPreviewMode(mode)}
                          className={`px-2.5 py-1 rounded font-mono text-[11px] transition-colors ${
                            previewMode === mode
                              ? 'bg-[var(--color-accent-dim)] text-[var(--color-accent)]'
                              : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                          }`}
                        >
                          {mode === 'rendered' ? 'Rendered' : 'Plain text'}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-md border border-[var(--color-divider)] overflow-hidden">
                    <div className="border-b border-[var(--color-divider)] bg-[var(--color-surface-elevated)] px-3 py-2 font-mono text-[11px] text-[var(--color-text-secondary)]">
                      Subject: {state.preview.subject}
                    </div>
                    {previewMode === 'rendered' ? (
                      <iframe
                        title="Digest email preview"
                        // Fully sandboxed: the preview renders markup but is granted no
                        // scripting, no same-origin access, and no navigation.
                        sandbox=""
                        srcDoc={state.preview.html}
                        className="w-full h-[380px] bg-white"
                      />
                    ) : (
                      <pre className="max-h-[380px] overflow-auto bg-[var(--color-base)] p-3 font-mono text-[11px] whitespace-pre-wrap">
                        {state.preview.text}
                      </pre>
                    )}
                  </div>

                  <p className="text-[11px] text-[var(--color-text-secondary)]">
                    Rendered from your real counters by the same code the scheduled send uses.
                    This is a preview of the message itself, not an illustration of one.
                  </p>
                </section>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

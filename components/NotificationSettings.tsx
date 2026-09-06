'use client';

/**
 * @file components/NotificationSettings.tsx
 * EXTERNAL NOTIFICATIONS: destination management.
 *
 * The design goal is that a user can see, before enabling anything, exactly what a third
 * party would receive. The preview is fetched from /api/notifications/test, which builds
 * it with the same functions the live dispatcher uses -- so it is the message, not an
 * illustration of one.
 *
 * Escalating to the `excerpt` tier requires typing a confirmation phrase. That friction
 * is intentional: it is the one setting that sends journal text off this system.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { User } from 'firebase/auth';
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Hash,
  Loader2,
  Mail,
  MessageSquare,
  Plus,
  Send,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';

type Channel = 'slack' | 'discord' | 'email';
type Tier = 'signal' | 'metadata' | 'excerpt';

interface TriggerFilter {
  type: string;
  modes?: string[];
  tags?: string[];
  threshold?: number;
}

interface Destination {
  id: string;
  channel: Channel;
  label: string;
  enabled: boolean;
  triggers: TriggerFilter[];
  payloadTier: Tier;
  targetPreview: string;
  excerptConsentAt: string | null;
  lastDeliveryOutcome: 'success' | 'failure' | null;
  consecutiveFailures: number;
}

interface Capabilities {
  channels: Channel[];
  triggerTypes: string[];
  payloadTiers: Tier[];
  maxDestinations: number;
  excerptConsentPhrase: string;
}

const CHANNEL_ICON: Record<Channel, React.ElementType> = {
  slack: Hash,
  discord: MessageSquare,
  email: Mail,
};

const TIER_COPY: Record<Tier, { label: string; detail: string }> = {
  signal: {
    label: 'Signal only',
    detail: 'That something happened, plus a link. No trigger name, no mode, no tags.',
  },
  metadata: {
    label: 'Metadata',
    detail: 'Adds the trigger, mode, your tag names, and counts. No text you or Gemini wrote.',
  },
  excerpt: {
    label: 'Redacted excerpt',
    detail: 'Adds up to 280 characters of your entry, with PII masked. Third parties store this.',
  },
};

const TRIGGER_COPY: Record<string, string> = {
  entry_created: 'Any entry is written',
  entry_mode: 'An entry in a specific mode',
  entry_tagged: 'An entry with a specific tag',
  commitment_created: 'I state a commitment',
  commitment_overdue: 'A commitment passes its time',
  themes_threshold: 'Recurring themes reach a count',
};

interface NotificationSettingsProps {
  user: User;
  onClose: () => void;
}

export const NotificationSettings: React.FC<NotificationSettingsProps> = ({ user, onClose }) => {
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // Add form
  const [showAdd, setShowAdd] = useState(false);
  const [channel, setChannel] = useState<Channel>('slack');
  const [label, setLabel] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [triggerType, setTriggerType] = useState('entry_created');
  const [triggerTags, setTriggerTags] = useState('');
  const [tier, setTier] = useState<Tier>('signal');
  const [consent, setConsent] = useState('');

  // Preview
  const [previewFor, setPreviewFor] = useState<string | null>(null);
  const [preview, setPreview] = useState<any>(null);

  const authHeaders = useCallback(async () => {
    const token = await user.getIdToken();
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }, [user]);

  const reload = () => setReloadToken((t) => t + 1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/notifications/destinations', { headers: await authHeaders() });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.message || 'Failed to load destinations.');
        if (!cancelled) {
          setDestinations(body.destinations ?? []);
          setCapabilities(body.capabilities ?? null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authHeaders, reloadToken]);

  const addDestination = async () => {
    setBusy('add');
    setError(null);
    setNotice(null);
    try {
      const triggers: TriggerFilter[] = [{ type: triggerType }];
      if (triggerType === 'entry_tagged') {
        triggers[0].tags = triggerTags.split(',').map((t) => t.trim()).filter(Boolean);
      }
      if (triggerType === 'entry_mode') {
        triggers[0].modes = triggerTags.split(',').map((t) => t.trim()).filter(Boolean);
      }
      if (triggerType === 'themes_threshold') {
        triggers[0].threshold = Number(triggerTags) || 3;
      }

      const res = await fetch('/api/notifications/destinations', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({
          channel,
          label,
          webhookUrl: channel === 'email' ? undefined : webhookUrl,
          triggers,
          payloadTier: tier,
          excerptConsent: tier === 'excerpt' ? consent : undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.message || 'Failed to add destination.');

      setNotice('Destination added.');
      setShowAdd(false);
      setWebhookUrl('');
      setLabel('');
      setConsent('');
      setTier('signal');
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add destination.');
    } finally {
      setBusy(null);
    }
  };

  const toggleEnabled = async (dest: Destination) => {
    setBusy(dest.id);
    try {
      await fetch('/api/notifications/destinations', {
        method: 'PATCH',
        headers: await authHeaders(),
        body: JSON.stringify({ id: dest.id, enabled: !dest.enabled }),
      });
      reload();
    } finally {
      setBusy(null);
    }
  };

  const remove = async (dest: Destination) => {
    setBusy(dest.id);
    try {
      await fetch(`/api/notifications/destinations?id=${encodeURIComponent(dest.id)}`, {
        method: 'DELETE',
        headers: await authHeaders(),
      });
      setNotice('Destination deleted and its webhook credential released.');
      reload();
    } finally {
      setBusy(null);
    }
  };

  const loadPreview = async (dest: Destination) => {
    setPreviewFor(dest.id);
    setPreview(null);
    try {
      const res = await fetch(`/api/notifications/test?id=${encodeURIComponent(dest.id)}`, {
        headers: await authHeaders(),
      });
      setPreview(await res.json());
    } catch {
      setPreview(null);
    }
  };

  const sendTest = async (dest: Destination) => {
    setBusy(dest.id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/notifications/test', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ id: dest.id }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.message || 'Test delivery failed.');
      setNotice('Sample notification delivered. It contained no real journal content.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Test delivery failed.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-3xl max-h-[90vh] overflow-auto rounded-lg border border-[var(--color-divider)] bg-[var(--color-surface)] text-[var(--color-text-primary)]">
        <header className="sticky top-0 flex items-center justify-between gap-4 border-b border-[var(--color-divider)] bg-[var(--color-surface)] px-5 py-4">
          <h2 className="inline-flex items-center gap-2 text-sm font-semibold">
            <Bell className="w-4 h-4 text-[var(--color-accent)]" />
            External notifications
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
          <div className="rounded-md border border-[var(--color-alert)] bg-[var(--color-alert-dim)] px-4 py-3 text-xs flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <div>
              <strong>Slack and Discord are third parties.</strong> Anything sent there is
              stored on their systems, visible to whoever can read that channel, under
              retention rules you do not control. Notifications default to disclosing{' '}
              <em>nothing</em> about your entries — only that something happened.
              <div className="mt-1.5">
                Notifications are <strong>never</strong> triggered by mood, sentiment, or
                distress detection.
              </div>
            </div>
          </div>

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading…
            </div>
          ) : (
            <>
              {notice ? (
                <div className="rounded border border-[var(--color-accent)] bg-[var(--color-accent-dim)] px-3 py-2 text-xs">
                  {notice}
                </div>
              ) : null}
              {error ? (
                <div className="rounded border border-[var(--color-alert)] bg-[var(--color-alert-dim)] px-3 py-2 text-xs">
                  {error}
                </div>
              ) : null}

              {/* Destination list */}
              <ul className="flex flex-col gap-3">
                {destinations.length === 0 ? (
                  <li className="text-sm text-[var(--color-text-secondary)]">
                    No destinations configured. Nothing leaves this system.
                  </li>
                ) : null}

                {destinations.map((dest) => {
                  const Icon = CHANNEL_ICON[dest.channel];
                  return (
                    <li
                      key={dest.id}
                      className="rounded-md border border-[var(--color-divider)] bg-[var(--color-base)] p-4 flex flex-col gap-3"
                    >
                      <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div className="flex items-start gap-2.5">
                          <Icon className="w-4 h-4 mt-0.5 text-[var(--color-accent)]" />
                          <div>
                            <div className="text-sm font-medium">{dest.label}</div>
                            <div className="font-mono text-[11px] text-[var(--color-text-secondary)]">
                              {dest.targetPreview}
                            </div>
                          </div>
                        </div>
                        <span
                          className={`font-mono text-[10px] px-2 py-1 rounded ${
                            dest.payloadTier === 'excerpt'
                              ? 'bg-[var(--color-alert-dim)] text-[var(--color-alert)]'
                              : 'bg-[var(--color-accent-dim)] text-[var(--color-accent)]'
                          }`}
                        >
                          {TIER_COPY[dest.payloadTier].label}
                        </span>
                      </div>

                      <div className="text-[11px] text-[var(--color-text-secondary)]">
                        {TIER_COPY[dest.payloadTier].detail}
                      </div>

                      <div className="flex flex-wrap gap-1.5">
                        {dest.triggers.map((t, i) => (
                          <span
                            key={i}
                            className="font-mono text-[10px] px-2 py-0.5 rounded bg-[var(--color-surface-elevated)] text-[var(--color-text-secondary)]"
                          >
                            {TRIGGER_COPY[t.type] ?? t.type}
                            {t.tags ? `: ${t.tags.join(', ')}` : ''}
                            {t.modes ? `: ${t.modes.join(', ')}` : ''}
                            {t.threshold ? `: ≥${t.threshold}` : ''}
                          </span>
                        ))}
                      </div>

                      {dest.consecutiveFailures > 0 ? (
                        <div className="text-[11px] text-[var(--color-alert)]">
                          {dest.consecutiveFailures} consecutive delivery failure
                          {dest.consecutiveFailures === 1 ? '' : 's'}
                          {dest.enabled ? '' : ' — auto-disabled'}
                        </div>
                      ) : null}

                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() => toggleEnabled(dest)}
                          disabled={busy === dest.id}
                          className="inline-flex items-center gap-1.5 text-[11px] font-mono px-2.5 py-1.5 rounded border border-[var(--color-divider)] hover:bg-[var(--color-surface-elevated)] disabled:opacity-50"
                        >
                          <CheckCircle2 className="w-3 h-3" />
                          {dest.enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          onClick={() => loadPreview(dest)}
                          className="inline-flex items-center gap-1.5 text-[11px] font-mono px-2.5 py-1.5 rounded border border-[var(--color-divider)] hover:bg-[var(--color-surface-elevated)]"
                        >
                          <ShieldCheck className="w-3 h-3" />
                          See exactly what is sent
                        </button>
                        <button
                          onClick={() => sendTest(dest)}
                          disabled={busy === dest.id}
                          className="inline-flex items-center gap-1.5 text-[11px] font-mono px-2.5 py-1.5 rounded border border-[var(--color-divider)] hover:bg-[var(--color-surface-elevated)] disabled:opacity-50"
                        >
                          <Send className="w-3 h-3" />
                          Send test
                        </button>
                        <button
                          onClick={() => remove(dest)}
                          disabled={busy === dest.id}
                          className="inline-flex items-center gap-1.5 text-[11px] font-mono px-2.5 py-1.5 rounded border border-[var(--color-alert)] text-[var(--color-alert)] hover:bg-[var(--color-alert-dim)] disabled:opacity-50"
                        >
                          <Trash2 className="w-3 h-3" />
                          Delete
                        </button>
                      </div>

                      {previewFor === dest.id && preview ? (
                        <div className="rounded border border-[var(--color-divider)] bg-[var(--color-surface-elevated)] p-3 flex flex-col gap-2">
                          <div className="font-mono text-[10px] text-[var(--color-text-secondary)]">
                            Tier: {preview.tier}
                            {preview.downgraded ? ' (downgraded — consent not recorded)' : ''} ·
                            contains journal text:{' '}
                            {preview.disclosure?.containsJournalText ? 'yes' : 'no'}
                          </div>
                          <pre className="payload-dump max-h-56 overflow-auto text-[10px] whitespace-pre-wrap break-all">
                            {JSON.stringify(preview.wireFormat, null, 2)}
                          </pre>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>

              {/* Add destination */}
              {!showAdd ? (
                <button
                  onClick={() => setShowAdd(true)}
                  disabled={
                    capabilities ? destinations.length >= capabilities.maxDestinations : false
                  }
                  className="self-start inline-flex items-center gap-2 text-xs font-mono px-4 py-2 rounded bg-[var(--color-accent)] text-[var(--ink-base)] hover:opacity-90 disabled:opacity-50"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add destination
                </button>
              ) : (
                <div className="rounded-md border border-[var(--color-divider)] bg-[var(--color-base)] p-4 flex flex-col gap-3">
                  <div className="grid sm:grid-cols-2 gap-3">
                    <label className="text-xs font-mono text-[var(--color-text-secondary)]">
                      Channel
                      <select
                        value={channel}
                        onChange={(e) => setChannel(e.target.value as Channel)}
                        className="mt-1 w-full bg-[var(--color-surface)] border border-[var(--color-divider)] rounded px-2 py-2 text-sm text-[var(--color-text-primary)]"
                      >
                        <option value="slack">Slack</option>
                        <option value="discord">Discord</option>
                        <option value="email">Email (your own Gmail)</option>
                      </select>
                    </label>

                    <label className="text-xs font-mono text-[var(--color-text-secondary)]">
                      Label
                      <input
                        value={label}
                        onChange={(e) => setLabel(e.target.value)}
                        placeholder="my #journal channel"
                        className="mt-1 w-full bg-[var(--color-surface)] border border-[var(--color-divider)] rounded px-2 py-2 text-sm text-[var(--color-text-primary)]"
                      />
                    </label>
                  </div>

                  {channel !== 'email' ? (
                    <label className="text-xs font-mono text-[var(--color-text-secondary)]">
                      Webhook URL
                      <input
                        value={webhookUrl}
                        onChange={(e) => setWebhookUrl(e.target.value)}
                        placeholder={
                          channel === 'slack'
                            ? 'https://hooks.slack.com/services/...'
                            : 'https://discord.com/api/webhooks/...'
                        }
                        className="mt-1 w-full bg-[var(--color-surface)] border border-[var(--color-divider)] rounded px-2 py-2 font-mono text-xs text-[var(--color-text-primary)]"
                      />
                      <span className="block mt-1 text-[10px]">
                        Only {channel === 'slack' ? 'hooks.slack.com' : 'discord.com'} URLs are
                        accepted.
                      </span>
                    </label>
                  ) : (
                    <p className="text-[11px] text-[var(--color-text-secondary)]">
                      Email notifications are sent from your own Gmail account to your own
                      verified address, the same way the weekly digest is. No other recipient
                      can be configured.
                    </p>
                  )}

                  <div className="grid sm:grid-cols-2 gap-3">
                    <label className="text-xs font-mono text-[var(--color-text-secondary)]">
                      Notify me when
                      <select
                        value={triggerType}
                        onChange={(e) => setTriggerType(e.target.value)}
                        className="mt-1 w-full bg-[var(--color-surface)] border border-[var(--color-divider)] rounded px-2 py-2 text-sm text-[var(--color-text-primary)]"
                      >
                        {(capabilities?.triggerTypes ?? []).map((t) => (
                          <option key={t} value={t}>
                            {TRIGGER_COPY[t] ?? t}
                          </option>
                        ))}
                      </select>
                    </label>

                    {['entry_tagged', 'entry_mode', 'themes_threshold'].includes(triggerType) ? (
                      <label className="text-xs font-mono text-[var(--color-text-secondary)]">
                        {triggerType === 'themes_threshold'
                          ? 'Minimum theme count'
                          : triggerType === 'entry_mode'
                            ? 'Modes (comma separated)'
                            : 'Tags (comma separated)'}
                        <input
                          value={triggerTags}
                          onChange={(e) => setTriggerTags(e.target.value)}
                          className="mt-1 w-full bg-[var(--color-surface)] border border-[var(--color-divider)] rounded px-2 py-2 text-sm text-[var(--color-text-primary)]"
                        />
                      </label>
                    ) : null}
                  </div>

                  <fieldset className="flex flex-col gap-2">
                    <legend className="text-xs font-mono text-[var(--color-text-secondary)] mb-1">
                      How much may this destination be told?
                    </legend>
                    {(['signal', 'metadata', 'excerpt'] as Tier[]).map((t) => (
                      <label key={t} className="flex items-start gap-2 text-xs cursor-pointer">
                        <input
                          type="radio"
                          name="tier"
                          checked={tier === t}
                          onChange={() => setTier(t)}
                          className="mt-0.5"
                        />
                        <span>
                          <span className="font-medium">{TIER_COPY[t].label}</span>
                          {t === 'signal' ? (
                            <span className="ml-1.5 text-[10px] text-[var(--color-accent)]">
                              recommended
                            </span>
                          ) : null}
                          <span className="block text-[var(--color-text-secondary)]">
                            {TIER_COPY[t].detail}
                          </span>
                        </span>
                      </label>
                    ))}
                  </fieldset>

                  {tier === 'excerpt' ? (
                    <label className="text-xs font-mono text-[var(--color-alert)]">
                      This sends your journal text to a third party. Type{' '}
                      <code>{capabilities?.excerptConsentPhrase}</code> to confirm.
                      <input
                        value={consent}
                        onChange={(e) => setConsent(e.target.value)}
                        className="mt-1 w-full bg-[var(--color-surface)] border border-[var(--color-alert)] rounded px-2 py-2 font-mono text-xs text-[var(--color-text-primary)]"
                      />
                    </label>
                  ) : null}

                  <div className="flex gap-2">
                    <button
                      onClick={addDestination}
                      disabled={busy === 'add'}
                      className="inline-flex items-center gap-2 text-xs font-mono px-4 py-2 rounded bg-[var(--color-accent)] text-[var(--ink-base)] hover:opacity-90 disabled:opacity-50"
                    >
                      {busy === 'add' ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Plus className="w-3.5 h-3.5" />
                      )}
                      Add
                    </button>
                    <button
                      onClick={() => setShowAdd(false)}
                      className="text-xs font-mono px-4 py-2 rounded border border-[var(--color-divider)] hover:bg-[var(--color-surface-elevated)]"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

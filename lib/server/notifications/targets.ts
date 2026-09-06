/**
 * @file lib/server/notifications/targets.ts
 * EXTERNAL NOTIFICATIONS: validation of user-supplied delivery targets.
 *
 * A webhook URL supplied by a user and then fetched by the server is a textbook SSRF
 * primitive. Without validation, "notify my Slack" becomes "make the server GET
 * http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"
 * -- which on Cloud Run would hand an attacker the service credential that this whole
 * architecture depends on.
 *
 * The defence is a strict per-channel HOST ALLOWLIST rather than a denylist of internal
 * ranges. Denylists lose: DNS rebinding, IPv6-mapped IPv4, decimal IP notation, redirects,
 * and newly-introduced cloud metadata endpoints all defeat them. An allowlist of the few
 * hosts that can possibly be correct does not have those failure modes.
 */

import { NotificationChannel } from './types';

/**
 * Hosts permitted per channel. Exact match on the parsed hostname, lowercased.
 * Slack and Discord both publish stable, single-host webhook endpoints.
 */
export const ALLOWED_WEBHOOK_HOSTS: Record<'slack' | 'discord', readonly string[]> = {
  slack: ['hooks.slack.com'],
  discord: ['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'],
};

export class TargetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetValidationError';
  }
}

/**
 * Validates a webhook URL for a channel and returns its canonical form.
 *
 * Enforces, in order: parseable URL, https only, no credentials in the URL, host on the
 * channel's allowlist, and a channel-appropriate path shape.
 */
export function validateWebhookUrl(
  channel: 'slack' | 'discord',
  rawUrl: unknown
): string {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new TargetValidationError('A webhook URL is required.');
  }

  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new TargetValidationError('The webhook URL could not be parsed.');
  }

  // Plaintext http would expose the capability URL to anyone on the path.
  if (url.protocol !== 'https:') {
    throw new TargetValidationError('Webhook URLs must use https.');
  }

  // user:pass@host is a classic allowlist-bypass trick ("https://hooks.slack.com@evil.tld").
  // Parsing already resolves the real host, but rejecting outright is clearer and safer.
  if (url.username || url.password) {
    throw new TargetValidationError('Webhook URLs must not contain credentials.');
  }

  const host = url.hostname.toLowerCase();
  const allowed = ALLOWED_WEBHOOK_HOSTS[channel];
  if (!allowed.includes(host)) {
    throw new TargetValidationError(
      `${host} is not a permitted ${channel} webhook host. Allowed: ${allowed.join(', ')}.`
    );
  }

  if (channel === 'slack' && !url.pathname.startsWith('/services/')) {
    throw new TargetValidationError('A Slack incoming webhook path must begin with /services/.');
  }
  if (channel === 'discord' && !/^\/api\/webhooks\//.test(url.pathname)) {
    throw new TargetValidationError('A Discord webhook path must begin with /api/webhooks/.');
  }

  return url.toString();
}

/**
 * Validates an email destination.
 *
 * Restricted to the user's OWN verified address, matching the weekly digest. Allowing an
 * arbitrary address would turn the notification system into a general-purpose forwarder
 * -- an attacker with a brief session could point it at their own inbox and receive the
 * victim's journal signals indefinitely.
 */
export function validateEmailTarget(
  requested: unknown,
  verifiedOwnAddress: string | null | undefined
): string {
  if (!verifiedOwnAddress) {
    throw new TargetValidationError(
      'No verified email address is associated with this account.'
    );
  }
  const address =
    typeof requested === 'string' && requested.trim()
      ? requested.trim().toLowerCase()
      : verifiedOwnAddress.toLowerCase();

  if (address !== verifiedOwnAddress.toLowerCase()) {
    throw new TargetValidationError(
      'Email notifications may only be sent to your own verified address. ' +
        'To reach another inbox, forward from your own mail client.'
    );
  }
  return address;
}

/**
 * Builds the display form shown in settings and stored on the destination record.
 * Keeps enough to identify the target, drops enough that the record is not itself
 * a usable credential.
 */
export function previewTarget(channel: NotificationChannel, target: string): string {
  if (channel === 'email') {
    const [local, domain] = target.split('@');
    if (!domain) return '•••';
    const head = local.slice(0, 2);
    return `${head}${'•'.repeat(Math.max(1, local.length - 2))}@${domain}`;
  }

  try {
    const url = new URL(target);
    const segments = url.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1] ?? '';
    const shown = last.length > 6 ? `${last.slice(0, 3)}…${last.slice(-3)}` : '•••';
    return `${url.hostname}/…/${shown}`;
  } catch {
    return '•••';
  }
}

/**
 * @file lib/server/notifications/adapters.ts
 * EXTERNAL NOTIFICATIONS: per-channel wire formats.
 *
 * Adapters receive an already-tier-enforced NotificationPayload. They are formatting
 * code and nothing more: an adapter has no access to the TriggerEvent, so it cannot
 * reach past the tier decision to fetch content the user did not authorize.
 *
 * All outbound requests carry a timeout. A hung webhook must not hold a serverless
 * instance open, and must never delay the journal write that triggered it.
 */

import { NotificationChannel, NotificationPayload } from './types';
import { buildRawGmailMessage } from '@/lib/server/digest';
import { refreshAccessToken, sendGmailMessage } from '@/lib/server/gmail';

const DELIVERY_TIMEOUT_MS = 8000;

export class DeliveryError extends Error {
  constructor(
    message: string,
    public status: number,
    /** True when retrying could plausibly succeed (5xx, 429, network). */
    public retryable: boolean
  ) {
    super(message);
    this.name = 'DeliveryError';
  }
}

async function postJson(url: string, body: unknown): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
      // Never follow a redirect: a 302 from an allowlisted host to an internal address
      // would step around the SSRF allowlist enforced at configuration time.
      redirect: 'manual',
    });
  } catch (err) {
    throw new DeliveryError(
      err instanceof Error && err.name === 'AbortError'
        ? 'Delivery timed out.'
        : 'Delivery failed at the network layer.',
      0,
      true
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status >= 300 && res.status < 400) {
    throw new DeliveryError('Webhook responded with a redirect, which is not followed.', res.status, false);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new DeliveryError(
      `Webhook rejected the delivery (HTTP ${res.status}): ${text.slice(0, 200)}`,
      res.status,
      res.status === 429 || res.status >= 500
    );
  }
}

/** Slack incoming webhook: Block Kit with a plain-text fallback. */
export function formatSlack(payload: NotificationPayload): Record<string, unknown> {
  const body = payload.lines.filter(Boolean).join('\n');
  return {
    text: `${payload.title}${body ? ` — ${body.split('\n')[0]}` : ''}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: payload.title, emoji: false } },
      ...(body
        ? [{ type: 'section', text: { type: 'mrkdwn', text: body } }]
        : []),
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Open journal' },
            url: payload.deepLink,
          },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text:
              payload.tier === 'excerpt'
                ? '_Contains a redacted excerpt you enabled for this destination._'
                : '_Contains no journal text._',
          },
        ],
      },
    ],
  };
}

/** Discord webhook: a single embed. */
export function formatDiscord(payload: NotificationPayload): Record<string, unknown> {
  const body = payload.lines.filter(Boolean).join('\n');
  return {
    // Suppress mentions entirely: an excerpt containing "@everyone" must not ping a server.
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: payload.title,
        description: body || undefined,
        url: payload.deepLink,
        footer: {
          text:
            payload.tier === 'excerpt'
              ? 'Contains a redacted excerpt you enabled for this destination.'
              : 'Contains no journal text.',
        },
      },
    ],
  };
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Body for the email channel.
 *
 * The email channel is delivered through GMAIL, from the user's own account to their own
 * verified address -- the same path as the Feature 8 weekly digest. No third-party email
 * vendor is introduced by the notification system.
 */
export function formatEmail(payload: NotificationPayload): {
  subject: string;
  text: string;
  html: string;
} {
  const body = payload.lines.filter(Boolean).join('\n');
  const disclosure =
    payload.tier === 'excerpt'
      ? 'This message contains a redacted excerpt you enabled for this destination.'
      : 'This message contains no journal text.';

  return {
    subject: payload.title,
    text: [
      payload.title,
      '',
      body,
      '',
      `Open your journal: ${payload.deepLink}`,
      '',
      '---',
      disclosure,
    ].join('\n'),
    html: `<!doctype html>
<html>
<body style="margin:0;padding:24px;background:#141821;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#E9E5DD;">
  <div style="max-width:520px;margin:0 auto;background:#1C212B;border:1px solid #2A303C;border-radius:8px;padding:24px;">
    <h1 style="margin:0 0 16px;font-size:16px;font-weight:600;">${escapeHtml(payload.title)}</h1>
    ${
      body
        ? `<pre style="margin:0 0 20px;font-size:13px;line-height:1.6;white-space:pre-wrap;font-family:inherit;">${escapeHtml(body)}</pre>`
        : ''
    }
    <p style="margin:0 0 20px;font-size:13px;">
      <a href="${payload.deepLink}" style="color:#0EA5E9;">Open your journal</a>
    </p>
    <hr style="border:none;border-top:1px solid #2A303C;margin:20px 0;">
    <p style="margin:0;font-size:11px;color:#8D96A5;">${escapeHtml(disclosure)}</p>
  </div>
</body>
</html>`,
  };
}

export interface DeliveryContext {
  channel: NotificationChannel;
  /** Decrypted webhook URL, or the email address for the email channel. */
  target: string;
  /** Gmail refresh token, required only for the email channel. */
  gmailRefreshToken?: string | null;
}

/** Delivers one payload. Throws DeliveryError on failure. */
export async function deliver(
  ctx: DeliveryContext,
  payload: NotificationPayload
): Promise<void> {
  switch (ctx.channel) {
    case 'slack':
      return postJson(ctx.target, formatSlack(payload));

    case 'discord':
      return postJson(ctx.target, formatDiscord(payload));

    case 'email': {
      if (!ctx.gmailRefreshToken) {
        throw new DeliveryError(
          'Email notifications require a connected Gmail grant.',
          400,
          false
        );
      }
      const { subject, text, html } = formatEmail(payload);
      // Reuses the Feature 8 Gmail path: sent from the user's own account to themselves,
      // so the email channel introduces no third-party mail vendor.
      const raw = buildRawGmailMessage(ctx.target, { subject, text, html });
      const accessToken = await refreshAccessToken(ctx.gmailRefreshToken);
      await sendGmailMessage(accessToken, raw);
      return;
    }

    default:
      throw new DeliveryError(`Unsupported channel: ${ctx.channel}`, 400, false);
  }
}

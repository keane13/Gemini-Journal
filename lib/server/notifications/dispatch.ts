/**
 * @file lib/server/notifications/dispatch.ts
 * EXTERNAL NOTIFICATIONS: orchestration from a trigger event to delivered messages.
 *
 * Called fire-and-forget from the journal write path. Two properties matter:
 *
 *   1. IT MUST NEVER BREAK JOURNALING. Every failure is caught and recorded; a broken
 *      Slack webhook must not cost someone their entry.
 *   2. IT MUST NEVER EXCEED THE CONFIGURED TIER. The payload is built once per
 *      destination by payload.ts, which is the only module that reads raw text.
 *
 * An egress record is written for every attempt so the user can audit, after the fact,
 * exactly which third party received what level of detail and when.
 */

import { appUrlFrom } from '@/lib/server/app-url';
import { getGoogleAccessToken } from '@/lib/server/google-auth';
import { getDocument, persistDocument } from '@/lib/server/firestore-rest';
import { DeliveryError, deliver } from './adapters';
import { buildPayload, effectiveTier } from './payload';
import {
  listDestinations,
  loadDestinationSecret,
  recordDeliveryOutcome,
} from './store';
import { shouldNotify } from './triggers';
import { NotificationDestination, TriggerEvent } from './types';

/** Per-user hourly cap across all destinations. Bounds spam and third-party egress. */
export const MAX_NOTIFICATIONS_PER_HOUR = 60;

const recentSends = new Map<string, number[]>();

function withinRateLimit(uid: string): boolean {
  const now = Date.now();
  const hourAgo = now - 3600_000;
  const stamps = (recentSends.get(uid) ?? []).filter((t) => t > hourAgo);

  if (stamps.length >= MAX_NOTIFICATIONS_PER_HOUR) {
    recentSends.set(uid, stamps);
    return false;
  }
  stamps.push(now);
  recentSends.set(uid, stamps);
  return true;
}

/**
 * Appends an egress record. Records WHAT LEVEL was disclosed and to which channel --
 * never the payload itself, which would recreate the content in a second place.
 */
async function recordEgress(
  destination: NotificationDestination,
  event: TriggerEvent,
  outcome: 'success' | 'failure' | 'suppressed',
  detail?: string,
  redactedCategories: string[] = []
): Promise<void> {
  try {
    const token = await getGoogleAccessToken();
    const id = `ntf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await persistDocument(
      `notificationEgress/${destination.uid}_${id}`,
      {
        uid: destination.uid,
        destinationId: destination.id,
        channel: destination.channel,
        targetPreview: destination.targetPreview,
        trigger: event.type,
        entryId: event.entryId,
        tier: effectiveTier(destination),
        redactedCategories,
        outcome,
        detail: detail ?? null,
        at: new Date().toISOString(),
      },
      token
    );
  } catch (err) {
    console.warn('Failed to record notification egress:', err);
  }
}

export interface DispatchResult {
  considered: number;
  delivered: number;
  failed: number;
  suppressed: number;
}

/**
 * Evaluates every destination for a user against one trigger event and delivers matches.
 * Never throws.
 */
export async function dispatchTriggerEvent(
  event: TriggerEvent,
  appUrl: string
): Promise<DispatchResult> {
  const result: DispatchResult = { considered: 0, delivered: 0, failed: 0, suppressed: 0 };

  try {
    const destinations = (await listDestinations(event.uid)).filter(
      (d) => d.enabled && !(d as any).deleted
    );
    result.considered = destinations.length;
    if (destinations.length === 0) return result;

    let gmailRefreshToken: string | null = null;
    const needsGmail = destinations.some((d) => d.channel === 'email');
    if (needsGmail) {
      try {
        const token = await getGoogleAccessToken();
        const doc = await getDocument(`gmailTokens/${event.uid}`, token);
        gmailRefreshToken = (doc as any)?.refreshToken ?? null;
      } catch {
        gmailRefreshToken = null;
      }
    }

    for (const destination of destinations) {
      if (!shouldNotify(destination.triggers ?? [], event)) continue;

      if (!withinRateLimit(event.uid)) {
        result.suppressed += 1;
        await recordEgress(destination, event, 'suppressed', 'hourly rate limit reached');
        continue;
      }

      const payload = buildPayload(destination, event, appUrl);

      try {
        // All channels resolve their target the same way. The email address is not
        // secret, but uniform handling means there is exactly one retrieval path to
        // audit rather than two.
        const target = await loadDestinationSecret(event.uid, destination.id);

        if (!target) {
          throw new DeliveryError('No delivery credential is stored for this destination.', 0, false);
        }

        await deliver(
          { channel: destination.channel, target, gmailRefreshToken },
          payload
        );

        result.delivered += 1;
        await recordDeliveryOutcome(destination, 'success');
        await recordEgress(destination, event, 'success', undefined, payload.redactedCategories);
      } catch (err) {
        result.failed += 1;
        const detail = err instanceof Error ? err.message : 'unknown delivery failure';
        await recordDeliveryOutcome(destination, 'failure');
        await recordEgress(destination, event, 'failure', detail, payload.redactedCategories);
      }
    }
  } catch (err) {
    // A dispatch failure is never allowed to surface into the journal write path.
    console.warn('Notification dispatch failed:', err);
  }

  return result;
}

/** Convenience wrapper used by API routes that already hold a request. */
export function appUrlForDispatch(req: Parameters<typeof appUrlFrom>[0]): string {
  return appUrlFrom(req);
}

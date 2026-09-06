/**
 * @file app/api/notifications/destinations/route.ts
 * EXTERNAL NOTIFICATIONS: destination CRUD.
 *
 * Every operation is scoped to the uid derived from the verified token. A `uid` in the
 * request body is never read, so a caller cannot manage another account's destinations.
 *
 * The `excerpt` payload tier -- the only tier that discloses journal text to a third
 * party -- requires a typed confirmation string in the same request that sets it. This
 * is deliberate friction: escalating disclosure should be a decision, not a toggle
 * someone brushes past.
 */

import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/server/auth';
import { createAuditRecord } from '@/lib/server/audit';
import { getGoogleAccessToken } from '@/lib/server/google-auth';
import { persistDocument } from '@/lib/server/firestore-rest';
import {
  MAX_DESTINATIONS_PER_USER,
  deleteDestination,
  getDestination,
  listDestinations,
  saveDestination,
  saveDestinationSecret,
} from '@/lib/server/notifications/store';
import {
  TargetValidationError,
  previewTarget,
  validateEmailTarget,
  validateWebhookUrl,
} from '@/lib/server/notifications/targets';
import { normalizeTriggerFilter } from '@/lib/server/notifications/triggers';
import { EXCERPT_CONSENT_PHRASE } from '@/lib/server/notifications/consent';
import {
  DEFAULT_PAYLOAD_TIER,
  NOTIFICATION_CHANNELS,
  NotificationChannel,
  NotificationDestination,
  PAYLOAD_TIERS,
  PayloadTier,
  TRIGGER_TYPES,
  TriggerFilter,
} from '@/lib/server/notifications/types';

export const dynamic = 'force-dynamic';

function bad(message: string, code = 'INVALID_REQUEST', status = 400) {
  return NextResponse.json({ error: code, message }, { status });
}

async function requireUser(req: NextRequest) {
  return await authenticateRequest(req);
}

/** Writes a content-free audit record for notification configuration changes. */
async function auditConfigChange(
  req: NextRequest,
  uid: string,
  action: string,
  detail: string
): Promise<void> {
  try {
    const token = await getGoogleAccessToken();
    const base = createAuditRecord(req, action, 'SUCCESS');
    await persistDocument(
      `notificationAudit/${uid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      { ...base, uid, detail },
      token
    );
  } catch (err) {
    console.warn('Notification config audit failed:', err);
  }
}

export async function GET(req: NextRequest) {
  let user;
  try {
    user = await requireUser(req);
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Auth failed.', 'UNAUTHORIZED', 401);
  }

  try {
    const destinations = (await listDestinations(user.uid)).filter((d) => !(d as any).deleted);
    return NextResponse.json({
      destinations,
      capabilities: {
        channels: NOTIFICATION_CHANNELS,
        triggerTypes: TRIGGER_TYPES,
        payloadTiers: PAYLOAD_TIERS,
        defaultPayloadTier: DEFAULT_PAYLOAD_TIER,
        maxDestinations: MAX_DESTINATIONS_PER_USER,
        excerptConsentPhrase: EXCERPT_CONSENT_PHRASE,
      },
      guarantees: {
        neverTriggeredByMoodOrDistress: true,
        defaultTierDisclosesNoJournalContent: true,
        emailChannelSendsViaUsersOwnGmail: true,
        webhookHostsAllowlisted: true,
      },
    });
  } catch (error) {
    return bad(
      error instanceof Error ? error.message : 'Failed to list destinations.',
      'LIST_FAILED',
      500
    );
  }
}

export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireUser(req);
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Auth failed.', 'UNAUTHORIZED', 401);
  }

  try {
    const body = await req.json().catch(() => ({}));

    const channel = body?.channel as NotificationChannel;
    if (!NOTIFICATION_CHANNELS.includes(channel)) {
      return bad(`channel must be one of: ${NOTIFICATION_CHANNELS.join(', ')}.`);
    }

    const existing = (await listDestinations(user.uid)).filter((d) => !(d as any).deleted);
    if (existing.length >= MAX_DESTINATIONS_PER_USER) {
      return bad(
        `At most ${MAX_DESTINATIONS_PER_USER} destinations are permitted per account.`,
        'LIMIT_REACHED',
        409
      );
    }

    // --- Target validation (SSRF allowlist / own-address enforcement) ---
    let target: string;
    try {
      target =
        channel === 'email'
          ? validateEmailTarget(body?.address, user.emailVerified ? user.email : null)
          : validateWebhookUrl(channel, body?.webhookUrl);
    } catch (err) {
      if (err instanceof TargetValidationError) return bad(err.message, 'INVALID_TARGET');
      throw err;
    }

    // --- Triggers ---
    const rawTriggers = Array.isArray(body?.triggers) ? body.triggers : [];
    if (rawTriggers.length === 0) {
      return bad('At least one trigger is required.');
    }
    let triggers;
    try {
      triggers = rawTriggers.slice(0, 10).map(normalizeTriggerFilter);
    } catch (err) {
      return bad(err instanceof Error ? err.message : 'Invalid trigger.', 'INVALID_TRIGGER');
    }

    // --- Payload tier, with consent gate on `excerpt` ---
    const requestedTier: PayloadTier = PAYLOAD_TIERS.includes(body?.payloadTier)
      ? body.payloadTier
      : DEFAULT_PAYLOAD_TIER;

    let excerptConsentAt: string | null = null;
    if (requestedTier === 'excerpt') {
      if (body?.excerptConsent !== EXCERPT_CONSENT_PHRASE) {
        return bad(
          `Sending journal text to a third party requires explicit confirmation. ` +
            `Set excerptConsent to exactly: "${EXCERPT_CONSENT_PHRASE}".`,
          'EXCERPT_CONSENT_REQUIRED',
          403
        );
      }
      excerptConsentAt = new Date().toISOString();
    }

    const id = `dst_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    const destination: NotificationDestination = {
      id,
      uid: user.uid,
      channel,
      label:
        typeof body?.label === 'string' && body.label.trim()
          ? body.label.trim().slice(0, 80)
          : `${channel} destination`,
      enabled: body?.enabled !== false,
      triggers,
      payloadTier: requestedTier,
      targetPreview: previewTarget(channel, target),
      excerptConsentAt,
      createdAt: now,
      updatedAt: now,
      lastDeliveryAt: null,
      lastDeliveryOutcome: null,
      consecutiveFailures: 0,
    };

    await saveDestinationSecret(user.uid, id, target);
    const ok = await saveDestination(destination);
    if (!ok) return bad('Failed to persist the destination.', 'PERSIST_FAILED', 500);

    await auditConfigChange(
      req,
      user.uid,
      'NOTIFICATION_DESTINATION_CREATED',
      `channel=${channel} tier=${requestedTier} ` +
        `triggers=${triggers.map((t: TriggerFilter) => t.type).join('|')}`
    );

    return NextResponse.json({ destination });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create destination.';
    const code = message.startsWith('NOTIFICATION_KEY_UNAVAILABLE')
      ? 'ENCRYPTION_UNAVAILABLE'
      : 'CREATE_FAILED';
    return bad(message, code, 500);
  }
}

export async function PATCH(req: NextRequest) {
  let user;
  try {
    user = await requireUser(req);
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Auth failed.', 'UNAUTHORIZED', 401);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const id = typeof body?.id === 'string' ? body.id.trim() : '';
    if (!id) return bad('id is required.');

    const existing = await getDestination(user.uid, id);
    if (!existing || (existing as any).deleted) {
      return bad('Destination not found.', 'NOT_FOUND', 404);
    }

    const next: NotificationDestination = { ...existing };

    if (typeof body?.enabled === 'boolean') next.enabled = body.enabled;
    if (typeof body?.label === 'string' && body.label.trim()) {
      next.label = body.label.trim().slice(0, 80);
    }

    if (Array.isArray(body?.triggers)) {
      if (body.triggers.length === 0) return bad('At least one trigger is required.');
      try {
        next.triggers = body.triggers.slice(0, 10).map(normalizeTriggerFilter);
      } catch (err) {
        return bad(err instanceof Error ? err.message : 'Invalid trigger.', 'INVALID_TRIGGER');
      }
    }

    if (body?.payloadTier && PAYLOAD_TIERS.includes(body.payloadTier)) {
      // Escalating to `excerpt` always requires a fresh typed confirmation, even if the
      // destination previously held one. De-escalating never does.
      if (body.payloadTier === 'excerpt') {
        if (body?.excerptConsent !== EXCERPT_CONSENT_PHRASE) {
          return bad(
            `Sending journal text to a third party requires explicit confirmation. ` +
              `Set excerptConsent to exactly: "${EXCERPT_CONSENT_PHRASE}".`,
            'EXCERPT_CONSENT_REQUIRED',
            403
          );
        }
        next.excerptConsentAt = new Date().toISOString();
      } else {
        // Dropping below excerpt revokes the consent record, so returning to excerpt
        // later requires confirming again.
        next.excerptConsentAt = null;
      }
      next.payloadTier = body.payloadTier;
    }

    next.updatedAt = new Date().toISOString();

    const ok = await saveDestination(next);
    if (!ok) return bad('Failed to update the destination.', 'PERSIST_FAILED', 500);

    await auditConfigChange(
      req,
      user.uid,
      'NOTIFICATION_DESTINATION_UPDATED',
      `id=${id} tier=${next.payloadTier} enabled=${next.enabled}`
    );

    return NextResponse.json({ destination: next });
  } catch (error) {
    return bad(
      error instanceof Error ? error.message : 'Failed to update destination.',
      'UPDATE_FAILED',
      500
    );
  }
}

export async function DELETE(req: NextRequest) {
  let user;
  try {
    user = await requireUser(req);
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Auth failed.', 'UNAUTHORIZED', 401);
  }

  try {
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return bad('id query parameter is required.');

    const existing = await getDestination(user.uid, id);
    if (!existing) return bad('Destination not found.', 'NOT_FOUND', 404);

    await deleteDestination(user.uid, id);
    await auditConfigChange(req, user.uid, 'NOTIFICATION_DESTINATION_DELETED', `id=${id}`);

    return NextResponse.json({ success: true, id });
  } catch (error) {
    return bad(
      error instanceof Error ? error.message : 'Failed to delete destination.',
      'DELETE_FAILED',
      500
    );
  }
}

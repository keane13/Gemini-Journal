/**
 * @file app/api/notifications/test/route.ts
 * EXTERNAL NOTIFICATIONS: preview and test-send for a configured destination.
 *
 * GET  -> renders the EXACT payload that would be delivered, using the same builder and
 *         the same channel formatter the live dispatcher uses, from synthetic sample data.
 *         Lets a user see precisely what Slack or Discord would receive before enabling.
 * POST -> actually delivers that payload, so the webhook can be verified end to end.
 *
 * The sample event carries obviously-synthetic text, so a preview never discloses a real
 * entry to a destination that is still being configured.
 */

import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/server/auth';
import { appUrlFrom } from '@/lib/server/app-url';
import { getGoogleAccessToken } from '@/lib/server/google-auth';
import { getDocument } from '@/lib/server/firestore-rest';
import { deliver, formatDiscord, formatEmail, formatSlack } from '@/lib/server/notifications/adapters';
import { buildPayload, effectiveTier } from '@/lib/server/notifications/payload';
import { getDestination, loadDestinationSecret } from '@/lib/server/notifications/store';
import { NotificationPayload, TriggerEvent } from '@/lib/server/notifications/types';

export const dynamic = 'force-dynamic';

/**
 * Synthetic event used for previews and test sends.
 * The text is unmistakably sample content, and includes a phone number so the user can
 * see the Privacy Shield masking it at the `excerpt` tier.
 */
function sampleEvent(uid: string): TriggerEvent {
  return {
    uid,
    type: 'entry_created',
    entryId: 'sample_entry',
    occurredAt: new Date().toISOString(),
    mode: 'reflection',
    tags: ['sample', 'preview'],
    commitmentCount: 1,
    themeCount: 3,
    rawText:
      'This is sample text used only to preview notifications. ' +
      'It is not a real journal entry. Call 555-123-4567 to see redaction at work.',
  };
}

function renderForChannel(
  channel: string,
  payload: NotificationPayload
): Record<string, unknown> {
  if (channel === 'slack') return formatSlack(payload);
  if (channel === 'discord') return formatDiscord(payload);
  return formatEmail(payload) as unknown as Record<string, unknown>;
}

export async function GET(req: NextRequest) {
  let user;
  try {
    user = await authenticateRequest(req);
  } catch (err) {
    return NextResponse.json(
      { error: 'UNAUTHORIZED', message: err instanceof Error ? err.message : 'Auth failed.' },
      { status: 401 }
    );
  }

  const id = new URL(req.url).searchParams.get('id');
  if (!id) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'id query parameter is required.' },
      { status: 400 }
    );
  }

  const destination = await getDestination(user.uid, id);
  if (!destination) {
    return NextResponse.json(
      { error: 'NOT_FOUND', message: 'Destination not found.' },
      { status: 404 }
    );
  }

  const payload = buildPayload(destination, sampleEvent(user.uid), appUrlFrom(req));

  return NextResponse.json({
    tier: effectiveTier(destination),
    requestedTier: destination.payloadTier,
    downgraded: effectiveTier(destination) !== destination.payloadTier,
    payload,
    wireFormat: renderForChannel(destination.channel, payload),
    disclosure: {
      containsJournalText: effectiveTier(destination) === 'excerpt',
      redactedCategories: payload.redactedCategories,
      recipient: `${destination.channel} — ${destination.targetPreview}`,
    },
  });
}

export async function POST(req: NextRequest) {
  let user;
  try {
    user = await authenticateRequest(req);
  } catch (err) {
    return NextResponse.json(
      { error: 'UNAUTHORIZED', message: err instanceof Error ? err.message : 'Auth failed.' },
      { status: 401 }
    );
  }

  try {
    const body = await req.json().catch(() => ({}));
    const id = typeof body?.id === 'string' ? body.id.trim() : '';
    if (!id) {
      return NextResponse.json(
        { error: 'INVALID_REQUEST', message: 'id is required.' },
        { status: 400 }
      );
    }

    const destination = await getDestination(user.uid, id);
    if (!destination) {
      return NextResponse.json(
        { error: 'NOT_FOUND', message: 'Destination not found.' },
        { status: 404 }
      );
    }

    const target = await loadDestinationSecret(user.uid, id);
    if (!target) {
      return NextResponse.json(
        { error: 'NO_CREDENTIAL', message: 'No delivery credential is stored for this destination.' },
        { status: 409 }
      );
    }

    let gmailRefreshToken: string | null = null;
    if (destination.channel === 'email') {
      const token = await getGoogleAccessToken();
      const doc = await getDocument(`gmailTokens/${user.uid}`, token);
      gmailRefreshToken = (doc as any)?.refreshToken ?? null;
    }

    const payload = buildPayload(destination, sampleEvent(user.uid), appUrlFrom(req));
    await deliver({ channel: destination.channel, target, gmailRefreshToken }, payload);

    return NextResponse.json({
      success: true,
      tier: effectiveTier(destination),
      note: 'A sample notification was delivered. It contained no real journal content.',
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: 'TEST_SEND_FAILED',
        message: error instanceof Error ? error.message : 'Test delivery failed.',
      },
      { status: 502 }
    );
  }
}

/**
 * @file app/api/digest/settings/route.ts
 * FEATURE 8: Digest opt-in state and live preview.
 *
 * GET  -> current enrollment plus the EXACT email that would be sent, rendered by the
 *         same function the scheduled job uses. The preview is not an approximation.
 * POST -> enable or disable. Off by default: absence of an enrollment document means
 *         disabled, so a user who never opts in is never mailed.
 *
 * Disabling revokes the stored Gmail refresh token, so opting out actually releases the
 * grant rather than merely setting a flag.
 */

import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/server/auth';
import { getGoogleAccessToken } from '@/lib/server/google-auth';
import { getDocument, persistDocument } from '@/lib/server/firestore-rest';
import { buildDigestPayload, renderDigestEmail } from '@/lib/server/digest';
import { readCounters } from '@/lib/server/digest-counters';
import { revokeToken } from '@/lib/server/gmail';
import { appUrlFrom } from '@/lib/server/app-url';

export const dynamic = 'force-dynamic';

export interface DigestEnrollment {
  uid: string;
  enabled: boolean;
  gmailConnected: boolean;
  address: string | null;
  updatedAt: string;
}

async function readEnrollment(uid: string): Promise<DigestEnrollment | null> {
  const token = await getGoogleAccessToken();
  const doc = await getDocument(`digestEnrollment/${uid}`, token);
  return doc ? (doc as unknown as DigestEnrollment) : null;
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

  try {
    const enrollment = await readEnrollment(user.uid).catch(() => null);
    const counters = await readCounters(user.uid).catch(() => ({}));

    // Rendered by the same function the scheduled send uses -- what you see is what is sent.
    const payload = buildDigestPayload(counters);
    const preview = renderDigestEmail(payload, appUrlFrom(req));

    return NextResponse.json({
      enabled: enrollment?.enabled === true,
      gmailConnected: enrollment?.gmailConnected === true,
      address: enrollment?.address ?? user.email ?? null,
      payload,
      preview,
      guarantees: {
        containsEntryText: false,
        containsEntryTitles: false,
        containsModelOutput: false,
        sender: "the user's own Google account",
        thirdPartyEmailVendor: null,
        scope: 'https://www.googleapis.com/auth/gmail.send',
        triggeredByMoodOrDistress: false,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: 'PREVIEW_FAILED',
        message: error instanceof Error ? error.message : 'Failed to build preview.',
      },
      { status: 500 }
    );
  }
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
    if (typeof body?.enabled !== 'boolean') {
      return NextResponse.json(
        { error: 'INVALID_REQUEST', message: 'enabled must be a boolean.' },
        { status: 400 }
      );
    }

    const serviceToken = await getGoogleAccessToken();
    const existing = await readEnrollment(user.uid).catch(() => null);

    if (body.enabled && !existing?.gmailConnected) {
      return NextResponse.json(
        {
          error: 'GMAIL_NOT_CONNECTED',
          message:
            'Connect Gmail send access first. The digest is sent from your own account, ' +
            'so it cannot be enabled without that grant.',
        },
        { status: 409 }
      );
    }

    if (!body.enabled) {
      // Opting out releases the grant rather than merely flipping a flag.
      const tokenDoc = await getDocument(`gmailTokens/${user.uid}`, serviceToken);
      const refreshToken = (tokenDoc as any)?.refreshToken;
      if (typeof refreshToken === 'string' && refreshToken) {
        await revokeToken(refreshToken).catch(() => undefined);
      }
      await persistDocument(
        `gmailTokens/${user.uid}`,
        { refreshToken: null, revokedAt: new Date().toISOString() },
        serviceToken
      );
    }

    const enrollment: DigestEnrollment = {
      uid: user.uid,
      enabled: body.enabled,
      gmailConnected: body.enabled ? true : false,
      address: user.email ?? null,
      updatedAt: new Date().toISOString(),
    };

    await persistDocument(
      `digestEnrollment/${user.uid}`,
      enrollment as unknown as Record<string, unknown>,
      serviceToken
    );

    return NextResponse.json({ success: true, enabled: enrollment.enabled });
  } catch (error) {
    return NextResponse.json(
      {
        error: 'SETTINGS_FAILED',
        message: error instanceof Error ? error.message : 'Failed to update settings.',
      },
      { status: 500 }
    );
  }
}

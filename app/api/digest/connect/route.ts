/**
 * @file app/api/digest/connect/route.ts
 * FEATURE 8: Completes the incremental Gmail OAuth grant.
 *
 * The client obtains an authorization code for the gmail.send scope ALONE, separately
 * from sign-in, and posts it here. The server exchanges it, verifies the granted scope
 * set is not broader than requested, and stores the refresh token at /gmailTokens/{uid}
 * -- a path firestore.rules denies to every client, including the token's own owner.
 *
 * Connecting Gmail does NOT enable the digest. The user must still opt in explicitly.
 */

import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/server/auth';
import { getGoogleAccessToken } from '@/lib/server/google-auth';
import { getDocument, persistDocument } from '@/lib/server/firestore-rest';
import { GMAIL_SEND_SCOPE, GmailError, exchangeCodeForTokens } from '@/lib/server/gmail';

export const dynamic = 'force-dynamic';

/** Advertises the exact scope the client should request. */
export async function GET() {
  return NextResponse.json({
    scope: GMAIL_SEND_SCOPE,
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? null,
    note:
      'Request this scope incrementally, on its own. It permits sending only -- it cannot ' +
      'read, list, or search the mailbox.',
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
    const code = body?.code;
    const redirectUri = body?.redirectUri;

    if (typeof code !== 'string' || !code.trim()) {
      return NextResponse.json(
        { error: 'INVALID_REQUEST', message: 'code is required.' },
        { status: 400 }
      );
    }
    if (typeof redirectUri !== 'string' || !redirectUri.trim()) {
      return NextResponse.json(
        { error: 'INVALID_REQUEST', message: 'redirectUri is required.' },
        { status: 400 }
      );
    }

    const tokens = await exchangeCodeForTokens(code.trim(), redirectUri.trim());

    const serviceToken = await getGoogleAccessToken();

    // Google omits refresh_token on re-consent; keep the one we already hold.
    let refreshToken = tokens.refreshToken;
    if (!refreshToken) {
      const existing = await getDocument(`gmailTokens/${user.uid}`, serviceToken);
      refreshToken = (existing as any)?.refreshToken ?? null;
    }
    if (!refreshToken) {
      throw new GmailError(
        'No refresh token was returned. Re-authorize with prompt=consent and access_type=offline.',
        400
      );
    }

    await persistDocument(
      `gmailTokens/${user.uid}`,
      {
        refreshToken,
        scopes: tokens.grantedScopes,
        address: user.email ?? null,
        connectedAt: new Date().toISOString(),
      },
      serviceToken
    );

    await persistDocument(
      `digestEnrollment/${user.uid}`,
      {
        uid: user.uid,
        // Connecting is not consenting: the digest stays off until explicitly enabled.
        enabled: false,
        gmailConnected: true,
        address: user.email ?? null,
        updatedAt: new Date().toISOString(),
      },
      serviceToken
    );

    return NextResponse.json({
      success: true,
      gmailConnected: true,
      enabled: false,
      grantedScopes: tokens.grantedScopes,
      note: 'Gmail connected. The weekly digest remains off until you turn it on.',
    });
  } catch (error) {
    const status = error instanceof GmailError ? error.status : 500;
    return NextResponse.json(
      {
        error: 'CONNECT_FAILED',
        message: error instanceof Error ? error.message : 'Failed to connect Gmail.',
      },
      { status }
    );
  }
}

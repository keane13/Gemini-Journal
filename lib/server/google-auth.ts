/**
 * @file lib/server/google-auth.ts
 * Acquires Google OAuth2 access tokens for privileged server-side control-plane calls
 * (Identity Toolkit account administration, Secret Manager).
 *
 * Resolution order:
 *   1. Cloud Run / GCE metadata server (production -- no key material on disk).
 *   2. GOOGLE_APPLICATION_CREDENTIALS service-account JSON (local operator scripts).
 *
 * These credentials are NEVER used to read journal content. They exist only to
 * administer accounts (disable, revoke sessions, set role claims). Journal reads
 * always go through the caller's own ID token so Firestore rules apply -- that is
 * what makes the admin console structurally blind.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

async function fetchFromMetadataServer(scope: string): Promise<string | null> {
  try {
    const res = await fetch(
      `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token?scopes=${encodeURIComponent(scope)}`,
      { headers: { 'Metadata-Flavor': 'Google' }, cache: 'no-store' }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.access_token) return null;
    tokenCache.set(scope, {
      token: data.access_token,
      // Refresh a minute early to avoid racing expiry mid-request.
      expiresAt: Date.now() + Math.max(0, (data.expires_in ?? 3600) - 60) * 1000,
    });
    return data.access_token;
  } catch {
    return null;
  }
}

async function fetchFromServiceAccountFile(scope: string): Promise<string | null> {
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credPath) return null;

  let creds: { client_email?: string; private_key?: string; token_uri?: string };
  try {
    creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  } catch {
    return null;
  }
  if (!creds.client_email || !creds.private_key) return null;

  const tokenUri = creds.token_uri || 'https://oauth2.googleapis.com/token';
  const iat = Math.floor(Date.now() / 1000);
  const claim = {
    iss: creds.client_email,
    scope,
    aud: tokenUri,
    exp: iat + 3600,
    iat,
  };

  const signingInput = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(
    JSON.stringify(claim)
  )}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  const assertion = `${signingInput}.${signer.sign(creds.private_key, 'base64url')}`;

  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
    cache: 'no-store',
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data?.access_token) return null;

  tokenCache.set(scope, {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(0, (data.expires_in ?? 3600) - 60) * 1000,
  });
  return data.access_token;
}

/**
 * Returns a cached-or-fresh Google OAuth2 access token for the given scope.
 * Throws when no ambient credential is available, so callers fail closed.
 */
export async function getGoogleAccessToken(
  scope = 'https://www.googleapis.com/auth/cloud-platform'
): Promise<string> {
  const cached = tokenCache.get(scope);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  const token =
    (await fetchFromMetadataServer(scope)) || (await fetchFromServiceAccountFile(scope));

  if (!token) {
    throw new Error(
      'NO_ADMIN_CREDENTIAL: No Google service credential is available. ' +
        'Run on Cloud Run with a service account, or set GOOGLE_APPLICATION_CREDENTIALS.'
    );
  }
  return token;
}

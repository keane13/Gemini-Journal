/**
 * @file lib/server/cron-auth.ts
 * Verifies Cloud Scheduler OIDC identity tokens for scheduled endpoints
 * (Feature 7 aggregate flush, Feature 8 weekly digest).
 *
 * Cloud Scheduler signs a Google ID token for a configured audience and service account.
 * We verify the RS256 signature against Google's published JWKS, then check issuer,
 * audience, expiry, and that the caller's service-account email is the one we expect.
 *
 * Fail-closed: when CRON_OIDC_AUDIENCE and CRON_SERVICE_ACCOUNT_EMAIL are unset, the
 * endpoint is refused rather than left open. A shared-secret path exists ONLY for local
 * development and must be switched on explicitly.
 */

import { NextRequest } from 'next/server';
import * as crypto from 'crypto';

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

interface Jwk {
  kid: string;
  n: string;
  e: string;
  kty: string;
  alg?: string;
}

let cachedJwks: Jwk[] = [];
let jwksExpiry = 0;

async function getJwks(forceRefresh = false): Promise<Jwk[]> {
  const now = Date.now();
  if (!forceRefresh && now < jwksExpiry && cachedJwks.length) return cachedJwks;

  const res = await fetch(JWKS_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Unable to fetch Google JWKS (HTTP ${res.status}).`);
  const data = await res.json();
  cachedJwks = data.keys || [];
  jwksExpiry = now + 3600 * 1000;
  return cachedJwks;
}

export interface CronAuthResult {
  ok: boolean;
  reason?: string;
  serviceAccountEmail?: string;
}

export async function verifyCronRequest(req: NextRequest): Promise<CronAuthResult> {
  const audience = process.env.CRON_OIDC_AUDIENCE;
  const expectedEmail = process.env.CRON_SERVICE_ACCOUNT_EMAIL;

  // Local development escape hatch. Requires an explicit opt-in flag AND a secret,
  // so it can never be enabled by accident in production.
  if (process.env.CRON_ALLOW_SHARED_SECRET === 'true') {
    const provided = req.headers.get('x-cron-secret');
    const expected = process.env.CRON_SHARED_SECRET;
    if (expected && provided && provided.length === expected.length) {
      const match = crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
      if (match) return { ok: true, serviceAccountEmail: 'local-shared-secret' };
    }
    return { ok: false, reason: 'Invalid or missing x-cron-secret.' };
  }

  if (!audience || !expectedEmail) {
    return {
      ok: false,
      reason:
        'Scheduled endpoint is not configured: set CRON_OIDC_AUDIENCE and ' +
        'CRON_SERVICE_ACCOUNT_EMAIL. Refusing by default.',
    };
  }

  const header = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  if (!/^Bearer\s+/i.test(header)) {
    return { ok: false, reason: 'Missing OIDC bearer token.' };
  }
  const token = header.replace(/^Bearer\s+/i, '').trim();

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'Malformed OIDC token.' };
  const [headerB64, payloadB64, signatureB64] = parts;

  let jwtHeader: { kid?: string; alg?: string };
  let payload: { iss?: string; aud?: string; exp?: number; email?: string; email_verified?: boolean };
  try {
    jwtHeader = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'Unparseable OIDC token.' };
  }

  if (jwtHeader.alg !== 'RS256') return { ok: false, reason: 'Unexpected OIDC algorithm.' };
  if (!jwtHeader.kid) return { ok: false, reason: 'OIDC token has no key id.' };

  let keys = await getJwks();
  let jwk = keys.find((k) => k.kid === jwtHeader.kid);
  if (!jwk) {
    keys = await getJwks(true);
    jwk = keys.find((k) => k.kid === jwtHeader.kid);
  }
  if (!jwk) return { ok: false, reason: 'OIDC signing key not published by Google.' };

  const publicKey = crypto.createPublicKey({ key: jwk as unknown as crypto.JsonWebKey, format: 'jwk' });
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(Buffer.from(`${headerB64}.${payloadB64}`));
  if (!verifier.verify(publicKey, Buffer.from(signatureB64, 'base64url'))) {
    return { ok: false, reason: 'OIDC signature verification failed.' };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < nowSeconds - 60) {
    return { ok: false, reason: 'OIDC token expired.' };
  }
  if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') {
    return { ok: false, reason: 'Unexpected OIDC issuer.' };
  }
  if (payload.aud !== audience) {
    return { ok: false, reason: 'OIDC audience mismatch.' };
  }
  if ((payload.email || '').toLowerCase() !== expectedEmail.toLowerCase()) {
    return { ok: false, reason: 'OIDC token was not issued to the expected service account.' };
  }

  return { ok: true, serviceAccountEmail: payload.email };
}

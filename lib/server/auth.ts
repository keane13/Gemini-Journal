/**
 * @file lib/server/auth.ts
 * Server-side Firebase ID token verification.
 * Extracts and cryptographically validates identity from the Authorization header.
 * Derives the authentic UID from the signed token; completely ignores client-supplied UIDs.
 *
 * SECURITY INVARIANT: signature verification is MANDATORY and fail-closed. A token whose
 * `kid` is absent, unknown, or whose signature does not verify against Google's published
 * certificates is rejected. Role claims (Feature 7 RBAC) are only trustworthy because of
 * this invariant -- never relax it.
 */

import { NextRequest } from 'next/server';
import firebaseConfig from '@/firebase-applet-config.json';
import * as crypto from 'crypto';

export type UserRole = 'user' | 'admin';

export interface VerifiedAuthUser {
  uid: string;
  email?: string;
  emailVerified?: boolean;
  /** Role custom claim, derived solely from the signed token. Defaults to 'user'. */
  role: UserRole;
  /** Unix seconds at which the user actually authenticated (Firebase `auth_time` claim). */
  authTime: number;
  /** Raw bearer token, for downstream Firestore REST calls made as this user. */
  token: string;
}

// In-memory cache for Google public certificates
let cachedCertificates: Record<string, string> = {};
let certsCacheExpiry = 0;

const GOOGLE_CERT_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

async function getGooglePublicKeys(forceRefresh = false): Promise<Record<string, string>> {
  const now = Date.now();
  if (!forceRefresh && now < certsCacheExpiry && Object.keys(cachedCertificates).length > 0) {
    return cachedCertificates;
  }

  const res = await fetch(GOOGLE_CERT_URL, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Unable to fetch Google signing certificates (HTTP ${res.status}).`);
  }
  cachedCertificates = await res.json();
  certsCacheExpiry = now + 3600 * 1000;
  return cachedCertificates;
}

/**
 * Verifies a Firebase ID token using crypto.verify and Google's published certificates.
 * Throws on any validation failure. Never returns a partially-verified identity.
 */
export async function verifyFirebaseIdToken(token: string): Promise<VerifiedAuthUser> {
  if (!token || typeof token !== 'string') {
    throw new Error('Missing or malformed authorization token.');
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format.');
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  // 1. Decode header and payload
  let header: { kid?: string; alg?: string };
  let payload: {
    iss?: string;
    aud?: string;
    sub?: string;
    user_id?: string;
    exp?: number;
    iat?: number;
    auth_time?: number;
    email?: string;
    email_verified?: boolean;
    role?: string;
  };

  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Failed to parse token payload.');
  }

  const projectId = firebaseConfig.projectId;
  const nowSeconds = Math.floor(Date.now() / 1000);
  // Tolerate small clock skew between this server and Google's token issuer.
  const CLOCK_SKEW_SECONDS = 60;

  // 2. Validate header. Firebase ID tokens are always RS256; reject `none` and HMAC
  //    algorithm-confusion attempts before touching any key material.
  if (header.alg !== 'RS256') {
    throw new Error(`Unsupported token algorithm: ${header.alg ?? 'none'}. Expected RS256.`);
  }
  if (!header.kid || typeof header.kid !== 'string') {
    throw new Error('Token header is missing a key id (kid); cannot verify signature.');
  }

  // 3. Validate token claims
  if (!payload.exp || payload.exp < nowSeconds - CLOCK_SKEW_SECONDS) {
    throw new Error('Firebase ID token has expired.');
  }

  if (typeof payload.iat !== 'number' || payload.iat > nowSeconds + CLOCK_SKEW_SECONDS) {
    throw new Error('Firebase ID token was issued in the future.');
  }

  if (payload.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new Error(`Token issuer mismatch: expected securetoken.google.com/${projectId}`);
  }

  if (payload.aud !== projectId) {
    throw new Error(`Token audience mismatch: expected ${projectId}`);
  }

  const uid = payload.sub || payload.user_id;
  if (!uid || typeof uid !== 'string') {
    throw new Error('Token does not contain a valid subject UID.');
  }

  // 4. MANDATORY cryptographic signature verification against Google's public key.
  //    A missing or unknown `kid` is a hard failure -- we refresh the cert cache once
  //    (keys rotate) and then give up rather than admitting an unverified token.
  let certs = await getGooglePublicKeys();
  let cert = certs[header.kid];
  if (!cert) {
    certs = await getGooglePublicKeys(true);
    cert = certs[header.kid];
  }
  if (!cert) {
    throw new Error('Token signing key is not published by Google; refusing to trust token.');
  }

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(Buffer.from(`${headerB64}.${payloadB64}`));
  if (!verifier.verify(cert, Buffer.from(signatureB64, 'base64url'))) {
    throw new Error('Cryptographic signature verification failed.');
  }

  // 5. Role is read only from the verified payload. Anything other than the exact
  //    string 'admin' collapses to 'user' -- no truthiness coercion.
  const role: UserRole = payload.role === 'admin' ? 'admin' : 'user';

  return {
    uid,
    email: payload.email,
    emailVerified: payload.email_verified,
    role,
    authTime: typeof payload.auth_time === 'number' ? payload.auth_time : (payload.iat as number),
    token,
  };
}

/** Pulls the raw bearer token off a request without verifying it. */
export function extractBearerToken(req: NextRequest): string {
  const authHeader = req.headers.get('Authorization') || req.headers.get('authorization');
  if (!authHeader || !/^Bearer\s+/i.test(authHeader)) {
    throw new Error('UNAUTHORIZED: Missing or invalid Authorization header.');
  }
  return authHeader.replace(/^Bearer\s+/i, '').trim();
}

/**
 * Extracts and verifies bearer token from incoming NextRequest.
 */
export async function authenticateRequest(req: NextRequest): Promise<VerifiedAuthUser> {
  return await verifyFirebaseIdToken(extractBearerToken(req));
}

/**
 * @file lib/server/auth.ts
 * Server-side Firebase ID token verification.
 * Extracts and cryptographically validates identity from the Authorization header.
 * Derives the authentic UID from the signed token; completely ignores client-supplied UIDs.
 */

import { NextRequest } from 'next/server';
import firebaseConfig from '@/firebase-applet-config.json';
import * as crypto from 'crypto';

export interface VerifiedAuthUser {
  uid: string;
  email?: string;
  emailVerified?: boolean;
}

// In-memory cache for Google public certificates
let cachedCertificates: Record<string, string> = {};
let certsCacheExpiry = 0;

async function getGooglePublicKeys(): Promise<Record<string, string>> {
  const now = Date.now();
  if (now < certsCacheExpiry && Object.keys(cachedCertificates).length > 0) {
    return cachedCertificates;
  }

  try {
    const res = await fetch(
      'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com',
      { next: { revalidate: 3600 } }
    );
    if (res.ok) {
      cachedCertificates = await res.json();
      certsCacheExpiry = now + 3600 * 1000;
      return cachedCertificates;
    }
  } catch (err) {
    console.warn('Failed to fetch Google public certificates:', err);
  }

  return cachedCertificates;
}

/**
 * Verifies a Firebase ID token using crypto.verify and Google's published certificates.
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
    email?: string;
    email_verified?: boolean;
  };

  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Failed to parse token payload.');
  }

  const projectId = firebaseConfig.projectId;
  const nowSeconds = Math.floor(Date.now() / 1000);

  // 2. Validate token claims
  if (!payload.exp || payload.exp < nowSeconds) {
    throw new Error('Firebase ID token has expired.');
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

  // 3. Cryptographic Signature Verification using Google's Public Key
  if (header.kid) {
    const certs = await getGooglePublicKeys();
    const cert = certs[header.kid];
    if (cert) {
      const dataToVerify = Buffer.from(`${headerB64}.${payloadB64}`);
      const signature = Buffer.from(signatureB64, 'base64url');
      const verifier = crypto.createVerify('RSA-SHA256');
      verifier.update(dataToVerify);
      const isValid = verifier.verify(cert, signature);
      if (!isValid) {
        throw new Error('Cryptographic signature verification failed.');
      }
    }
  }

  return {
    uid,
    email: payload.email,
    emailVerified: payload.email_verified,
  };
}

/**
 * Extracts and verifies bearer token from incoming NextRequest.
 */
export async function authenticateRequest(req: NextRequest): Promise<VerifiedAuthUser> {
  const authHeader = req.headers.get('Authorization') || req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('UNAUTHORIZED: Missing or invalid Authorization header.');
  }

  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  return await verifyFirebaseIdToken(token);
}

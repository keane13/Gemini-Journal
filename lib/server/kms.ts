/**
 * @file lib/server/kms.ts
 * FEATURE 11: Envelope encryption for rehydration payloads, keyed by Cloud KMS.
 *
 * WHY ENVELOPE RATHER THAN DIRECT KMS ENCRYPTION
 * The brief asks for "a per-user data key from Cloud KMS". Read literally that could mean
 * one KMS CryptoKey per user, which does not scale: key creation is quota-limited, keys
 * cannot be deleted for 24h+, and a million users would mean a million keys to rotate.
 *
 * The standard construction — and the one implemented here — is envelope encryption:
 *   - a random 256-bit DEK is generated per user,
 *   - that DEK is wrapped by a single KMS CryptoKey and stored wrapped,
 *   - payloads are encrypted locally under the DEK with AES-256-GCM,
 *   - the plaintext DEK exists only in process memory, never on disk.
 *
 * Per-user separation is preserved cryptographically by binding every wrap to the uid as
 * ADDITIONAL AUTHENTICATED DATA. A wrapped DEK stolen from user A's document cannot be
 * unwrapped under user B's uid: KMS itself rejects the mismatch. That is a stronger
 * guarantee than key-per-user would give against the realistic threat (a Firestore read),
 * and it keeps every unwrap in Cloud Audit Logs.
 *
 * KEY ACCESS: the CryptoKey grants only `roles/cloudkms.cryptoKeyEncrypterDecrypter` to
 * the runtime service account. No human principal and no other service holds it, so
 * possession of a Firestore dump is not sufficient to read a rehydration payload.
 */

import * as crypto from 'crypto';
import { getGoogleAccessToken } from '@/lib/server/google-auth';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const DEK_BYTES = 32;

export class KmsError extends Error {
  constructor(
    message: string,
    public code:
      | 'KMS_NOT_CONFIGURED'
      | 'KMS_WRAP_FAILED'
      | 'KMS_UNWRAP_FAILED'
      | 'PAYLOAD_CORRUPT'
  ) {
    super(message);
    this.name = 'KmsError';
  }
}

/** Fully-qualified KMS CryptoKey resource name. */
export function getKmsKeyName(): string | null {
  const explicit = (process.env.KMS_KEY_NAME || '').trim();
  if (explicit) return explicit;

  const project = (process.env.GCP_PROJECT_ID || '').trim();
  const location = (process.env.KMS_LOCATION || 'global').trim();
  const ring = (process.env.KMS_KEY_RING || '').trim();
  const key = (process.env.KMS_CRYPTO_KEY || '').trim();

  if (!project || !ring || !key) return null;
  return `projects/${project}/locations/${location}/keyRings/${ring}/cryptoKeys/${key}`;
}

export function isKmsConfigured(): boolean {
  return getKmsKeyName() !== null;
}

async function kmsCall(
  op: 'encrypt' | 'decrypt',
  body: Record<string, string>
): Promise<any> {
  const keyName = getKmsKeyName();
  if (!keyName) {
    throw new KmsError(
      'Cloud KMS is not configured. Set KMS_KEY_NAME, or GCP_PROJECT_ID + KMS_KEY_RING + ' +
        'KMS_CRYPTO_KEY. Refusing to store a rehydration payload without envelope encryption.',
      'KMS_NOT_CONFIGURED'
    );
  }

  const accessToken = await getGoogleAccessToken();
  const res = await fetch(`https://cloudkms.googleapis.com/v1/${keyName}:${op}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  });

  const text = await res.text();
  if (!res.ok) {
    throw new KmsError(
      `KMS ${op} failed (HTTP ${res.status}): ${text.slice(0, 300)}`,
      op === 'encrypt' ? 'KMS_WRAP_FAILED' : 'KMS_UNWRAP_FAILED'
    );
  }
  return JSON.parse(text);
}

/**
 * Wraps a freshly generated DEK under the KMS key, bound to the uid.
 * Returns the wrapped DEK; the plaintext is returned alongside for immediate use and
 * must never be persisted by the caller.
 */
export async function generateWrappedDek(
  uid: string
): Promise<{ dek: Buffer; wrappedDek: string }> {
  const dek = crypto.randomBytes(DEK_BYTES);
  const data = await kmsCall('encrypt', {
    plaintext: dek.toString('base64'),
    // The binding that makes this per-user: KMS will refuse to unwrap under another uid.
    additionalAuthenticatedData: Buffer.from(uid, 'utf8').toString('base64'),
  });
  return { dek, wrappedDek: data.ciphertext };
}

/** Unwraps a stored DEK. Throws if the uid does not match the one it was wrapped under. */
export async function unwrapDek(uid: string, wrappedDek: string): Promise<Buffer> {
  const data = await kmsCall('decrypt', {
    ciphertext: wrappedDek,
    additionalAuthenticatedData: Buffer.from(uid, 'utf8').toString('base64'),
  });
  return Buffer.from(data.plaintext, 'base64');
}

export interface SealedPayload {
  /** base64 AES-GCM ciphertext */
  ct: string;
  iv: string;
  tag: string;
  v: 1;
}

/** Encrypts a payload under a plaintext DEK. */
export function sealUnderDek(dek: Buffer, plaintext: string): SealedPayload {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, dek, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ct: ct.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    v: 1,
  };
}

/** Decrypts a payload under a plaintext DEK. Throws on tampering. */
export function openUnderDek(dek: Buffer, sealed: SealedPayload): string {
  if (!sealed || sealed.v !== 1 || !sealed.ct || !sealed.iv || !sealed.tag) {
    throw new KmsError('Malformed rehydration payload.', 'PAYLOAD_CORRUPT');
  }
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    dek,
    Buffer.from(sealed.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ct, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

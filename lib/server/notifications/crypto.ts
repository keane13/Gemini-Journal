/**
 * @file lib/server/notifications/crypto.ts
 * EXTERNAL NOTIFICATIONS: application-layer encryption for delivery credentials.
 *
 * A Slack or Discord incoming-webhook URL is a bearer capability: anyone holding the
 * string can post into that channel forever. Firestore already encrypts at rest, but
 * that protects against disk theft, not against an over-privileged read -- and this
 * system has exactly such a credential (`roles/datastore.user`, TRUST_LEDGER caveat C10).
 *
 * Encrypting webhook URLs with a key held in Secret Manager means the Firestore
 * credential alone is not sufficient to steal them: an attacker needs the datastore role
 * AND the secret. That is a meaningful narrowing of caveat C10 for this data class.
 *
 * AES-256-GCM. The IV is random per record and the auth tag is stored alongside, so a
 * tampered ciphertext fails to decrypt rather than decrypting to attacker-chosen bytes.
 */

import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

let cachedKey: Buffer | null = null;

/**
 * Resolves the 32-byte encryption key.
 *
 * Prefers NOTIFICATION_ENCRYPTION_KEY (base64). Falls back to Secret Manager via the
 * ambient service credential. Throws when neither is available, so a misconfigured
 * deployment refuses to store credentials rather than storing them in the clear.
 */
export async function getEncryptionKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;

  const inline = process.env.NOTIFICATION_ENCRYPTION_KEY;
  if (inline && inline.trim()) {
    const key = Buffer.from(inline.trim(), 'base64');
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `NOTIFICATION_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes ` +
          `(got ${key.length}). Generate one with: openssl rand -base64 32`
      );
    }
    cachedKey = key;
    return key;
  }

  const secretName = process.env.GCP_NOTIFICATION_KEY_SECRET_NAME;
  const projectId = process.env.GCP_PROJECT_ID;
  if (secretName && projectId) {
    const { getGoogleAccessToken } = await import('@/lib/server/google-auth');
    const accessToken = await getGoogleAccessToken();
    const res = await fetch(
      `https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets/${secretName}/versions/latest:access`,
      { headers: { Authorization: `Bearer ${accessToken}` }, cache: 'no-store' }
    );
    if (res.ok) {
      const payload = await res.json();
      const decoded = Buffer.from(payload.payload.data, 'base64').toString('utf8').trim();
      const key = Buffer.from(decoded, 'base64');
      if (key.length === KEY_BYTES) {
        cachedKey = key;
        return key;
      }
      throw new Error(
        `Secret ${secretName} must contain a base64-encoded ${KEY_BYTES}-byte key.`
      );
    }
  }

  throw new Error(
    'NOTIFICATION_KEY_UNAVAILABLE: set NOTIFICATION_ENCRYPTION_KEY or ' +
      'GCP_NOTIFICATION_KEY_SECRET_NAME. Refusing to store delivery credentials unencrypted.'
  );
}

export interface SealedSecret {
  /** base64 ciphertext */
  ct: string;
  /** base64 initialisation vector */
  iv: string;
  /** base64 GCM authentication tag */
  tag: string;
  /** Format version, so the scheme can be rotated later. */
  v: 1;
}

export async function sealSecret(plaintext: string): Promise<SealedSecret> {
  const key = await getEncryptionKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ct: ct.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    v: 1,
  };
}

export async function openSecret(sealed: SealedSecret): Promise<string> {
  if (!sealed || sealed.v !== 1 || !sealed.ct || !sealed.iv || !sealed.tag) {
    throw new Error('Malformed sealed credential.');
  }
  const key = await getEncryptionKey();
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(sealed.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ct, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** Test seam: clears the cached key so a test can swap the configured value. */
export function __resetKeyCache(): void {
  cachedKey = null;
}

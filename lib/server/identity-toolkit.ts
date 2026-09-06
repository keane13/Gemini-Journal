/**
 * @file lib/server/identity-toolkit.ts
 * Privileged Firebase Auth control-plane operations (role claims, suspension, session
 * revocation) over the Identity Toolkit REST API.
 *
 * SCOPE BOUNDARY: this module administers ACCOUNTS only. It has no Firestore access and
 * therefore cannot read journal content. Keeping it separate from lib/server/admin.ts
 * also lets operator scripts use it without pulling in the Next.js request runtime.
 */

import firebaseConfig from '@/firebase-applet-config.json';
import { getGoogleAccessToken } from '@/lib/server/google-auth';

export type UserRole = 'user' | 'admin';

const projectId = firebaseConfig.projectId;
const IDENTITY_TOOLKIT = `https://identitytoolkit.googleapis.com/v1/projects/${projectId}`;

export class IdentityToolkitError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
    this.name = 'IdentityToolkitError';
  }
}

async function call(
  method: 'accounts:update' | 'accounts:lookup',
  body: Record<string, unknown>
): Promise<any> {
  const accessToken = await getGoogleAccessToken();
  const res = await fetch(`${IDENTITY_TOOLKIT}/${method}`, {
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
    throw new IdentityToolkitError(
      `Identity Toolkit ${method} failed (HTTP ${res.status}): ${text.slice(0, 400)}`,
      res.status
    );
  }
  return text ? JSON.parse(text) : {};
}

export interface AccountRecord {
  uid: string;
  email?: string;
  emailVerified: boolean;
  disabled: boolean;
  claims: Record<string, unknown>;
  lastRefreshAt?: string;
  createdAt?: string;
}

function toAccountRecord(user: any): AccountRecord {
  let claims: Record<string, unknown> = {};
  if (user?.customAttributes) {
    try {
      claims = JSON.parse(user.customAttributes);
    } catch {
      claims = {};
    }
  }
  return {
    uid: user.localId,
    email: user.email,
    emailVerified: Boolean(user.emailVerified),
    disabled: Boolean(user.disabled),
    claims,
    lastRefreshAt: user.lastRefreshAt,
    createdAt: user.createdAt,
  };
}

/** Looks up an account by uid. Returns null when the account does not exist. */
export async function lookupByUid(uid: string): Promise<AccountRecord | null> {
  const data = await call('accounts:lookup', { localId: [uid] });
  const user = data?.users?.[0];
  return user ? toAccountRecord(user) : null;
}

/** Looks up an account by email address. Returns null when not found. */
export async function lookupByEmail(email: string): Promise<AccountRecord | null> {
  const data = await call('accounts:lookup', { email: [email] });
  const user = data?.users?.[0];
  return user ? toAccountRecord(user) : null;
}

export async function getUserClaims(uid: string): Promise<Record<string, unknown>> {
  const record = await lookupByUid(uid);
  return record?.claims ?? {};
}

/**
 * Revokes all refresh tokens for a uid by advancing `validSince`.
 * Already-issued ID tokens stay valid until they expire (Firebase semantics, max 1h).
 */
export async function revokeSessions(uid: string): Promise<void> {
  await call('accounts:update', {
    localId: uid,
    validSince: String(Math.floor(Date.now() / 1000)),
  });
}

/**
 * Sets the role custom claim. Takes effect on the target's next ID token refresh,
 * so demotion additionally revokes sessions to make it immediate.
 */
export async function setUserRole(uid: string, role: UserRole): Promise<void> {
  const existing = await getUserClaims(uid);
  const next: Record<string, unknown> = { ...existing, role };
  if (role === 'user') {
    delete next.role;
  }
  await call('accounts:update', {
    localId: uid,
    customAttributes: JSON.stringify(next),
  });
  if (role === 'user') {
    await revokeSessions(uid);
  }
}

/** Suspends (disables) or reinstates an account. Suspension also revokes sessions. */
export async function setAccountSuspended(uid: string, suspended: boolean): Promise<void> {
  await call('accounts:update', { localId: uid, disableUser: suspended });
  if (suspended) {
    await revokeSessions(uid);
  }
}

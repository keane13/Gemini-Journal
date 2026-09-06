/**
 * @file lib/server/admin.ts
 * FEATURE 7: Blind Admin Console -- role model, privileged account actions, and audit.
 *
 * DESIGN INVARIANT ("blind administration"):
 *   The admin role grants operational control over ACCOUNTS, never access to CONTENT.
 *   Journal documents live at /users/{uid}/** and firestore.rules gate them exclusively
 *   on `request.auth.uid == userId`. No rule anywhere consults the role claim for those
 *   paths, so an admin token is denied user content by the same mechanism that denies
 *   any other stranger. This module must never introduce a content-reading path, and
 *   must never use the privileged service-account credential to read /users/**.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getGoogleAccessToken } from '@/lib/server/google-auth';
import { authenticateRequest, VerifiedAuthUser } from '@/lib/server/auth';
import { createAuditRecord } from '@/lib/server/audit';
import { persistDocument } from '@/lib/server/firestore-rest';

/**
 * Destructive admin actions require the operator to have authenticated recently.
 * A long-lived stolen ID token is therefore insufficient to suspend accounts.
 */
export const FRESH_AUTH_WINDOW_SECONDS = 5 * 60;

export type AdminErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'STALE_AUTH'
  | 'AUDIT_WRITE_FAILED'
  | 'NO_ADMIN_CREDENTIAL'
  | 'UPSTREAM_ERROR'
  | 'INVALID_REQUEST';

export class AdminError extends Error {
  constructor(
    public code: AdminErrorCode,
    message: string,
    public status: number
  ) {
    super(message);
    this.name = 'AdminError';
  }
}

export function adminErrorResponse(err: unknown): NextResponse {
  if (err instanceof AdminError) {
    return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
  }
  const message = err instanceof Error ? err.message : 'Unexpected admin failure.';
  const code: AdminErrorCode = message.startsWith('NO_ADMIN_CREDENTIAL')
    ? 'NO_ADMIN_CREDENTIAL'
    : 'UPSTREAM_ERROR';
  return NextResponse.json({ error: code, message }, { status: 500 });
}

// ---------------------------------------------------------------------------
// Bootstrap allowlist
// ---------------------------------------------------------------------------

/**
 * Config allowlist used only to bootstrap the very first admin. Membership alone
 * grants nothing: the holder must still present a verified token whose email matches
 * and is verified, and the grant is audited like any other admin action.
 */
export function getBootstrapAdminEmails(): string[] {
  return (process.env.ADMIN_BOOTSTRAP_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isBootstrapAdmin(user: Pick<VerifiedAuthUser, 'email' | 'emailVerified'>): boolean {
  if (!user.email || !user.emailVerified) return false;
  return getBootstrapAdminEmails().includes(user.email.toLowerCase());
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** Verifies the caller and asserts the `admin` role claim. Fails closed. */
export async function requireAdmin(req: NextRequest): Promise<VerifiedAuthUser> {
  let user: VerifiedAuthUser;
  try {
    user = await authenticateRequest(req);
  } catch (err) {
    throw new AdminError(
      'UNAUTHORIZED',
      err instanceof Error ? err.message : 'Authentication failed.',
      401
    );
  }
  if (user.role !== 'admin') {
    throw new AdminError('FORBIDDEN', 'Administrator role is required for this endpoint.', 403);
  }
  return user;
}

/**
 * Asserts the caller authenticated within FRESH_AUTH_WINDOW_SECONDS.
 * Required for destructive actions (suspend, revoke, role changes).
 */
export function requireFreshAuth(user: VerifiedAuthUser): void {
  const ageSeconds = Math.floor(Date.now() / 1000) - user.authTime;
  if (ageSeconds > FRESH_AUTH_WINDOW_SECONDS) {
    throw new AdminError(
      'STALE_AUTH',
      `Re-authentication required. Last sign-in was ${ageSeconds}s ago; ` +
        `destructive actions require authentication within ${FRESH_AUTH_WINDOW_SECONDS}s.`,
      401
    );
  }
}

// ---------------------------------------------------------------------------
// Admin audit ledger (append-only, immutable, content-free)
// ---------------------------------------------------------------------------

export type AdminActionType =
  | 'ADMIN_GRANT_ROLE'
  | 'ADMIN_REVOKE_ROLE'
  | 'ADMIN_SUSPEND_ACCOUNT'
  | 'ADMIN_REINSTATE_ACCOUNT'
  | 'ADMIN_REVOKE_SESSIONS'
  | 'ADMIN_VIEW_METRICS'
  | 'ADMIN_PROVE_BLINDNESS';

export type AdminAuditPhase = 'ATTEMPT' | 'OUTCOME';

/**
 * Appends an immutable admin audit record at /adminAudit/{eventId}.
 *
 * Written with the SERVICE credential, not the admin's ID token. This is deliberate:
 *   - the record is server-authored, so an admin cannot forge or suppress entries about
 *     themselves by manipulating their own token state;
 *   - firestore.rules denies ALL client writes to /adminAudit and allows admins only to
 *     READ it, so the ledger is append-only from the application's perspective;
 *   - the bootstrap grant (caller is not yet an admin) can still be audited.
 *
 * Records carry no journal content: only the actor uid, the action, the target uid,
 * and SHA-256 hashes of IP and User-Agent.
 *
 * Returns false when the append fails; callers treat that as fatal and refuse the action.
 */
export async function writeAdminAudit(
  req: NextRequest,
  actor: VerifiedAuthUser,
  params: {
    action: AdminActionType;
    phase: AdminAuditPhase;
    targetUid?: string;
    outcome: 'SUCCESS' | 'RATE_LIMITED' | 'UNAUTHORIZED' | 'SAFETY_BLOCKED' | 'ERROR';
    detail?: string;
  }
): Promise<boolean> {
  try {
    const base = createAuditRecord(req, params.action, params.outcome);
    const eventId = `adm_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const serviceToken = await getGoogleAccessToken();

    return await persistDocument(
      `adminAudit/${eventId}`,
      {
        ...base,
        phase: params.phase,
        actorUid: actor.uid,
        actorEmail: actor.email ?? null,
        targetUid: params.targetUid ?? null,
        detail: params.detail ?? null,
        authTime: actor.authTime,
      },
      serviceToken
    );
  } catch (err) {
    console.error('Admin audit append failed:', err);
    return false;
  }
}

/**
 * Wraps a privileged action in the mandatory two-phase audit.
 *
 * An immutable ATTEMPT record is appended BEFORE the action runs; if that append
 * fails the action is refused outright (fail closed -- no unaudited admin action).
 * An immutable OUTCOME record is appended afterwards recording success or failure.
 */
export type AuditWriter = typeof writeAdminAudit;

export async function withAdminAudit<T>(
  req: NextRequest,
  actor: VerifiedAuthUser,
  params: { action: AdminActionType; targetUid?: string; detail?: string },
  run: () => Promise<T>,
  /** Injectable for tests; production always uses the real service-credential writer. */
  writeAudit: AuditWriter = writeAdminAudit
): Promise<T> {
  const attempted = await writeAudit(req, actor, {
    ...params,
    phase: 'ATTEMPT',
    outcome: 'SUCCESS',
  });
  if (!attempted) {
    throw new AdminError(
      'AUDIT_WRITE_FAILED',
      'Refusing to perform an unaudited administrative action: audit append failed.',
      500
    );
  }

  try {
    const result = await run();
    await writeAudit(req, actor, { ...params, phase: 'OUTCOME', outcome: 'SUCCESS' });
    return result;
  } catch (err) {
    await writeAudit(req, actor, {
      ...params,
      phase: 'OUTCOME',
      outcome: 'ERROR',
      detail: err instanceof Error ? err.message : 'unknown error',
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Privileged account operations
// ---------------------------------------------------------------------------
// Implemented in lib/server/identity-toolkit.ts so operator scripts can reuse them
// without the Next.js request runtime. Re-exported here as the admin-facing surface.

export {
  getUserClaims,
  setUserRole,
  setAccountSuspended,
  revokeSessions,
  lookupByUid,
  lookupByEmail,
} from '@/lib/server/identity-toolkit';
export type { AccountRecord } from '@/lib/server/identity-toolkit';

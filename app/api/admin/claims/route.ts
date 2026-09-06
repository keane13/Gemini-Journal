/**
 * @file app/api/admin/claims/route.ts
 * FEATURE 7: Role claim administration.
 *
 * Two, and only two, ways to become an admin:
 *   1. BOOTSTRAP -- the caller's own verified, email-verified address appears in the
 *      ADMIN_BOOTSTRAP_EMAILS config allowlist, and they grant themselves.
 *   2. DELEGATION -- an existing admin grants another account.
 *
 * Everything else is denied. In particular a plain user cannot self-grant: the allowlist
 * is server-side config the client cannot influence, and the role is read from the
 * cryptographically verified token, never from the request body.
 */

import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, VerifiedAuthUser } from '@/lib/server/auth';
import {
  AdminError,
  adminErrorResponse,
  isBootstrapAdmin,
  requireFreshAuth,
  setUserRole,
  withAdminAudit,
} from '@/lib/server/admin';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let caller: VerifiedAuthUser;
  try {
    caller = await authenticateRequest(req);
  } catch (err) {
    return NextResponse.json(
      {
        error: 'UNAUTHORIZED',
        message: err instanceof Error ? err.message : 'Authentication failed.',
      },
      { status: 401 }
    );
  }

  try {
    const body = await req.json().catch(() => ({}));
    const role = body?.role;
    if (role !== 'admin' && role !== 'user') {
      throw new AdminError('INVALID_REQUEST', "role must be either 'admin' or 'user'.", 400);
    }

    const targetUid: string =
      typeof body?.targetUid === 'string' && body.targetUid.trim()
        ? body.targetUid.trim()
        : caller.uid;

    const isSelf = targetUid === caller.uid;
    const bootstrapping = isSelf && role === 'admin' && isBootstrapAdmin(caller);

    if (!bootstrapping && caller.role !== 'admin') {
      // The decisive check: a non-admin off the allowlist cannot grant anyone,
      // themselves included.
      throw new AdminError(
        'FORBIDDEN',
        'Only an existing administrator, or an allowlisted bootstrap account granting ' +
          'itself, may change role claims.',
        403
      );
    }

    // Role changes are privileged; require a recent interactive sign-in.
    requireFreshAuth(caller);

    // An admin demoting themselves is permitted, but never as an accident of delegation.
    if (isSelf && role === 'user' && caller.role === 'admin' && body?.confirmSelfDemotion !== true) {
      throw new AdminError(
        'INVALID_REQUEST',
        'Self-demotion requires confirmSelfDemotion: true.',
        400
      );
    }

    await withAdminAudit(
      req,
      caller,
      {
        action: role === 'admin' ? 'ADMIN_GRANT_ROLE' : 'ADMIN_REVOKE_ROLE',
        targetUid,
        detail: bootstrapping ? 'bootstrap-from-allowlist' : 'delegated-by-admin',
      },
      () => setUserRole(targetUid, role)
    );

    return NextResponse.json({
      success: true,
      targetUid,
      role,
      bootstrapped: bootstrapping,
      note: 'The new claim takes effect on the target account\'s next ID token refresh.',
    });
  } catch (err) {
    return adminErrorResponse(err);
  }
}

/** Reports the caller's own effective role, for client-side console gating. */
export async function GET(req: NextRequest) {
  try {
    const caller = await authenticateRequest(req);
    return NextResponse.json({
      uid: caller.uid,
      role: caller.role,
      authTime: caller.authTime,
      bootstrapEligible: isBootstrapAdmin(caller),
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: 'UNAUTHORIZED',
        message: err instanceof Error ? err.message : 'Authentication failed.',
      },
      { status: 401 }
    );
  }
}

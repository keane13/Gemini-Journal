/**
 * @file app/api/admin/actions/route.ts
 * FEATURE 7: Destructive account actions available to administrators.
 *
 * Admins may suspend an account, reinstate it, and revoke its sessions. Admins may NOT
 * read, search, or export any journal content -- there is no such action here, and no
 * code path in this file constructs a /users/** read.
 *
 * Every action requires:
 *   - a verified token carrying role == 'admin';
 *   - a FRESH auth_time (recent interactive sign-in), so a stolen long-lived token
 *     cannot suspend accounts;
 *   - a successful immutable audit append BEFORE the action runs (fail closed).
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  AdminError,
  adminErrorResponse,
  requireAdmin,
  requireFreshAuth,
  revokeSessions,
  setAccountSuspended,
  withAdminAudit,
} from '@/lib/server/admin';

export const dynamic = 'force-dynamic';

type Action = 'suspend' | 'reinstate' | 'revoke_sessions';

const ACTION_AUDIT = {
  suspend: 'ADMIN_SUSPEND_ACCOUNT',
  reinstate: 'ADMIN_REINSTATE_ACCOUNT',
  revoke_sessions: 'ADMIN_REVOKE_SESSIONS',
} as const;

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin(req);

    const body = await req.json().catch(() => ({}));
    const action: Action = body?.action;
    const targetUid: unknown = body?.targetUid;

    if (action !== 'suspend' && action !== 'reinstate' && action !== 'revoke_sessions') {
      throw new AdminError(
        'INVALID_REQUEST',
        "action must be one of 'suspend', 'reinstate', 'revoke_sessions'.",
        400
      );
    }
    if (typeof targetUid !== 'string' || !targetUid.trim()) {
      throw new AdminError('INVALID_REQUEST', 'targetUid is required.', 400);
    }
    if (targetUid === admin.uid && action === 'suspend') {
      throw new AdminError('INVALID_REQUEST', 'An administrator cannot suspend themselves.', 400);
    }

    // Destructive: demand a recent sign-in, not merely a valid session.
    requireFreshAuth(admin);

    await withAdminAudit(
      req,
      admin,
      { action: ACTION_AUDIT[action], targetUid, detail: `action=${action}` },
      async () => {
        if (action === 'suspend') return setAccountSuspended(targetUid, true);
        if (action === 'reinstate') return setAccountSuspended(targetUid, false);
        return revokeSessions(targetUid);
      }
    );

    return NextResponse.json({
      success: true,
      action,
      targetUid,
      note:
        action === 'revoke_sessions'
          ? 'Refresh tokens revoked. Existing ID tokens expire within the hour.'
          : undefined,
    });
  } catch (err) {
    return adminErrorResponse(err);
  }
}

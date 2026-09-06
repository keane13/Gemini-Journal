/**
 * @file app/api/admin/prove/route.ts
 * FEATURE 7: The "Prove it" affordance.
 *
 * Live-executes a real read of a real user's journal entries using the ADMIN'S OWN
 * ID token against the real Firestore REST API, and returns the verbatim upstream
 * status and error body. Nothing here is mocked, stubbed, or synthesized.
 *
 * The response contains two probes:
 *
 *   TARGET  -- GET /users/{targetUid}/entries with the admin's token.
 *              Expected: HTTP 403 PERMISSION_DENIED, because firestore.rules gates
 *              /users/{userId}/** solely on request.auth.uid == userId. The admin role
 *              claim is not consulted anywhere in those rules.
 *
 *   CONTROL -- GET /users/{adminUid}/entries with the SAME token.
 *              Expected: HTTP 200. This is what makes the demo honest: it shows the
 *              token is valid and Firestore is reachable, so the denial above is a real
 *              authorization decision rather than an expired token or a network error.
 *
 * The verdict is computed from the actual HTTP statuses observed, not asserted.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  AdminError,
  adminErrorResponse,
  getUserClaims,
  requireAdmin,
  writeAdminAudit,
} from '@/lib/server/admin';
import { rawGetDocument } from '@/lib/server/firestore-rest';

export const dynamic = 'force-dynamic';

/** Trims a Firestore error body to something displayable without losing the error code. */
function summarize(body: string): { status?: string; message?: string; raw: string } {
  const raw = body.slice(0, 1200);
  try {
    const parsed = JSON.parse(body);
    return {
      status: parsed?.error?.status,
      message: parsed?.error?.message,
      raw,
    };
  } catch {
    return { raw };
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin(req);

    const body = await req.json().catch(() => ({}));
    const targetUid: unknown = body?.targetUid;
    if (typeof targetUid !== 'string' || !targetUid.trim()) {
      throw new AdminError(
        'INVALID_REQUEST',
        'targetUid is required: the proof must be attempted against a real account.',
        400
      );
    }
    if (targetUid === admin.uid) {
      throw new AdminError(
        'INVALID_REQUEST',
        'Choose an account other than your own; reading your own entries is permitted ' +
          'and would not demonstrate anything.',
        400
      );
    }

    // Confirm the target is a real account via the auth control plane (no content read).
    let targetExists = false;
    try {
      await getUserClaims(targetUid);
      targetExists = true;
    } catch {
      targetExists = false;
    }

    const entryId =
      typeof body?.entryId === 'string' && body.entryId.trim() ? body.entryId.trim() : null;
    const targetPath = entryId
      ? `users/${targetUid}/entries/${entryId}`
      : `users/${targetUid}/entries`;

    // Both probes are real network calls to Firestore, made with the admin's own token.
    const [target, control] = await Promise.all([
      rawGetDocument(targetPath, admin.token),
      rawGetDocument(`users/${admin.uid}/entries`, admin.token),
    ]);

    const targetSummary = summarize(target.body);
    const controlSummary = summarize(control.body);

    const denied = target.status === 403 || targetSummary.status === 'PERMISSION_DENIED';
    const controlOk = control.ok;

    const verdict = denied && controlOk ? 'BLIND_CONFIRMED' : denied ? 'DENIED_BUT_CONTROL_FAILED' : 'UNEXPECTED_ACCESS';

    await writeAdminAudit(req, admin, {
      action: 'ADMIN_PROVE_BLINDNESS',
      phase: 'OUTCOME',
      outcome: verdict === 'UNEXPECTED_ACCESS' ? 'ERROR' : 'SUCCESS',
      targetUid,
      detail: `verdict=${verdict} targetStatus=${target.status} controlStatus=${control.status}`,
    });

    return NextResponse.json({
      verdict,
      targetExists,
      explanation:
        verdict === 'BLIND_CONFIRMED'
          ? 'Firestore refused this administrator read of another account\'s journal entries, ' +
            'while the same token read the administrator\'s own entries successfully. The console is blind.'
          : verdict === 'UNEXPECTED_ACCESS'
            ? 'SECURITY REGRESSION: the administrator token was NOT denied. Investigate firestore.rules immediately.'
            : 'The read was denied, but the control probe did not succeed, so this run does not ' +
              'prove the denial was an authorization decision. Re-run with a valid session.',
      probes: {
        target: {
          label: 'Admin reads another user\'s journal entries',
          method: 'GET',
          url: target.url,
          attributedTo: `admin uid ${admin.uid} (role=admin)`,
          httpStatus: target.status,
          firestoreStatus: targetSummary.status ?? null,
          message: targetSummary.message ?? null,
          rawResponse: targetSummary.raw,
          expected: 'HTTP 403 PERMISSION_DENIED',
          passed: denied,
        },
        control: {
          label: 'Same token reads the admin\'s own journal entries',
          method: 'GET',
          url: control.url,
          attributedTo: `admin uid ${admin.uid} (role=admin)`,
          httpStatus: control.status,
          firestoreStatus: controlSummary.status ?? null,
          rawResponse: controlSummary.raw.slice(0, 400),
          expected: 'HTTP 200 OK -- proves the token is valid and Firestore is reachable',
          passed: controlOk,
        },
      },
      whyItFails:
        'firestore.rules matches /users/{userId}/entries/** and requires request.auth.uid == userId. ' +
        'No rule on that subtree consults request.auth.token.role, so an admin claim confers ' +
        'no read access to journal content.',
    });
  } catch (err) {
    return adminErrorResponse(err);
  }
}

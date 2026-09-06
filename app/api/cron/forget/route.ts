/**
 * @file app/api/cron/forget/route.ts
 * FEATURE 11: The scheduled forgetting job.
 *
 * Walks every user's retention policy and destroys the rehydration payload of any entry
 * past its window. Triggered by Cloud Scheduler with an OIDC identity token.
 *
 * SCOPE DISCIPLINE — this job is destructive, so what it must NOT do matters as much as
 * what it does:
 *   - it writes exactly one field per entry (`rehydration: null`, plus the tombstone
 *     dates); it never touches the body, title, mood, commitments, chunks, or messages,
 *   - it skips `never` policies entirely,
 *   - it skips entries that are not yet past their window,
 *   - it skips entries that have no payload, so a second run is a no-op rather than a
 *     second write.
 *
 * The entry remains fully readable and fully searchable afterwards. Only the details go.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyCronRequest } from '@/lib/server/cron-auth';
import { getGoogleAccessToken } from '@/lib/server/google-auth';
import { getDocument, listDocuments, persistDocument } from '@/lib/server/firestore-rest';
import {
  DEFAULT_RETENTION,
  isEligibleForForgetting,
  isValidRetention,
  normalizeRetentionPolicy,
} from '@/lib/server/retention';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

interface ForgetOutcome {
  uid: string;
  scanned: number;
  forgotten: number;
  skippedNever: number;
  errors: number;
}

export async function POST(req: NextRequest) {
  const auth = await verifyCronRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ error: 'UNAUTHORIZED', message: auth.reason }, { status: 401 });
  }

  const now = new Date();
  const outcomes: ForgetOutcome[] = [];

  try {
    const serviceToken = await getGoogleAccessToken();

    // The set of users with a data key is the set of users who have ever had a payload.
    const keyed = await listDocuments('userDataKeys', serviceToken, 1000);

    for (const record of keyed) {
      const uid = (record.uid as string) || record.id;
      const outcome: ForgetOutcome = {
        uid,
        scanned: 0,
        forgotten: 0,
        skippedNever: 0,
        errors: 0,
      };

      try {
        const policyDoc = await getDocument(`users/${uid}/settings/retention`, serviceToken);
        const policy = normalizeRetentionPolicy(policyDoc);

        const entries = await listDocuments(`users/${uid}/entries`, serviceToken, 1000);
        outcome.scanned = entries.length;

        for (const entry of entries) {
          // Nothing to destroy: a second run over the same entry is a no-op.
          if (!entry.rehydration) continue;

          // An entry carries the window that was in force when it was written, so
          // changing the policy later does not retroactively extend an old entry.
          const window = isValidRetention(entry.retentionWindow)
            ? entry.retentionWindow
            : (policy.window ?? DEFAULT_RETENTION);

          if (window === 'never') {
            outcome.skippedNever += 1;
            continue;
          }
          if (!isEligibleForForgetting(entry.createdAt ?? '', window, now)) continue;

          try {
            const ok = await persistDocument(
              `users/${uid}/entries/${entry.id}`,
              {
                ...entry,
                // The single destructive write. Overwritten in place, not archived.
                rehydration: null,
                forgottenAt: now.toISOString(),
                retentionWindow: window,
              },
              serviceToken
            );
            if (ok) outcome.forgotten += 1;
            else outcome.errors += 1;
          } catch {
            outcome.errors += 1;
          }
        }
      } catch (err) {
        console.warn(`Forgetting sweep failed for ${uid}:`, err);
        outcome.errors += 1;
      }

      outcomes.push(outcome);
    }

    return NextResponse.json({
      success: true,
      at: now.toISOString(),
      usersScanned: outcomes.length,
      totalForgotten: outcomes.reduce((a, o) => a + o.forgotten, 0),
      outcomes,
    });
  } catch (error) {
    console.error('Forgetting job failed:', error);
    return NextResponse.json(
      {
        error: 'FORGET_JOB_FAILED',
        message: error instanceof Error ? error.message : 'unknown',
        outcomes,
      },
      { status: 500 }
    );
  }
}

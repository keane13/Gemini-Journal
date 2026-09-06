/**
 * @file app/api/cron/digest/route.ts
 * FEATURE 8: Scheduled weekly digest send.
 *
 * Triggered by Cloud Scheduler with an OIDC identity token (verified in
 * lib/server/cron-auth.ts). Idempotent per (uid, isoWeek): a claim document is written
 * at /digestSends/{uid}_{isoWeek} BEFORE sending, and a pre-existing claim short-circuits
 * the send, so a retried or duplicated schedule cannot mail anyone twice.
 *
 * RECIPIENT SELECTION IS SCHEDULE-DRIVEN ONLY.
 * Recipients are chosen solely by enrollment (enabled === true). Nothing in this file
 * reads a mood score, sentiment, or any distress signal, and no branch here can be
 * reached by such a signal. The digest is a calendar event, never a reaction to what
 * someone wrote.
 *
 * The job reads /digestEnrollment, /digestCounters, and /gmailTokens. It never reads
 * /users/** -- no entry, message, chunk, insight, or commitment text is loaded.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyCronRequest } from '@/lib/server/cron-auth';
import { getGoogleAccessToken } from '@/lib/server/google-auth';
import { getDocument, listDocuments, persistDocument } from '@/lib/server/firestore-rest';
import {
  buildDigestPayload,
  buildRawGmailMessage,
  isoWeekOf,
  renderDigestEmail,
} from '@/lib/server/digest';
import { readCounters } from '@/lib/server/digest-counters';
import { refreshAccessToken, sendGmailMessage } from '@/lib/server/gmail';
import { appUrlFrom } from '@/lib/server/app-url';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

interface SendOutcome {
  uid: string;
  status: 'sent' | 'skipped_already_sent' | 'skipped_not_enrolled' | 'error';
  detail?: string;
}

export async function POST(req: NextRequest) {
  const auth = await verifyCronRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ error: 'UNAUTHORIZED', message: auth.reason }, { status: 401 });
  }

  const now = new Date();
  const isoWeek = isoWeekOf(now);
  const appUrl = appUrlFrom(req);
  const results: SendOutcome[] = [];

  try {
    const serviceToken = await getGoogleAccessToken();
    const enrollments = await listDocuments('digestEnrollment', serviceToken, 500);

    for (const enrollment of enrollments) {
      const uid = (enrollment.uid as string) || enrollment.id;

      // Selection is by enrollment alone -- never by anything the user wrote.
      if (enrollment.enabled !== true || enrollment.gmailConnected !== true) {
        results.push({ uid, status: 'skipped_not_enrolled' });
        continue;
      }

      const claimPath = `digestSends/${uid}_${isoWeek}`;

      try {
        // Idempotency claim: if a record for this (uid, isoWeek) exists, do nothing.
        const existingClaim = await getDocument(claimPath, serviceToken);
        if (existingClaim) {
          results.push({ uid, status: 'skipped_already_sent' });
          continue;
        }

        await persistDocument(
          claimPath,
          { uid, isoWeek, claimedAt: now.toISOString(), status: 'claimed' },
          serviceToken
        );

        const tokenDoc = await getDocument(`gmailTokens/${uid}`, serviceToken);
        const refreshToken = (tokenDoc as any)?.refreshToken;
        const address = (enrollment.address as string) || (tokenDoc as any)?.address;

        if (!refreshToken || !address) {
          await persistDocument(
            claimPath,
            { uid, isoWeek, status: 'error', detail: 'missing gmail grant', at: now.toISOString() },
            serviceToken
          );
          results.push({ uid, status: 'error', detail: 'missing gmail grant' });
          continue;
        }

        // Built from counters only. No journal content is loaded anywhere in this path.
        const payload = buildDigestPayload(await readCounters(uid), now);
        const email = renderDigestEmail(payload, appUrl);
        const raw = buildRawGmailMessage(address, email);

        const accessToken = await refreshAccessToken(refreshToken);
        const messageId = await sendGmailMessage(accessToken, raw);

        await persistDocument(
          claimPath,
          {
            uid,
            isoWeek,
            status: 'sent',
            sentAt: new Date().toISOString(),
            gmailMessageId: messageId,
            // Counts only -- retained so a user can audit what was sent about them.
            entriesWritten: payload.entriesWritten,
            recurringThemeCount: payload.recurringThemeCount,
            overdueCommitmentCount: payload.overdueCommitmentCount,
            moodDirection: payload.moodDirection,
          },
          serviceToken
        );

        results.push({ uid, status: 'sent' });
      } catch (err) {
        const detail = err instanceof Error ? err.message : 'unknown error';
        await persistDocument(
          claimPath,
          { uid, isoWeek, status: 'error', detail, at: new Date().toISOString() },
          serviceToken
        ).catch(() => undefined);
        results.push({ uid, status: 'error', detail });
      }
    }

    return NextResponse.json({
      success: true,
      isoWeek,
      considered: enrollments.length,
      sent: results.filter((r) => r.status === 'sent').length,
      results,
    });
  } catch (error) {
    console.error('Weekly digest run failed:', error);
    return NextResponse.json(
      {
        error: 'DIGEST_RUN_FAILED',
        message: error instanceof Error ? error.message : 'unknown',
        isoWeek,
        results,
      },
      { status: 500 }
    );
  }
}

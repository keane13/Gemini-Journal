/**
 * @file app/api/retention/settings/route.ts
 * FEATURE 11: Retention policy.
 *
 * Lengthening a window is routine. SHORTENING one destroys data immediately — every
 * payload that falls outside the new window is forgotten in the same request — so it
 * requires a typed confirmation, and the response reports exactly how many entries were
 * destroyed rather than leaving the user to discover it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, extractBearerToken } from '@/lib/server/auth';
import { createAuditRecord } from '@/lib/server/audit';
import { getGoogleAccessToken } from '@/lib/server/google-auth';
import { listDocuments, persistDocument } from '@/lib/server/firestore-rest';
import { isKmsConfigured } from '@/lib/server/kms';
import {
  MINIMUM_RETENTION_DAYS,
  RETENTION_OPTIONS,
  RetentionWindow,
  isEligibleForForgetting,
  isValidRetention,
  readRetentionPolicy,
  SHORTEN_CONFIRM_PHRASE,
  writeRetentionPolicy,
} from '@/lib/server/retention';

export const dynamic = 'force-dynamic';

function windowDays(w: RetentionWindow): number {
  return w === 'never' ? Number.POSITIVE_INFINITY : w;
}

export async function GET(req: NextRequest) {
  let user;
  let token: string;
  try {
    token = extractBearerToken(req);
    user = await authenticateRequest(req);
  } catch (err) {
    return NextResponse.json(
      { error: 'UNAUTHORIZED', message: err instanceof Error ? err.message : 'Auth failed.' },
      { status: 401 }
    );
  }

  const policy = await readRetentionPolicy(user.uid, token);

  return NextResponse.json({
    policy,
    options: RETENTION_OPTIONS,
    minimumDays: MINIMUM_RETENTION_DAYS,
    kmsConfigured: isKmsConfigured(),
    shortenConfirmPhrase: SHORTEN_CONFIRM_PHRASE,
    copy: {
      what:
        'Your entries always store the redacted text. The personal details live in a ' +
        'separate encrypted payload, and this setting decides how long that payload is ' +
        'kept before it is destroyed.',
      afterwards:
        'After the window elapses the entry stays fully readable and fully searchable — ' +
        'only the details are gone: "Dia minta aku follow up ke [EMAIL_1]".',
      retrieval:
        'Recall and Patterns operate on the redacted text either way, so forgetting never ' +
        'degrades search or insight quality. Nothing gets worse when the details go.',
      irreversible:
        'Forgetting is irreversible by design. The plaintext is never stored anywhere ' +
        'else, so there is no archive, no backup copy, and no administrator who can ' +
        'recover it — including us.',
    },
  });
}

export async function POST(req: NextRequest) {
  let user;
  let token: string;
  try {
    token = extractBearerToken(req);
    user = await authenticateRequest(req);
  } catch (err) {
    return NextResponse.json(
      { error: 'UNAUTHORIZED', message: err instanceof Error ? err.message : 'Auth failed.' },
      { status: 401 }
    );
  }

  try {
    const body = await req.json().catch(() => ({}));
    const next = body?.window;

    if (!isValidRetention(next)) {
      return NextResponse.json(
        {
          error: 'INVALID_REQUEST',
          message: `window must be one of: ${RETENTION_OPTIONS.join(', ')}.`,
        },
        { status: 400 }
      );
    }

    const current = await readRetentionPolicy(user.uid, token);
    const shortening = windowDays(next) < windowDays(current.window);

    if (shortening && body?.confirm !== SHORTEN_CONFIRM_PHRASE) {
      return NextResponse.json(
        {
          error: 'SHORTEN_CONFIRM_REQUIRED',
          message:
            `Shortening the window destroys details immediately and permanently. ` +
            `Set confirm to exactly: "${SHORTEN_CONFIRM_PHRASE}".`,
          from: current.window,
          to: next,
        },
        { status: 403 }
      );
    }

    const ok = await writeRetentionPolicy(user.uid, token, next);
    if (!ok) {
      return NextResponse.json(
        { error: 'PERSIST_FAILED', message: 'Failed to save the retention policy.' },
        { status: 500 }
      );
    }

    /**
     * Shortening applies at once rather than waiting for the nightly job. A user who has
     * just decided their details should be gone is entitled to have them gone now, not
     * up to a day later.
     */
    let forgotten = 0;
    if (shortening && next !== 'never') {
      const serviceToken = await getGoogleAccessToken();
      const entries = await listDocuments(`users/${user.uid}/entries`, token, 500);

      for (const entry of entries) {
        if (!entry.rehydration) continue;
        if (!isEligibleForForgetting(entry.createdAt ?? '', next)) continue;

        const destroyed = await persistDocument(
          `users/${user.uid}/entries/${entry.id}`,
          {
            ...entry,
            // Overwritten, not moved: there is nowhere for the ciphertext to survive.
            rehydration: null,
            retentionWindow: next,
            forgottenAt: new Date().toISOString(),
          },
          serviceToken
        );
        if (destroyed) forgotten += 1;
      }
    }

    const audit = createAuditRecord(req, 'RETENTION_POLICY_CHANGED', 'SUCCESS');
    await persistDocument(
      `users/${user.uid}/audit/audit_retention_${Date.now()}`,
      { ...audit, from: String(current.window), to: String(next), forgottenNow: forgotten },
      token
    );

    return NextResponse.json({
      policy: { window: next, updatedAt: new Date().toISOString() },
      shortened: shortening,
      forgottenNow: forgotten,
      note: shortening
        ? `${forgotten} ${forgotten === 1 ? 'entry has' : 'entries have'} had their details destroyed. This cannot be undone.`
        : undefined,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: 'RETENTION_UPDATE_FAILED',
        message: error instanceof Error ? error.message : 'Failed to update retention.',
      },
      { status: 500 }
    );
  }
}

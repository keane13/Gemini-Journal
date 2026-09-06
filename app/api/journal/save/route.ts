/**
 * @file app/api/journal/save/route.ts
 * "Save without reply" — write an entry without asking the model to respond.
 *
 * The model is optional, not a toll gate. An entry saved here is a FIRST-CLASS entry:
 * it is titled, embedded for semantic recall, and included in Patterns and Commitments.
 * The only thing it lacks is a reflection turn.
 *
 * DESIGN NOTE ON EGRESS: the title is derived locally from the user's own first line, so
 * saving without a reply makes no generative call at all. The only upstream request is
 * the embedding needed for recall, and it is made on the REDACTED text — the same
 * Privacy Shield boundary every other egress path crosses. Saving quietly therefore
 * discloses strictly less than reflecting does, which is the behaviour a user choosing
 * this button is entitled to assume.
 */

import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, extractBearerToken } from '@/lib/server/auth';
import { checkRateLimit } from '@/lib/server/rate-limit';
import { runPrivacyShield, PrivacyMode } from '@/lib/server/redaction';
import { persistDocument } from '@/lib/server/firestore-rest';
import { createAuditRecord } from '@/lib/server/audit';
import { recordMetric } from '@/lib/server/metrics';
import { recordEntryWritten } from '@/lib/server/digest-counters';
import { readLocationSettings } from '@/lib/server/location-settings';
import { dispatchTriggerEvent } from '@/lib/server/notifications/dispatch';
import { appUrlFrom } from '@/lib/server/app-url';
import { LIMITS } from '@/lib/config';
import { deriveTitle } from '@/lib/server/entry-title';
import {
  computeRetentionState,
  readRetentionPolicy,
  sealRehydrationMap,
} from '@/lib/server/retention';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let user;
  let token: string;
  try {
    token = extractBearerToken(req);
    user = await authenticateRequest(req);
  } catch (err) {
    return NextResponse.json(
      {
        error: 'UNAUTHORIZED',
        message: err instanceof Error ? err.message : 'Authentication failed.',
      },
      { status: 401 }
    );
  }

  const rate = checkRateLimit(user.uid);
  if (!rate.allowed) {
    recordMetric({ kind: 'rate_limit_hit', uid: user.uid });
    return NextResponse.json(
      { error: 'RATE_LIMITED', message: 'Too many writes. Please wait a moment.' },
      { status: 429, headers: { 'Retry-After': String(rate.resetSeconds) } }
    );
  }

  try {
    const body = await req.json().catch(() => ({}));
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    const privacyMode: PrivacyMode = body?.privacyMode || 'standard';
    const mode = typeof body?.mode === 'string' ? body.mode : 'reflection';
    const entryId = typeof body?.entryId === 'string' && body.entryId
      ? body.entryId
      : `entry_${Date.now()}`;

    if (!text) {
      return NextResponse.json(
        { error: 'INVALID_REQUEST', message: 'An entry cannot be empty.' },
        { status: 400 }
      );
    }
    if (text.length > LIMITS.MAX_PROMPT_LENGTH) {
      return NextResponse.json(
        {
          error: 'TOO_LONG',
          message: `Entry exceeds ${LIMITS.MAX_PROMPT_LENGTH} characters.`,
        },
        { status: 400 }
      );
    }

    // Location context follows exactly the same masking rule as the reflect path.
    const placeLabel =
      typeof body?.location?.placeLabel === 'string' && body.location.placeLabel.trim()
        ? body.location.placeLabel.trim()
        : null;
    const locationSettings = placeLabel
      ? await readLocationSettings(user.uid, token)
      : { preciseLocation: false, locationContextForReflections: false };

    const shielded = runPrivacyShield(text, privacyMode, {
      maskLocations:
        placeLabel && !locationSettings.locationContextForReflections ? [placeLabel] : [],
    });

    const nowIso = new Date().toISOString();
    const title = deriveTitle(text);
    const messageId = `msg_${Date.now()}_u`;

    // FEATURE 11: same inversion as the reflect path — redacted body is canonical, the
    // placeholder map is sealed under the user's KMS-wrapped DEK and discarded here.
    const retentionPolicy = await readRetentionPolicy(user.uid, token);
    let sealedMap = null;
    try {
      sealedMap = await sealRehydrationMap(user.uid, shielded.ephemeralMap);
    } catch (sealErr) {
      console.error('Rehydration payload could not be sealed:', sealErr);
      sealedMap = null;
    }

    // Storing the redacted body is only safe when a map was sealed alongside it.
    // Without one, redaction is permanent destruction of the author's own words on the
    // first write, not managed forgetting. See the note in the reflect route.
    const hadSomethingToSeal = shielded.ephemeralMap.size > 0;
    const managedForgetting = Boolean(sealedMap) || !hadSomethingToSeal;
    const canonicalBody = sealedMap ? shielded.redactedText : text;

    // The entry document. `status: 'active'` and a real title make it first-class in the
    // sidebar, Year View, Patterns and Recall exactly like a reflected entry.
    await persistDocument(
      `users/${user.uid}/entries/${entryId}`,
      {
        title,
        mode,
        status: 'active',
        createdAt: body?.createdAt || nowIso,
        updatedAt: nowIso,
        messageCount: 1,
        moodScore: null,
        savedWithoutReply: true,
        rehydration: sealedMap,
        retentionWindow: sealedMap ? retentionPolicy.window : 'never',
        managedForgetting,
        forgottenAt: null,
        location: placeLabel
          ? {
              placeLabel,
              lat: typeof body?.location?.lat === 'number' ? body.location.lat : null,
              lng: typeof body?.location?.lng === 'number' ? body.location.lng : null,
              precision: body?.location?.precision === 'precise' ? 'precise' : 'coarse',
              sharedWithModel: locationSettings.locationContextForReflections,
            }
          : null,
      },
      token
    );

    await persistDocument(
      `users/${user.uid}/entries/${entryId}/messages/${messageId}`,
      {
        role: 'user',
        // Canonical body is the redacted text. See lib/server/retention.ts.
        content: canonicalBody,
        createdAt: nowIso,
        redactionApplied: shielded.redactionApplied,
        redactionStats: shielded.categoryCounts,
      },
      token
    );

    const audit = createAuditRecord(req, 'JOURNAL_SAVE_NO_REPLY', 'SUCCESS');
    await persistDocument(
      `users/${user.uid}/audit/audit_${Date.now()}`,
      audit as unknown as Record<string, unknown>,
      token
    );

    recordMetric({ kind: 'entry_created', uid: user.uid });
    void recordEntryWritten(user.uid, null);

    void dispatchTriggerEvent(
      {
        uid: user.uid,
        type: 'entry_created',
        entryId,
        occurredAt: nowIso,
        mode,
        tags: [],
        commitmentCount: 0,
        themeCount: 0,
        rawText: text,
      },
      appUrlFrom(req)
    );

    return NextResponse.json({
      entryId,
      messageId,
      title,
      createdAt: nowIso,
      retention: computeRetentionState(nowIso, sealedMap ? retentionPolicy.window : 'never', true),
      canonicalBody,
      managedForgetting,
      redactionDetails: {
        redactionApplied: shielded.redactionApplied,
        categoryCounts: shielded.categoryCounts,
        maskedSpans: shielded.maskedSpans,
        redactedPayload: shielded.redactedText,
        originalLength: text.length,
        redactedLength: shielded.redactedText.length,
      },
    });
  } catch (error) {
    recordMetric({ kind: 'error', uid: user.uid, errorCode: 'SAVE_NO_REPLY_FAILED' });
    return NextResponse.json(
      {
        error: 'SAVE_FAILED',
        message: error instanceof Error ? error.message : 'Failed to save the entry.',
      },
      { status: 500 }
    );
  }
}

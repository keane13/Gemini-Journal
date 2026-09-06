/**
 * @file app/api/journal/rehydrate/route.ts
 * FEATURE 11: Reading an entry back inside its retention window.
 *
 * Because the canonical body is the redacted text, displaying the original details
 * requires a server round-trip: the encrypted map is opened here, applied in memory, and
 * the rehydrated text is returned for display only. It is never written back.
 *
 * The entry is read with the CALLER'S OWN ID TOKEN, so Firestore rules decide whether
 * they may see it. The KMS unwrap is additionally bound to their uid, so even a service
 * credential holding another user's ciphertext could not open it under this identity.
 *
 * Past the window there is nothing to open — not "access denied", but genuinely nothing:
 * the payload was destroyed, and this route has no path that could reconstruct it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, extractBearerToken } from '@/lib/server/auth';
import { getDocument, listDocuments } from '@/lib/server/firestore-rest';
import {
  computeRetentionState,
  forgottenLabel,
  isValidRetention,
  openRehydrationMap,
  readRetentionPolicy,
  rehydrate,
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
      { error: 'UNAUTHORIZED', message: err instanceof Error ? err.message : 'Auth failed.' },
      { status: 401 }
    );
  }

  try {
    const body = await req.json().catch(() => ({}));
    const entryId = typeof body?.entryId === 'string' ? body.entryId.trim() : '';
    if (!entryId) {
      return NextResponse.json(
        { error: 'INVALID_REQUEST', message: 'entryId is required.' },
        { status: 400 }
      );
    }

    // Read as the user. If rules refuse, we get nothing — as intended.
    const entry = await getDocument(`users/${user.uid}/entries/${entryId}`, token);
    if (!entry) {
      return NextResponse.json(
        { error: 'NOT_FOUND', message: 'Entry not found.' },
        { status: 404 }
      );
    }

    const policy = await readRetentionPolicy(user.uid, token);
    const window = isValidRetention(entry.retentionWindow)
      ? entry.retentionWindow
      : policy.window;

    const sealed = entry.rehydration ?? null;
    const state = computeRetentionState(
      entry.createdAt ?? new Date().toISOString(),
      window,
      Boolean(sealed)
    );

    const messages = await listDocuments(
      `users/${user.uid}/entries/${entryId}/messages`,
      token,
      200
    );
    messages.sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));

    // Absent payload: the details are gone. Return the redacted bodies unchanged and say so.
    if (!sealed) {
      if (Array.isArray(body?.texts)) {
        return NextResponse.json({
          entryId,
          forgotten: true,
          retention: { ...state, label: forgottenLabel(entry.forgottenAt ?? null) },
          // Unchanged: the details are genuinely gone, so this is the final form.
          texts: body.texts.slice(0, 50).map((t: unknown) => (typeof t === 'string' ? t : '')),
          rehydrated: false,
        });
      }

      return NextResponse.json({
        entryId,
        forgotten: true,
        retention: {
          ...state,
          label: forgottenLabel(entry.forgottenAt ?? null),
        },
        turns: messages.map((m) => ({
          id: m.id,
          role: m.role === 'model' ? 'model' : 'user',
          content: m.content ?? '',
          rehydrated: false,
        })),
      });
    }

    const map = await openRehydrationMap(user.uid, sealed);

    /**
     * Callers may pass their own redacted texts to be rehydrated. The client-side store
     * holds redacted bodies with its own turn ids, so it cannot be matched to server
     * message ids -- this lets it get display text without the placeholder map ever
     * leaving the server. Bounded so the endpoint cannot be used as a bulk oracle.
     */
    if (Array.isArray(body?.texts)) {
      const texts: string[] = body.texts
        .slice(0, 50)
        .map((t: unknown) => (typeof t === 'string' ? t.slice(0, 32000) : ''));

      return NextResponse.json({
        entryId,
        forgotten: false,
        retention: state,
        texts: texts.map((t) => rehydrate(t, map)),
        rehydrated: Boolean(map),
      });
    }

    return NextResponse.json({
      entryId,
      forgotten: false,
      retention: state,
      turns: messages.map((m) => ({
        id: m.id,
        role: m.role === 'model' ? 'model' : 'user',
        // Rehydrated for DISPLAY ONLY. Never written back to Firestore.
        content: rehydrate(m.content ?? '', map),
        rehydrated: Boolean(map),
      })),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: 'REHYDRATE_FAILED',
        message: error instanceof Error ? error.message : 'Failed to read the entry.',
      },
      { status: 500 }
    );
  }
}

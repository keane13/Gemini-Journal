/**
 * @file app/api/cron/aggregate/route.ts
 * FEATURE 7: Flushes in-process operational telemetry into /aggregates/{day}.
 *
 * Invoked by Cloud Scheduler with an OIDC identity token. Writes count-only documents
 * with the service credential (clients are denied all writes to /aggregates by rules).
 *
 * NOTE ON ACCURACY: telemetry accumulates per serverless instance, so each flush merges
 * additively into the day's document rather than overwriting it. Latency is stored as a
 * bucket histogram precisely so that this merge stays correct across instances.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getGoogleAccessToken } from '@/lib/server/google-auth';
import { getDocument, persistDocument } from '@/lib/server/firestore-rest';
import { AggregateDocument, pendingDays, pruneAccumulators, snapshotDay } from '@/lib/server/metrics';
import { verifyCronRequest } from '@/lib/server/cron-auth';

export const dynamic = 'force-dynamic';

function mergeInto(existing: AggregateDocument | null, incoming: AggregateDocument): AggregateDocument {
  if (!existing) return incoming;

  const histogram = incoming.latencyHistogram.map(
    (v, i) => v + (existing.latencyHistogram?.[i] || 0)
  );

  const mergePairs = (
    a: Record<string, number[]> = {},
    b: Record<string, number[]> = {}
  ): Record<string, number[]> => {
    const out: Record<string, number[]> = { ...a };
    for (const [key, pair] of Object.entries(b)) {
      const prev = out[key] || [0, 0];
      out[key] = [prev[0] + (pair[0] || 0), Math.max(prev[1], pair[1] || 0)];
    }
    return out;
  };

  return {
    ...incoming,
    activeUsers: Math.max(existing.activeUsers || 0, incoming.activeUsers),
    entriesCreated: (existing.entriesCreated || 0) + incoming.entriesCreated,
    entriesCreatedUsers: Math.max(existing.entriesCreatedUsers || 0, incoming.entriesCreatedUsers),
    modelCalls: (existing.modelCalls || 0) + incoming.modelCalls,
    modelCallUsers: Math.max(existing.modelCallUsers || 0, incoming.modelCallUsers),
    latencyHistogram: histogram,
    tokensIn: (existing.tokensIn || 0) + incoming.tokensIn,
    tokensOut: (existing.tokensOut || 0) + incoming.tokensOut,
    redaction: mergePairs(existing.redaction, incoming.redaction),
    errors: mergePairs(existing.errors, incoming.errors),
    rateLimitHits: (existing.rateLimitHits || 0) + incoming.rateLimitHits,
    rateLimitUsers: Math.max(existing.rateLimitUsers || 0, incoming.rateLimitUsers),
  };
}

export async function POST(req: NextRequest) {
  const auth = await verifyCronRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ error: 'UNAUTHORIZED', message: auth.reason }, { status: 401 });
  }

  try {
    const serviceToken = await getGoogleAccessToken();
    const flushed: string[] = [];

    for (const day of pendingDays()) {
      const snapshot = snapshotDay(day);
      if (!snapshot) continue;
      const existing = (await getDocument(`aggregates/${day}`, serviceToken)) as
        | AggregateDocument
        | null;
      const merged = mergeInto(existing, snapshot);
      const ok = await persistDocument(
        `aggregates/${day}`,
        merged as unknown as Record<string, unknown>,
        serviceToken
      );
      if (ok) flushed.push(day);
    }

    pruneAccumulators();
    return NextResponse.json({ success: true, flushed });
  } catch (error) {
    console.error('Aggregate flush failed:', error);
    return NextResponse.json(
      { error: 'FLUSH_FAILED', message: error instanceof Error ? error.message : 'unknown' },
      { status: 500 }
    );
  }
}

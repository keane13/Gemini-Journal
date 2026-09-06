/**
 * @file lib/server/digest-counters.ts
 * FEATURE 8: Write-time counters that make the weekly digest possible WITHOUT ever
 * reading journal content.
 *
 * When an entry is written we increment a count and accumulate a mood sum. When a
 * commitment is opened or closed we record or drop a due TIMESTAMP. Nothing else is
 * stored -- no titles, no text, no model output, no themes verbatim.
 *
 * At send time the digest reads only this document. That is what lets the scheduled job
 * run with a service credential without the server ever touching an entry.
 *
 * /digestCounters/{uid} is denied to all clients by firestore.rules; only the service
 * credential reads or writes it.
 */

import { getGoogleAccessToken } from '@/lib/server/google-auth';
import { getDocument, persistDocument } from '@/lib/server/firestore-rest';
import { DigestCounters, isoWeekOf } from '@/lib/server/digest';

const COUNTERS_PATH = (uid: string) => `digestCounters/${uid}`;

export async function readCounters(uid: string): Promise<DigestCounters> {
  const token = await getGoogleAccessToken();
  const doc = await getDocument(COUNTERS_PATH(uid), token);
  return (doc as DigestCounters) ?? {};
}

/**
 * Records that an entry was written. `moodScore` is accumulated as a sum/count pair so
 * the digest can describe a DIRECTION without ever storing or emitting a score.
 *
 * Best-effort: a telemetry failure must never break journaling.
 */
export async function recordEntryWritten(
  uid: string,
  moodScore: number | null | undefined,
  now: Date = new Date()
): Promise<void> {
  try {
    const week = isoWeekOf(now);
    const counters = await readCounters(uid);
    const weeks = counters.weeks ?? {};
    const bucket = weeks[week] ?? {};

    weeks[week] = {
      entries: (bucket.entries ?? 0) + 1,
      moodSum: (bucket.moodSum ?? 0) + (typeof moodScore === 'number' ? moodScore : 0),
      moodCount: (bucket.moodCount ?? 0) + (typeof moodScore === 'number' ? 1 : 0),
      themesCount: bucket.themesCount ?? 0,
    };

    const token = await getGoogleAccessToken();
    await persistDocument(
      COUNTERS_PATH(uid),
      { ...counters, weeks: pruneWeeks(weeks) } as Record<string, unknown>,
      token
    );
  } catch (err) {
    console.warn('digest counter (entry) update skipped:', err);
  }
}

/** Records how many recurring themes an insight run surfaced. Stores the COUNT only. */
export async function recordThemeCount(
  uid: string,
  themesCount: number,
  now: Date = new Date()
): Promise<void> {
  try {
    const week = isoWeekOf(now);
    const counters = await readCounters(uid);
    const weeks = counters.weeks ?? {};
    weeks[week] = { ...(weeks[week] ?? {}), themesCount };

    const token = await getGoogleAccessToken();
    await persistDocument(
      COUNTERS_PATH(uid),
      { ...counters, weeks: pruneWeeks(weeks) } as Record<string, unknown>,
      token
    );
  } catch (err) {
    console.warn('digest counter (themes) update skipped:', err);
  }
}

/**
 * Replaces the set of open-commitment due timestamps.
 * Timestamps only -- commitment text never reaches this document.
 */
export async function recordOpenCommitmentDueDates(
  uid: string,
  dueTimestamps: number[]
): Promise<void> {
  try {
    const counters = await readCounters(uid);
    const token = await getGoogleAccessToken();
    await persistDocument(
      COUNTERS_PATH(uid),
      {
        ...counters,
        openCommitmentDueAt: dueTimestamps.filter((t) => typeof t === 'number' && isFinite(t)),
      } as Record<string, unknown>,
      token
    );
  } catch (err) {
    console.warn('digest counter (commitments) update skipped:', err);
  }
}

/** Keeps the document bounded: the digest only ever compares two adjacent weeks. */
function pruneWeeks<T>(weeks: Record<string, T>, keep = 8): Record<string, T> {
  const keys = Object.keys(weeks).sort();
  if (keys.length <= keep) return weeks;
  const trimmed: Record<string, T> = {};
  for (const key of keys.slice(-keep)) trimmed[key] = weeks[key];
  return trimmed;
}

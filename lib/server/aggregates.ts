/**
 * @file lib/server/aggregates.ts
 * FEATURE 7: Aggregate shaping and small-cell suppression for the blind admin console.
 *
 * Every value the console renders passes through `suppress()`. Any cell backed by fewer
 * than SMALL_CELL_THRESHOLD distinct users is returned as { suppressed: true, value: null }
 * so that low-population buckets cannot be used to single out an individual -- the classic
 * re-identification path for "anonymous" operational dashboards.
 */

import { AggregateDocument, LATENCY_BUCKETS_MS } from '@/lib/server/metrics';

/** Cells backed by fewer than this many distinct users are never rendered. */
export const SMALL_CELL_THRESHOLD = 5;

export interface Cell {
  value: number | null;
  suppressed: boolean;
  /** Distinct users backing this cell, itself suppressed when below threshold. */
  users: number | null;
}

export function suppress(value: number, distinctUsers: number): Cell {
  if (distinctUsers < SMALL_CELL_THRESHOLD) {
    return { value: null, suppressed: true, users: null };
  }
  return { value, suppressed: false, users: distinctUsers };
}

export interface LatencySummary {
  p50Ms: Cell;
  p95Ms: Cell;
  /** True when the percentile falls in the open-ended top bucket (reported as a lower bound). */
  p95IsLowerBound: boolean;
  samples: number;
}

export interface FleetMetrics {
  periodStart: string;
  periodEnd: string;
  days: number;
  smallCellThreshold: number;
  dailyActiveUsers: Cell;
  entriesCreated: Cell;
  modelCalls: Cell;
  latency: LatencySummary;
  tokenSpend: { input: Cell; output: Cell; total: Cell };
  redactionHistogram: Array<{ category: string; cell: Cell }>;
  errorsByCode: Array<{ code: string; cell: Cell; ratePerThousand: number | null }>;
  rateLimitHits: Cell;
  /** Days in range that had no aggregate document at all. */
  missingDays: string[];
}

function emptyDoc(day: string): AggregateDocument {
  return {
    day,
    activeUsers: 0,
    entriesCreated: 0,
    entriesCreatedUsers: 0,
    modelCalls: 0,
    modelCallUsers: 0,
    latencyHistogram: new Array(LATENCY_BUCKETS_MS.length + 1).fill(0),
    latencyBucketsMs: [...LATENCY_BUCKETS_MS],
    tokensIn: 0,
    tokensOut: 0,
    redaction: {},
    errors: {},
    rateLimitHits: 0,
    rateLimitUsers: 0,
    updatedAt: new Date(0).toISOString(),
  };
}

function mergePairMap(
  target: Record<string, number[]>,
  source: Record<string, number[]> | undefined
): void {
  for (const [key, pair] of Object.entries(source || {})) {
    const [count = 0, users = 0] = pair || [];
    const existing = target[key] || [0, 0];
    // Distinct users cannot be unioned across days without storing identifiers, so we
    // take the max across days -- a deliberate under-count that keeps suppression safe.
    target[key] = [existing[0] + count, Math.max(existing[1], users)];
  }
}

/**
 * Merges per-day aggregates into one fleet view.
 *
 * Counts sum across days. Distinct-user figures take the per-day MAXIMUM rather than a
 * sum, because summing would double-count returning users and inflate the denominator
 * that suppression depends on. Under-counting here fails safe: it suppresses more, not less.
 */
export function mergeAggregates(docs: AggregateDocument[]): AggregateDocument {
  const merged = emptyDoc(docs.length ? docs[docs.length - 1].day : '');
  for (const doc of docs) {
    merged.activeUsers = Math.max(merged.activeUsers, doc.activeUsers || 0);
    merged.entriesCreated += doc.entriesCreated || 0;
    merged.entriesCreatedUsers = Math.max(merged.entriesCreatedUsers, doc.entriesCreatedUsers || 0);
    merged.modelCalls += doc.modelCalls || 0;
    merged.modelCallUsers = Math.max(merged.modelCallUsers, doc.modelCallUsers || 0);
    merged.tokensIn += doc.tokensIn || 0;
    merged.tokensOut += doc.tokensOut || 0;
    merged.rateLimitHits += doc.rateLimitHits || 0;
    merged.rateLimitUsers = Math.max(merged.rateLimitUsers, doc.rateLimitUsers || 0);

    const hist = doc.latencyHistogram || [];
    for (let i = 0; i < merged.latencyHistogram.length; i++) {
      merged.latencyHistogram[i] += hist[i] || 0;
    }
    mergePairMap(merged.redaction, doc.redaction);
    mergePairMap(merged.errors, doc.errors);
  }
  return merged;
}

/**
 * Computes a percentile from the additive bucket histogram.
 * Returns the bucket's upper bound, or the top bound when the percentile lands in the
 * open-ended bucket (flagged by the caller as a lower bound).
 */
export function percentileFromHistogram(
  histogram: number[],
  percentile: number
): { ms: number; isLowerBound: boolean; samples: number } {
  const total = histogram.reduce((a, b) => a + b, 0);
  if (total === 0) return { ms: 0, isLowerBound: false, samples: 0 };

  const target = total * percentile;
  let cumulative = 0;
  for (let i = 0; i < histogram.length; i++) {
    cumulative += histogram[i];
    if (cumulative >= target) {
      if (i >= LATENCY_BUCKETS_MS.length) {
        return {
          ms: LATENCY_BUCKETS_MS[LATENCY_BUCKETS_MS.length - 1],
          isLowerBound: true,
          samples: total,
        };
      }
      return { ms: LATENCY_BUCKETS_MS[i], isLowerBound: false, samples: total };
    }
  }
  return {
    ms: LATENCY_BUCKETS_MS[LATENCY_BUCKETS_MS.length - 1],
    isLowerBound: true,
    samples: total,
  };
}

/** Shapes merged aggregates into the suppressed view the console is allowed to render. */
export function buildFleetMetrics(
  docs: AggregateDocument[],
  range: { start: string; end: string; missingDays: string[] }
): FleetMetrics {
  const merged = mergeAggregates(docs);
  const activeUsers = merged.activeUsers;

  const p50 = percentileFromHistogram(merged.latencyHistogram, 0.5);
  const p95 = percentileFromHistogram(merged.latencyHistogram, 0.95);

  const redactionHistogram = Object.entries(merged.redaction)
    .map(([category, [count, users]]) => ({ category, cell: suppress(count, users) }))
    .filter((row) => !row.cell.suppressed)
    .sort((a, b) => (b.cell.value ?? 0) - (a.cell.value ?? 0));

  const errorsByCode = Object.entries(merged.errors)
    .map(([code, [count, users]]) => {
      const cell = suppress(count, users);
      return {
        code,
        cell,
        ratePerThousand:
          cell.suppressed || merged.modelCalls === 0
            ? null
            : Math.round((count / merged.modelCalls) * 1000 * 10) / 10,
      };
    })
    .filter((row) => !row.cell.suppressed)
    .sort((a, b) => (b.cell.value ?? 0) - (a.cell.value ?? 0));

  return {
    periodStart: range.start,
    periodEnd: range.end,
    days: docs.length,
    smallCellThreshold: SMALL_CELL_THRESHOLD,
    dailyActiveUsers: suppress(activeUsers, activeUsers),
    entriesCreated: suppress(merged.entriesCreated, merged.entriesCreatedUsers),
    modelCalls: suppress(merged.modelCalls, merged.modelCallUsers),
    latency: {
      p50Ms: suppress(p50.ms, merged.modelCallUsers),
      p95Ms: suppress(p95.ms, merged.modelCallUsers),
      p95IsLowerBound: p95.isLowerBound,
      samples: p50.samples,
    },
    tokenSpend: {
      input: suppress(merged.tokensIn, merged.modelCallUsers),
      output: suppress(merged.tokensOut, merged.modelCallUsers),
      total: suppress(merged.tokensIn + merged.tokensOut, merged.modelCallUsers),
    },
    redactionHistogram,
    errorsByCode,
    rateLimitHits: suppress(merged.rateLimitHits, merged.rateLimitUsers),
    missingDays: range.missingDays,
  };
}

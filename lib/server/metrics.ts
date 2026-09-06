/**
 * @file lib/server/metrics.ts
 * FEATURE 7: Operational telemetry collection for the blind admin console.
 *
 * PRIVACY INVARIANT: metric events carry NO journal content, NO titles, NO model output,
 * and NO raw uids. Distinct-user counts are computed from salted uid hashes held in
 * process memory only; the persisted aggregate stores the COUNT, never the identifiers.
 * Latency is stored as an additive bucket histogram so percentiles merge correctly
 * across serverless instances instead of being averaged into nonsense.
 */

import * as crypto from 'crypto';

export type MetricKind =
  | 'active'
  | 'entry_created'
  | 'model_call'
  | 'error'
  | 'rate_limit_hit';

export interface MetricEvent {
  kind: MetricKind;
  uid: string;
  /** model_call only */
  latencyMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  /** error only */
  errorCode?: string;
  /** model_call only: redaction categories applied to this egress, e.g. ['phone','email'] */
  redactionCategories?: string[];
}

/** Upper bounds in ms. The final open-ended bucket is Infinity. */
export const LATENCY_BUCKETS_MS = [100, 200, 400, 800, 1600, 3200, 6400, 12800] as const;

/** A counter paired with the set of distinct users that contributed to it. */
interface Cell {
  count: number;
  users: Set<string>;
}

interface DayAccumulator {
  day: string;
  activeUsers: Set<string>;
  entriesCreated: Cell;
  modelCalls: Cell;
  /** length === LATENCY_BUCKETS_MS.length + 1 */
  latencyHistogram: number[];
  tokensIn: number;
  tokensOut: number;
  redaction: Map<string, Cell>;
  errors: Map<string, Cell>;
  rateLimitHits: Cell;
}

function newCell(): Cell {
  return { count: 0, users: new Set() };
}

function newDay(day: string): DayAccumulator {
  return {
    day,
    activeUsers: new Set(),
    entriesCreated: newCell(),
    modelCalls: newCell(),
    latencyHistogram: new Array(LATENCY_BUCKETS_MS.length + 1).fill(0),
    tokensIn: 0,
    tokensOut: 0,
    redaction: new Map(),
    errors: new Map(),
    rateLimitHits: newCell(),
  };
}

const accumulators = new Map<string, DayAccumulator>();

export function isoDay(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Salted, truncated hash of a uid. Used only to count distinct users in memory.
 * The salt defaults to a per-process random value so hashes are not stable across
 * restarts and cannot be correlated back to accounts even if a heap dump leaked.
 */
const UID_HASH_SALT = process.env.METRICS_UID_SALT || crypto.randomBytes(16).toString('hex');

function hashUid(uid: string): string {
  return crypto.createHash('sha256').update(`${UID_HASH_SALT}:${uid}`).digest('hex').slice(0, 32);
}

function bumpCell(cell: Cell, hashedUid: string, by = 1): void {
  cell.count += by;
  cell.users.add(hashedUid);
}

function bumpMapCell(map: Map<string, Cell>, key: string, hashedUid: string): void {
  let cell = map.get(key);
  if (!cell) {
    cell = newCell();
    map.set(key, cell);
  }
  bumpCell(cell, hashedUid);
}

export function latencyBucketIndex(latencyMs: number): number {
  for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) {
    if (latencyMs <= LATENCY_BUCKETS_MS[i]) return i;
  }
  return LATENCY_BUCKETS_MS.length;
}

/** Records one operational event. Never throws -- telemetry must not break a request. */
export function recordMetric(event: MetricEvent): void {
  try {
    const day = isoDay();
    let acc = accumulators.get(day);
    if (!acc) {
      acc = newDay(day);
      accumulators.set(day, acc);
    }

    const h = hashUid(event.uid);
    acc.activeUsers.add(h);

    switch (event.kind) {
      case 'active':
        break;
      case 'entry_created':
        bumpCell(acc.entriesCreated, h);
        break;
      case 'model_call': {
        bumpCell(acc.modelCalls, h);
        if (typeof event.latencyMs === 'number' && event.latencyMs >= 0) {
          acc.latencyHistogram[latencyBucketIndex(event.latencyMs)] += 1;
        }
        acc.tokensIn += event.tokensIn ?? 0;
        acc.tokensOut += event.tokensOut ?? 0;
        for (const category of event.redactionCategories ?? []) {
          bumpMapCell(acc.redaction, category.toLowerCase(), h);
        }
        break;
      }
      case 'error':
        bumpMapCell(acc.errors, event.errorCode || 'UNKNOWN', h);
        break;
      case 'rate_limit_hit':
        bumpCell(acc.rateLimitHits, h);
        break;
    }
  } catch {
    // Telemetry is best-effort by design.
  }
}

/** Serialized form persisted to /aggregates/{day}. Contains counts only. */
export interface AggregateDocument {
  day: string;
  activeUsers: number;
  entriesCreated: number;
  entriesCreatedUsers: number;
  modelCalls: number;
  modelCallUsers: number;
  latencyHistogram: number[];
  latencyBucketsMs: number[];
  tokensIn: number;
  tokensOut: number;
  /** category -> [count, distinctUsers] */
  redaction: Record<string, number[]>;
  /** errorCode -> [count, distinctUsers] */
  errors: Record<string, number[]>;
  rateLimitHits: number;
  rateLimitUsers: number;
  updatedAt: string;
}

function serializeMap(map: Map<string, Cell>): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [key, cell] of map.entries()) {
    out[key] = [cell.count, cell.users.size];
  }
  return out;
}

/** Snapshots a day's accumulator into its persisted, count-only form. */
export function snapshotDay(day: string): AggregateDocument | null {
  const acc = accumulators.get(day);
  if (!acc) return null;
  return {
    day: acc.day,
    activeUsers: acc.activeUsers.size,
    entriesCreated: acc.entriesCreated.count,
    entriesCreatedUsers: acc.entriesCreated.users.size,
    modelCalls: acc.modelCalls.count,
    modelCallUsers: acc.modelCalls.users.size,
    latencyHistogram: [...acc.latencyHistogram],
    latencyBucketsMs: [...LATENCY_BUCKETS_MS],
    tokensIn: acc.tokensIn,
    tokensOut: acc.tokensOut,
    redaction: serializeMap(acc.redaction),
    errors: serializeMap(acc.errors),
    rateLimitHits: acc.rateLimitHits.count,
    rateLimitUsers: acc.rateLimitHits.users.size,
    updatedAt: new Date().toISOString(),
  };
}

export function pendingDays(): string[] {
  return [...accumulators.keys()].sort();
}

/** Drops accumulators older than the retention window to bound memory. */
export function pruneAccumulators(keepDays = 3): void {
  const keys = pendingDays();
  while (keys.length > keepDays) {
    const oldest = keys.shift();
    if (oldest) accumulators.delete(oldest);
  }
}

/** Test seam: clears all in-process telemetry. */
export function __resetMetrics(): void {
  accumulators.clear();
}

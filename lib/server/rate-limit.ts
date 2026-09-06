/**
 * @file lib/server/rate-limit.ts
 * In-memory sliding window rate limiter per authenticated UID.
 * Defends against Denial of Service and API quota exhaustion.
 */

import { LIMITS } from '@/lib/config';

interface RateLimitRecord {
  timestamps: number[];
}

const rateLimitStore = new Map<string, RateLimitRecord>();

// Cleanup stale records periodically
setInterval(() => {
  const oneMinuteAgo = Date.now() - 60 * 1000;
  for (const [key, record] of rateLimitStore.entries()) {
    record.timestamps = record.timestamps.filter((t) => t > oneMinuteAgo);
    if (record.timestamps.length === 0) {
      rateLimitStore.delete(key);
    }
  }
}, 60 * 1000);

export interface RateLimitCheckResult {
  allowed: boolean;
  remaining: number;
  resetSeconds: number;
}

export function checkRateLimit(uid: string): RateLimitCheckResult {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const limit = LIMITS.RATE_LIMIT_PER_MINUTE;

  let record = rateLimitStore.get(uid);
  if (!record) {
    record = { timestamps: [] };
    rateLimitStore.set(uid, record);
  }

  // Remove timestamps older than 60s
  record.timestamps = record.timestamps.filter((t) => t > now - windowMs);

  if (record.timestamps.length >= limit) {
    const oldestTimestamp = record.timestamps[0];
    const resetSeconds = Math.ceil((oldestTimestamp + windowMs - now) / 1000);
    return {
      allowed: false,
      remaining: 0,
      resetSeconds: Math.max(1, resetSeconds),
    };
  }

  record.timestamps.push(now);
  return {
    allowed: true,
    remaining: limit - record.timestamps.length,
    resetSeconds: 60,
  };
}

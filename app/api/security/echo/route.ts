/**
 * @file app/api/security/echo/route.ts
 * FEATURE 10: probe target for the RATE_LIMIT check.
 *
 * Authenticated, and subject to the SAME per-uid limiter as every other route in the
 * application. Exhausting it genuinely exhausts the caller's quota — the next real
 * journal request will be refused too — so the limiter under test is the production
 * limiter, not a copy of it.
 *
 * It exists so that verifying the limit does not require firing 26 live Gemini calls.
 * It returns no data and touches no user content.
 */

import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/server/auth';
import { checkRateLimit } from '@/lib/server/rate-limit';
import { recordMetric } from '@/lib/server/metrics';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let user;
  try {
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
    // The documented rejection shape: 429 + Retry-After + { error, message }.
    return NextResponse.json(
      {
        error: 'RATE_LIMITED',
        message: 'Too Many Requests. Please wait before submitting another request.',
      },
      { status: 429, headers: { 'Retry-After': String(rate.resetSeconds) } }
    );
  }

  return NextResponse.json({ ok: true, remaining: rate.remaining });
}

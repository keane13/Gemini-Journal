/**
 * @file app/api/security/self-test/route.ts
 * FEATURE 10: Adversarial Self-Test runner.
 *
 * The client drives the suite one check at a time so the UI can show
 * pending → running → pass/fail honestly, but the RESULTS ARE SERVER-AUTHORED: each
 * verdict is computed here and appended to a server-side run document. The audit event
 * written at the end is derived from that document, not from anything the browser
 * reports, so a modified client cannot fabricate a clean security run.
 *
 * Guards on the page itself:
 *   - a verified token (obviously),
 *   - a sign-in within the last 10 minutes, because the suite performs real attacks,
 *   - a cap on runs per window, so the page cannot be used to amplify load.
 */

import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, VerifiedAuthUser } from '@/lib/server/auth';
import { appUrlFrom } from '@/lib/server/app-url';
import { createAuditRecord } from '@/lib/server/audit';
import { getGoogleAccessToken } from '@/lib/server/google-auth';
import { getDocument, persistDocument } from '@/lib/server/firestore-rest';
import { runCheck } from '@/lib/server/selftest/checks';
import { getFixtureUid } from '@/lib/server/selftest/fixtures';
import {
  CHECKS,
  CheckId,
  CheckResult,
  SELFTEST_FRESH_AUTH_SECONDS,
  SELFTEST_RUNS_PER_WINDOW,
  SELFTEST_WINDOW_MS,
  SelfTestRun,
} from '@/lib/server/selftest/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Per-uid run budget for the page itself, separate from the request limiter. */
const runWindow = new Map<string, number[]>();

function withinRunBudget(uid: string): boolean {
  const now = Date.now();
  const stamps = (runWindow.get(uid) ?? []).filter((t) => t > now - SELFTEST_WINDOW_MS);
  if (stamps.length >= SELFTEST_RUNS_PER_WINDOW) {
    runWindow.set(uid, stamps);
    return false;
  }
  stamps.push(now);
  runWindow.set(uid, stamps);
  return true;
}

function bad(message: string, code: string, status: number) {
  return NextResponse.json({ error: code, message }, { status });
}

async function requireFreshUser(req: NextRequest): Promise<VerifiedAuthUser> {
  const user = await authenticateRequest(req);
  const age = Math.floor(Date.now() / 1000) - user.authTime;
  if (age > SELFTEST_FRESH_AUTH_SECONDS) {
    const err = new Error(
      `Re-authentication required. Last sign-in was ${Math.floor(age / 60)} minutes ago; ` +
        `this page runs real attacks and requires a sign-in within ` +
        `${SELFTEST_FRESH_AUTH_SECONDS / 60} minutes.`
    );
    (err as any).code = 'STALE_AUTH';
    throw err;
  }
  return user;
}

const runPath = (uid: string, runId: string) => `selfTestRuns/${uid}_${runId}`;

async function loadRun(uid: string, runId: string): Promise<SelfTestRun | null> {
  const token = await getGoogleAccessToken();
  const doc = await getDocument(runPath(uid, runId), token);
  if (!doc) return null;
  const run = doc as unknown as SelfTestRun;
  // Defence in depth: never return another account's run, whatever path was constructed.
  return run.uid === uid ? run : null;
}

async function saveRun(run: SelfTestRun): Promise<void> {
  const token = await getGoogleAccessToken();
  await persistDocument(
    runPath(run.uid, run.runId),
    run as unknown as Record<string, unknown>,
    token
  );
}

function tally(results: CheckResult[]) {
  return {
    passed: results.filter((r) => r.status === 'pass').length,
    failed: results.filter((r) => r.status === 'fail' || r.status === 'error').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
  };
}

export async function GET(req: NextRequest) {
  let user: VerifiedAuthUser;
  try {
    user = await authenticateRequest(req);
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Auth failed.', 'UNAUTHORIZED', 401);
  }

  const age = Math.floor(Date.now() / 1000) - user.authTime;

  return NextResponse.json({
    checks: CHECKS,
    canRun: age <= SELFTEST_FRESH_AUTH_SECONDS,
    authAgeSeconds: age,
    freshAuthWindowSeconds: SELFTEST_FRESH_AUTH_SECONDS,
    isAdmin: user.role === 'admin',
    fixtureConfigured: Boolean(getFixtureUid()),
    // When configured, the UI turns each check's covering test file into a link. Left
    // unset it stays plain text: a dead link on this page would undermine its premise.
    sourceBaseUrl: (process.env.SELFTEST_SOURCE_BASE_URL || '').replace(/\/+$/, '') || null,
    runsPerWindow: SELFTEST_RUNS_PER_WINDOW,
    note:
      'RATE_LIMIT runs last and deliberately exhausts your per-minute request quota. ' +
      'Journal requests may be refused for up to a minute afterwards.',
  });
}

export async function POST(req: NextRequest) {
  let user: VerifiedAuthUser;
  try {
    user = await requireFreshUser(req);
  } catch (err) {
    const code = (err as any)?.code === 'STALE_AUTH' ? 'STALE_AUTH' : 'UNAUTHORIZED';
    return bad(err instanceof Error ? err.message : 'Auth failed.', code, 401);
  }

  const body = await req.json().catch(() => ({}));
  const action = body?.action;

  // ---- start ------------------------------------------------------------
  if (action === 'start') {
    if (!withinRunBudget(user.uid)) {
      return bad(
        `At most ${SELFTEST_RUNS_PER_WINDOW} runs are permitted per ` +
          `${SELFTEST_WINDOW_MS / 60000} minutes.`,
        'RUN_LIMIT',
        429
      );
    }

    const run: SelfTestRun = {
      runId: `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      uid: user.uid,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      results: [],
      passed: 0,
      failed: 0,
      skipped: 0,
    };
    await saveRun(run);

    return NextResponse.json({ runId: run.runId, checks: CHECKS.map((c) => c.id) });
  }

  // ---- run one check ----------------------------------------------------
  if (action === 'run') {
    const runId = typeof body?.runId === 'string' ? body.runId : '';
    const checkId = body?.checkId as CheckId;

    if (!runId) return bad('runId is required.', 'INVALID_REQUEST', 400);
    if (!CHECKS.some((c) => c.id === checkId)) {
      return bad(`Unknown check: ${String(checkId)}.`, 'INVALID_REQUEST', 400);
    }

    const run = await loadRun(user.uid, runId);
    if (!run) return bad('Run not found.', 'NOT_FOUND', 404);

    // The attack happens here, against the live application.
    const result = await runCheck(checkId, { user, appUrl: appUrlFrom(req) });

    const results = [...(run.results ?? []).filter((r) => r.id !== checkId), result];
    const counts = tally(results);
    await saveRun({ ...run, results, ...counts });

    return NextResponse.json({ result });
  }

  // ---- finalize ---------------------------------------------------------
  if (action === 'finalize') {
    const runId = typeof body?.runId === 'string' ? body.runId : '';
    if (!runId) return bad('runId is required.', 'INVALID_REQUEST', 400);

    const run = await loadRun(user.uid, runId);
    if (!run) return bad('Run not found.', 'NOT_FOUND', 404);

    const counts = tally(run.results ?? []);
    const finished: SelfTestRun = {
      ...run,
      ...counts,
      finishedAt: new Date().toISOString(),
    };
    await saveRun(finished);

    /**
     * Audit event. Counts and check ids only — no raw responses, no model output, no
     * payloads. The run document holds the detail; the audit records that a run happened
     * and how it came out.
     */
    const base = createAuditRecord(
      req,
      'security_selftest',
      counts.failed > 0 ? 'ERROR' : 'SUCCESS'
    );
    await persistDocument(
      `users/${user.uid}/audit/audit_selftest_${Date.now()}`,
      {
        ...base,
        runId,
        passed: counts.passed,
        failed: counts.failed,
        skipped: counts.skipped,
        checks: (run.results ?? []).map((r) => `${r.id}:${r.status}`).join(','),
      },
      user.token
    );

    return NextResponse.json({
      run: finished,
      summary: {
        passed: counts.passed,
        failed: counts.failed,
        skipped: counts.skipped,
        total: (run.results ?? []).length,
      },
    });
  }

  return bad("action must be one of 'start', 'run', 'finalize'.", 'INVALID_REQUEST', 400);
}

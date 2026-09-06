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

/**
 * Fallback run store, used only when Firestore persistence is unavailable — typically a
 * local run with no service credential configured.
 *
 * This is a genuine weakening and is reported as such: `persisted: false` travels back to
 * the client, which says so on screen. Server-authored verdicts are what stop a modified
 * browser fabricating a clean run, and an in-memory store on a single instance is a
 * weaker version of that guarantee. The checks themselves remain completely real; only
 * the tamper-evident record of them is downgraded.
 *
 * Silently falling back would be the worst option: the page would look identical while
 * quietly no longer meaning what it says.
 */
/**
 * Held on `globalThis`, not in a module-level `const`.
 *
 * This is not defensive style for its own sake — it fixes an observed failure. In dev,
 * Next.js re-evaluates route modules when the module graph is invalidated, and the first
 * check that calls /api/journal/chat triggers compilation of that route and its shared
 * dependencies. Module-level state was wiped mid-run, so every check after the first
 * model call returned "Run not found" in 0ms: the checks never executed at all.
 *
 * A run must outlive module re-evaluation, so it lives somewhere module re-evaluation
 * cannot reach.
 */
const selfTestStore = globalThis as unknown as {
  __selfTestRuns?: Map<string, SelfTestRun>;
  __selfTestPersistence?: boolean;
};

selfTestStore.__selfTestRuns ??= new Map<string, SelfTestRun>();
selfTestStore.__selfTestPersistence ??= true;

const memoryRuns = selfTestStore.__selfTestRuns;

function persistenceOk(): boolean {
  return selfTestStore.__selfTestPersistence !== false;
}

function markPersistenceUnavailable(): void {
  selfTestStore.__selfTestPersistence = false;
}

async function loadRun(uid: string, runId: string): Promise<SelfTestRun | null> {
  try {
    const token = await getGoogleAccessToken();
    const doc = await getDocument(runPath(uid, runId), token);
    if (doc) {
      const run = doc as unknown as SelfTestRun;
      // Defence in depth: never return another account's run, whatever path was built.
      if (run.uid === uid) return run;
    }
  } catch {
    markPersistenceUnavailable();
  }
  return memoryRuns.get(`${uid}_${runId}`) ?? null;
}

async function saveRun(run: SelfTestRun): Promise<void> {
  // The in-memory copy is always kept, so a Firestore failure mid-run cannot lose the
  // results the user is watching accumulate.
  memoryRuns.set(`${run.uid}_${run.runId}`, run);

  try {
    const token = await getGoogleAccessToken();
    const ok = await persistDocument(
      runPath(run.uid, run.runId),
      run as unknown as Record<string, unknown>,
      token
    );
    if (!ok) markPersistenceUnavailable();
  } catch {
    markPersistenceUnavailable();
  }
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

  /**
   * Everything below runs inside one try/catch.
   *
   * Without it, a throw from the run store escaped the handler, Next.js returned a 500
   * with an EMPTY body, and the browser's `res.json()` failed with
   * "Unexpected end of JSON input" -- an error that says nothing about what went wrong.
   * A route whose client always parses JSON must always produce JSON, including when it
   * fails.
   */
  try {
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

    return NextResponse.json({
      runId: run.runId,
      checks: CHECKS.map((c) => c.id),
      persisted: persistenceOk(),
    });
  }

  // ---- run one check ----------------------------------------------------
  if (action === 'run') {
    const runId = typeof body?.runId === 'string' ? body.runId : '';
    const checkId = body?.checkId as CheckId;

    if (!runId) return bad('runId is required.', 'INVALID_REQUEST', 400);
    if (!CHECKS.some((c) => c.id === checkId)) {
      return bad(`Unknown check: ${String(checkId)}.`, 'INVALID_REQUEST', 400);
    }

    /**
     * A missing run record must never stop the checks running.
     *
     * The record exists to make verdicts tamper-evident; the checks are what actually
     * prove anything. Refusing to run because the bookkeeping was lost gets that
     * backwards -- it withholds the evidence in order to protect the receipt.
     */
    const run =
      (await loadRun(user.uid, runId)) ??
      ({
        runId,
        uid: user.uid,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        results: [],
        passed: 0,
        failed: 0,
        skipped: 0,
      } satisfies SelfTestRun);

    // The attack happens here, against the live application.
    const result = await runCheck(checkId, { user, appUrl: appUrlFrom(req) });

    const results = [...(run.results ?? []).filter((r) => r.id !== checkId), result];
    const counts = tally(results);
    await saveRun({ ...run, results, ...counts });

    return NextResponse.json({ result, persisted: persistenceOk() });
  }

  // ---- finalize ---------------------------------------------------------
  if (action === 'finalize') {
    const runId = typeof body?.runId === 'string' ? body.runId : '';
    if (!runId) return bad('runId is required.', 'INVALID_REQUEST', 400);

    const run = await loadRun(user.uid, runId);
    if (!run) {
      return NextResponse.json({
        persisted: persistenceOk(),
        summary: { passed: 0, failed: 0, skipped: 0, total: 0 },
        note: 'The run record was not retained, so no audit event was written.',
      });
    }

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
      persisted: persistenceOk(),
      summary: {
        passed: counts.passed,
        failed: counts.failed,
        skipped: counts.skipped,
        total: (run.results ?? []).length,
      },
    });
  }

  return bad("action must be one of 'start', 'run', 'finalize'.", 'INVALID_REQUEST', 400);
  } catch (err) {
    console.error('Self-test runner failed:', err);
    return bad(
      err instanceof Error ? err.message : 'The self-test runner failed unexpectedly.',
      'RUNNER_ERROR',
      500
    );
  }
}

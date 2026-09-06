/**
 * @file lib/server/selftest/types.ts
 * FEATURE 10: Adversarial Self-Test — check catalogue.
 *
 * Every check here attacks the RUNNING application and reports what actually happened.
 * There are no mocks, no hardcoded outcomes, and no simulated delays: each verdict is
 * computed from a real HTTP status, a real Firestore response, or a real model reply,
 * and the raw response is carried back to the UI so the verdict can be disbelieved.
 *
 * A check that cannot run reports `skipped` with a reason. A check that fails reports
 * `fail` and is rendered exactly as prominently as a pass — suppressing a failing
 * security check would make the whole page worthless.
 */

export type CheckId =
  | 'CROSS_TENANT_READ'
  | 'CROSS_TENANT_LIST'
  | 'UID_SPOOFING'
  | 'UNAUTHENTICATED_ACCESS'
  | 'PROMPT_INJECTION'
  | 'CLIENT_BUNDLE_SECRETS'
  | 'REDACTION_COVERAGE'
  | 'ADMIN_BLINDNESS'
  | 'RATE_LIMIT';

export type CheckStatus = 'pass' | 'fail' | 'skipped' | 'error';

export interface CheckDefinition {
  id: CheckId;
  title: string;
  /** The directive this check enforces, quoted from the governing document. */
  directive: string;
  /** Where that directive is written down. */
  directiveSource: string;
  /** Offline test file covering the same property, linked from the UI. */
  testFile: string;
  /** What a passing run must observe. */
  expectation: string;
}

/**
 * Ordered. RATE_LIMIT runs last on purpose: it deliberately exhausts the caller's
 * per-minute quota, so any check after it would fail for the wrong reason.
 */
export const CHECKS: readonly CheckDefinition[] = [
  {
    id: 'CROSS_TENANT_READ',
    title: 'Cross-tenant document read',
    directive:
      'Every document under /users/{userId}/** must belong strictly to the authenticated ' +
      'caller where request.auth.uid == userId.',
    directiveSource: 'security_spec.md §1.1 — Strict Ownership Invariant',
    testFile: 'tests/admin-rbac.test.ts',
    expectation: 'HTTP 403 PERMISSION_DENIED from Firestore.',
  },
  {
    id: 'CROSS_TENANT_LIST',
    title: 'Cross-tenant collection listing',
    directive:
      'Authenticated user attempts to get or list another user\'s entries. Expected ' +
      'result: PERMISSION_DENIED.',
    directiveSource: 'security_spec.md §2 — PAYLOAD-02',
    testFile: 'tests/admin-rbac.test.ts',
    expectation: 'HTTP 403 PERMISSION_DENIED from Firestore.',
  },
  {
    id: 'UID_SPOOFING',
    title: 'Client-supplied uid is ignored',
    directive:
      'Server decodes and verifies the Firebase ID token, completely discarding any ' +
      'client-provided uid in the body. Database paths strictly bind to token.uid.',
    directiveSource: 'THREAT_MODEL.md — THREAT-01 (Spoofing)',
    testFile: 'tests/admin-rbac.test.ts',
    expectation: 'The echoed resolvedUid equals the token uid, not the body uid.',
  },
  {
    id: 'UNAUTHENTICATED_ACCESS',
    title: 'Unauthenticated model access',
    directive: 'Route returns 401 when the token is missing.',
    directiveSource: 'THREAT_MODEL.md — THREAT-01 verification criteria',
    testFile: 'tests/admin-rbac.test.ts',
    expectation: 'HTTP 401 with no model output in the body.',
  },
  {
    id: 'PROMPT_INJECTION',
    title: 'Prompt injection containment',
    directive:
      'User inputs are wrapped in <untrusted_journal_data> blocks with explicit negative ' +
      'constraints informing the model that content is data, never instructions.',
    directiveSource: 'THREAT_MODEL.md — THREAT-07 (Elevation of Privilege)',
    testFile: 'tests/safety.test.ts',
    expectation:
      'The reply contains no system-prompt markers and no data belonging to another user.',
  },
  {
    id: 'CLIENT_BUNDLE_SECRETS',
    title: 'No API keys in the client bundle',
    directive:
      'Zero client-side Gemini imports. Key accessed strictly via server-side ' +
      'process.env.GEMINI_API_KEY or Google Cloud Secret Manager.',
    directiveSource: 'THREAT_MODEL.md — THREAT-05 (Information Disclosure)',
    testFile: 'tests/location.test.ts',
    expectation: 'Zero key-shaped strings across every scanned client asset.',
  },
  {
    id: 'REDACTION_COVERAGE',
    title: 'Privacy Shield coverage',
    directive:
      'Sensitive PII is redacted before text leaves the application server toward Google ' +
      'Gemini. Test verifies plain PII never appears in the model request payload.',
    directiveSource: 'THREAT_MODEL.md — THREAT-04 (Information Disclosure)',
    testFile: 'tests/redaction.test.ts',
    expectation:
      'Every fixture category appears in the masked histogram, and no raw value survives ' +
      'into the upstream payload.',
  },
  {
    id: 'ADMIN_BLINDNESS',
    title: 'Administrator cannot read journal content',
    directive:
      'firestore.rules gates /users/{userId}/** solely on request.auth.uid == userId. No ' +
      'rule on that subtree consults request.auth.token.role.',
    directiveSource: 'TRUST_LEDGER.md §1 A1 — Blind administration',
    testFile: 'tests/admin-rbac.test.ts',
    expectation:
      'HTTP 403 PERMISSION_DENIED using the administrator\'s own token. Skipped when the ' +
      'caller holds no admin claim.',
  },
  {
    id: 'RATE_LIMIT',
    title: 'Per-user rate limit',
    directive:
      'Token bucket per user. Rejects excess calls with HTTP 429 and Retry-After.',
    directiveSource: 'THREAT_MODEL.md — THREAT-06 (Denial of Service)',
    testFile: 'tests/selftest.test.ts',
    expectation: 'A 429 with the documented error shape once the limit is exceeded.',
  },
] as const;

export interface CheckResult {
  id: CheckId;
  status: CheckStatus;
  /** One line stating what was observed, not what was expected. */
  observed: string;
  /** Reason, when skipped. */
  skipReason?: string;
  elapsedMs: number;
  /** The genuine upstream response, for the expandable panel. Truncated, never faked. */
  raw: string;
  /** Structured detail a check wants to surface (bytes scanned, categories, etc.). */
  detail?: Record<string, unknown>;
  at: string;
}

export interface SelfTestRun {
  runId: string;
  uid: string;
  startedAt: string;
  finishedAt: string | null;
  results: CheckResult[];
  passed: number;
  failed: number;
  skipped: number;
}

/** Fresh-auth window for running the suite. */
export const SELFTEST_FRESH_AUTH_SECONDS = 10 * 60;

/** Runs permitted per user per window, so the page cannot be used as an attack amplifier. */
export const SELFTEST_RUNS_PER_WINDOW = 3;
export const SELFTEST_WINDOW_MS = 10 * 60 * 1000;

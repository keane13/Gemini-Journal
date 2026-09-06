/**
 * @file tests/selftest.test.ts
 * FEATURE 10 verification.
 *
 * The self-test page makes a strong claim: that its verdicts come from the running system
 * rather than from the code that renders them. These tests defend that claim structurally,
 * because it is exactly the kind of claim that decays quietly — a "temporary" hardcoded
 * pass added during debugging would still render green forever.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { CHECKS, SELFTEST_FRESH_AUTH_SECONDS } from '../lib/server/selftest/types';
import {
  INJECTION_FIXTURE,
  REDACTION_FIXTURE,
  getFixtureUid,
} from '../lib/server/selftest/fixtures';
import { runPrivacyShield } from '../lib/server/redaction';
import { LIMITS } from '../lib/config';

const ROOT = path.join(__dirname, '..');

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

// ---------------------------------------------------------------------------
// The checks are real
// ---------------------------------------------------------------------------

test('No check fabricates a delay', () => {
  const code = codeOnly(read('lib/server/selftest/checks.ts'));

  // A simulated delay would make a mocked check feel real; there must be none.
  assert.ok(!/setTimeout/.test(code), 'checks must not sleep to simulate work');
  assert.ok(!/new Promise\s*\(\s*\(?\s*r/.test(code), 'checks must not fabricate timing');
});

test('Every verdict is derived from an observation, never hardcoded', () => {
  const code = codeOnly(read('lib/server/selftest/checks.ts'));

  // No literal pass may be assigned without a computed condition behind it.
  const literalPasses = code.match(/'pass'/g) ?? [];
  const derivations = code.match(/\?\s*'pass'\s*:/g) ?? [];
  assert.ok(
    literalPasses.length === derivations.length,
    `every 'pass' must come from a ternary on an observed condition ` +
      `(found ${literalPasses.length} literals but ${derivations.length} derivations)`
  );
});

test('Each check performs a real backend operation', () => {
  const code = read('lib/server/selftest/checks.ts');

  // Cross-tenant and admin checks go through Firestore REST with the caller's own token.
  assert.ok(code.includes('rawGetDocument'), 'Firestore probes must hit the real REST API');
  assert.ok(
    code.includes('ctx.user.token'),
    'probes must be attributed to the caller\'s own ID token, not a service credential'
  );
  // Route-level checks make genuine HTTP requests to the running app.
  assert.ok(code.includes('await fetch(`${ctx.appUrl}'), 'route checks must use real HTTP');
  // The bundle scan reads the real filesystem.
  assert.ok(code.includes("fs.readFile"), 'the bundle scan must read real files');
});

test('Firestore probes never fall back to a rules-bypassing credential', () => {
  const code = codeOnly(read('lib/server/selftest/checks.ts'));

  // ensureFixtureSeeded legitimately uses the service credential to seed the synthetic
  // tenant, but no PROBE may: a probe made with it would bypass rules and pass falsely.
  const probeSection = code.slice(code.indexOf('async function crossTenant'));
  assert.ok(
    !probeSection.includes('getGoogleAccessToken'),
    'cross-tenant probes must not use the service credential'
  );
});

// ---------------------------------------------------------------------------
// Fixture safety
// ---------------------------------------------------------------------------

test('Cross-tenant probes target a configured synthetic tenant, never a guessed uid', () => {
  const code = read('lib/server/selftest/fixtures.ts');

  assert.ok(code.includes('SELFTEST_FIXTURE_UID'), 'the fixture uid must be configured');
  assert.ok(
    code.includes('Refusing to seed'),
    'seeding must refuse any uid that is not the configured fixture'
  );

  const previous = process.env.SELFTEST_FIXTURE_UID;
  delete process.env.SELFTEST_FIXTURE_UID;
  try {
    assert.equal(getFixtureUid(), null, 'an unset fixture uid must resolve to null');
  } finally {
    if (previous !== undefined) process.env.SELFTEST_FIXTURE_UID = previous;
  }
});

test('An unconfigured or self-referential fixture yields skipped, never pass', () => {
  const code = codeOnly(read('lib/server/selftest/checks.ts'));
  const section = code.slice(
    code.indexOf('async function crossTenant'),
    code.indexOf('async function uidSpoofing')
  );

  assert.ok(section.includes("'skipped'"), 'the no-fixture path must skip');
  assert.ok(
    section.includes('fixtureUid === ctx.user.uid'),
    'reading your own tenant proves nothing and must be skipped'
  );
});

// ---------------------------------------------------------------------------
// Redaction fixture actually exercises every claimed category
// ---------------------------------------------------------------------------

test('The redaction fixture masks every category it claims to cover', () => {
  const shielded = runPrivacyShield(REDACTION_FIXTURE.text, 'standard');

  for (const category of REDACTION_FIXTURE.expectedCategories) {
    assert.ok(
      (shielded.categoryCounts[category] ?? 0) > 0,
      `the fixture must exercise ${category}, but the Privacy Shield did not mask it`
    );
  }
});

test('No fixture raw value survives the Privacy Shield', () => {
  const shielded = runPrivacyShield(REDACTION_FIXTURE.text, 'standard');

  for (const raw of REDACTION_FIXTURE.rawValues) {
    assert.ok(
      !shielded.redactedText.includes(raw),
      `the raw value "${raw.slice(0, 6)}…" must not survive into the upstream payload`
    );
  }
});

test('The redaction fixture uses only synthetic values', () => {
  // 4111 1111 1111 1111 is the universal Visa test number; the domain is .invalid,
  // which RFC 2606 reserves precisely so it can never resolve.
  assert.ok(REDACTION_FIXTURE.text.includes('4111 1111 1111 1111'));
  assert.ok(REDACTION_FIXTURE.text.includes('example.invalid'));
});

// ---------------------------------------------------------------------------
// Injection fixture markers correspond to the real system prompts
// ---------------------------------------------------------------------------

test('Injection leak markers are drawn from the actual system instructions', () => {
  const modes = read('lib/server/modes.ts');

  // A marker that appears in no real prompt could never detect a leak.
  const grounded = INJECTION_FIXTURE.leakMarkers.filter((m) => modes.includes(m));
  assert.ok(
    grounded.length >= 3,
    `at least three leak markers must appear verbatim in lib/server/modes.ts (found ${grounded.length})`
  );
  assert.ok(
    INJECTION_FIXTURE.leakMarkers.includes('<untrusted_journal_data>'),
    'the fencing tag is the primary marker of a system-prompt leak'
  );
});

// ---------------------------------------------------------------------------
// A check must never pass vacuously
// ---------------------------------------------------------------------------

test('The bundle scan refuses to run against dev-server output', () => {
  // Found empirically: a running dev server replaces .next/static with a handful of
  // hot-update stubs. Scanning those finds nothing and would report "0 findings across
  // 3 files" -- a pass that proves nothing, which is exactly as dishonest as a hardcoded
  // one and rather more convincing.
  const code = codeOnly(read('lib/server/selftest/checks.ts'));

  assert.ok(
    code.includes('detectBundleKind'),
    'the scan must distinguish a production bundle from dev output'
  );
  assert.ok(code.includes("hot-update"), 'dev output must be detected by its markers');
  assert.ok(code.includes('BUILD_ID'), 'a production bundle is identified by its BUILD_ID');

  const section = code.slice(code.indexOf('async function clientBundleSecrets'));
  const guardIndex = section.indexOf("kind !== 'production'");
  const walkIndex = section.indexOf('await walk(root)');
  assert.ok(guardIndex > -1, 'the non-production case must be guarded');
  assert.ok(
    guardIndex < walkIndex,
    'the guard must precede the scan, or the vacuous pass still happens'
  );
});

test('Every non-production bundle state yields skipped, never pass', () => {
  const code = codeOnly(read('lib/server/selftest/checks.ts'));
  const section = code.slice(
    code.indexOf('async function clientBundleSecrets'),
    code.indexOf('async function redactionCoverage')
  );

  // Both early exits (wrong bundle kind, empty directory) must skip.
  const skips = section.match(/'skipped'/g) ?? [];
  assert.ok(skips.length >= 2, `both non-scannable states must skip (found ${skips.length})`);
});

// ---------------------------------------------------------------------------
// Guards on the page
// ---------------------------------------------------------------------------

test('The suite requires a recent sign-in', () => {
  assert.equal(SELFTEST_FRESH_AUTH_SECONDS, 600, 'the documented window is 10 minutes');

  const route = read('app/api/security/self-test/route.ts');
  assert.ok(route.includes('SELFTEST_FRESH_AUTH_SECONDS'));
  assert.ok(route.includes('STALE_AUTH'), 'a stale session must be refused with a code');
});

test('The page itself is rate limited', () => {
  const route = read('app/api/security/self-test/route.ts');
  assert.ok(route.includes('withinRunBudget'), 'runs per window must be capped');
  assert.ok(route.includes("'RUN_LIMIT'"));
});

test('Run records are server-authored and client-inaccessible', () => {
  const rules = read('firestore.rules');
  const start = rules.indexOf('match /selfTestRuns/');
  assert.ok(start > -1, 'selfTestRuns must have a rules block');
  assert.match(
    rules.slice(start, start + 200),
    /allow read, write: if false/,
    'a client that could write run records could fabricate a clean security run'
  );

  const route = read('app/api/security/self-test/route.ts');
  assert.ok(
    route.includes('const result = await runCheck('),
    'verdicts must be computed server-side'
  );
  assert.ok(
    !route.includes('body.result'),
    'the runner must never accept a result reported by the client'
  );
});

test('The audit event records counts and carries no payload content', () => {
  // Comments only, stripped: the surrounding documentation legitimately uses the words
  // "raw" and "payload" to explain why neither is written.
  const route = codeOnly(read('app/api/security/self-test/route.ts'));
  const section = route.slice(route.indexOf("action === 'finalize'"));

  assert.ok(section.includes("'security_selftest'"), 'the documented event type');
  assert.ok(section.includes('passed:') && section.includes('failed:'));
  // The raw responses live on the run document, never in the audit trail.
  assert.ok(!/\braw\b/.test(section), 'the audit event must not carry raw responses');
  assert.ok(!section.includes('observed'), 'the audit event must not carry check output');
});

// ---------------------------------------------------------------------------
// Rate-limit probe
// ---------------------------------------------------------------------------

test('The rate-limit probe shares the production limiter', () => {
  const echo = read('app/api/security/echo/route.ts');

  assert.ok(
    echo.includes("from '@/lib/server/rate-limit'"),
    'the probe must use the same limiter as every other route, not a copy'
  );
  assert.ok(echo.includes('checkRateLimit(user.uid)'));
  assert.ok(echo.includes('authenticateRequest'), 'the probe must be authenticated');
  // The shape the check asserts on.
  assert.ok(echo.includes("'Retry-After'"));
  assert.ok(echo.includes("error: 'RATE_LIMITED'"));
});

test('The rate-limit check fires exactly the documented limit plus one', () => {
  const code = read('lib/server/selftest/checks.ts');
  assert.ok(
    code.includes('LIMITS.RATE_LIMIT_PER_MINUTE + 1'),
    'the probe must be derived from the configured limit, not a magic number'
  );
  assert.equal(typeof LIMITS.RATE_LIMIT_PER_MINUTE, 'number');
});

test('RATE_LIMIT is ordered last because it exhausts the quota', () => {
  assert.equal(
    CHECKS[CHECKS.length - 1].id,
    'RATE_LIMIT',
    'any check after RATE_LIMIT would fail for the wrong reason'
  );
});

// ---------------------------------------------------------------------------
// Catalogue integrity
// ---------------------------------------------------------------------------

test('Every check names a directive and a covering test file that exists', () => {
  for (const check of CHECKS) {
    assert.ok(check.directive.length > 20, `${check.id} must state its directive`);
    assert.ok(check.directiveSource.length > 0, `${check.id} must cite its source`);
    assert.ok(
      fs.existsSync(path.join(ROOT, check.testFile)),
      `${check.id} links to ${check.testFile}, which does not exist`
    );
  }
});

test('All nine specified checks are present', () => {
  const expected = [
    'CROSS_TENANT_READ',
    'CROSS_TENANT_LIST',
    'UID_SPOOFING',
    'UNAUTHENTICATED_ACCESS',
    'PROMPT_INJECTION',
    'CLIENT_BUNDLE_SECRETS',
    'REDACTION_COVERAGE',
    'ADMIN_BLINDNESS',
    'RATE_LIMIT',
  ];
  assert.deepEqual(CHECKS.map((c) => c.id), expected);
});

// ---------------------------------------------------------------------------
// The self-test must not pollute the user's journal
// ---------------------------------------------------------------------------

test('Self-test model calls are real but are not persisted as journal entries', () => {
  const chat = read('app/api/journal/chat/route.ts');

  assert.ok(
    chat.includes('const selfTest = body?.selfTest === true;'),
    'the chat route must recognise a self-test invocation'
  );
  assert.ok(
    chat.includes('if (token && !selfTest) {'),
    'persistence must be suppressed for self-test calls'
  );
  // Everything the checks assert on must still run for real.
  const beforePersist = chat.slice(0, chat.indexOf('if (token && !selfTest) {'));
  assert.ok(
    beforePersist.includes('runPrivacyShield'),
    'redaction must still run on a self-test call'
  );
  assert.ok(
    beforePersist.includes('checkRateLimit') || chat.includes('checkRateLimit'),
    'rate limiting must still apply to a self-test call'
  );
});

test('The chat route echoes the token-resolved uid so spoofing is externally checkable', () => {
  const chat = read('app/api/journal/chat/route.ts');
  assert.ok(
    chat.includes('resolvedUid: user.uid'),
    'the resolved uid must come from the verified token'
  );
});

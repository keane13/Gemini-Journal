/**
 * @file tests/admin-rbac.test.ts
 * FEATURE 7 verification: blind administration, role escalation resistance,
 * fresh-auth enforcement on destructive actions, and mandatory audit.
 *
 * These tests are offline by design. The properties they assert are structural --
 * they hold because of what the rules and the code say, not because of a live backend --
 * so they act as regression guards on the invariants the console's promise depends on.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { verifyFirebaseIdToken } from '../lib/server/auth';
import {
  AdminError,
  FRESH_AUTH_WINDOW_SECONDS,
  isBootstrapAdmin,
  requireFreshAuth,
  withAdminAudit,
} from '../lib/server/admin';
import { SMALL_CELL_THRESHOLD, percentileFromHistogram, suppress } from '../lib/server/aggregates';
import { buildFleetMetrics } from '../lib/server/aggregates';
import { AggregateDocument, LATENCY_BUCKETS_MS } from '../lib/server/metrics';

const ROOT = path.join(__dirname, '..');
const RULES = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function fakeUser(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    uid: 'admin_1',
    email: 'admin@example.com',
    emailVerified: true,
    role: 'admin' as const,
    authTime: Math.floor(Date.now() / 1000),
    token: 'not-a-real-token',
    ...overrides,
  } as any;
}

// ---------------------------------------------------------------------------
// Token forgery: RBAC is only as strong as signature verification
// ---------------------------------------------------------------------------

test('RBAC foundation: an unsigned (alg=none) token claiming admin is rejected', async () => {
  const forged = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({
    sub: 'attacker',
    role: 'admin',
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}.`;

  await assert.rejects(() => verifyFirebaseIdToken(forged), /Unsupported token algorithm/);
});

test('RBAC foundation: a token with no key id is rejected rather than silently trusted', async () => {
  // This is the exact shape that previously bypassed verification entirely: without a
  // `kid` the old code skipped the signature check and returned a trusted identity.
  const forged = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
    sub: 'attacker',
    role: 'admin',
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
  })}.AAAA`;

  await assert.rejects(() => verifyFirebaseIdToken(forged), /missing a key id/);
});

test('RBAC foundation: an expired token is rejected before any key lookup', async () => {
  const forged = `${b64url({ alg: 'RS256', kid: 'abc', typ: 'JWT' })}.${b64url({
    sub: 'attacker',
    role: 'admin',
    exp: Math.floor(Date.now() / 1000) - 7200,
    iat: Math.floor(Date.now() / 1000) - 10800,
  })}.AAAA`;

  await assert.rejects(() => verifyFirebaseIdToken(forged), /expired/);
});

// ---------------------------------------------------------------------------
// A user cannot self-grant
// ---------------------------------------------------------------------------

test('User cannot self-grant: bootstrap requires membership in the server-side allowlist', () => {
  const previous = process.env.ADMIN_BOOTSTRAP_EMAILS;
  process.env.ADMIN_BOOTSTRAP_EMAILS = 'founder@example.com';

  try {
    assert.equal(
      isBootstrapAdmin({ email: 'attacker@example.com', emailVerified: true }),
      false,
      'an account outside the allowlist must never be bootstrap-eligible'
    );
    assert.equal(
      isBootstrapAdmin({ email: 'founder@example.com', emailVerified: true }),
      true,
      'the allowlisted account is bootstrap-eligible'
    );
  } finally {
    process.env.ADMIN_BOOTSTRAP_EMAILS = previous;
  }
});

test('User cannot self-grant: an unverified email is never bootstrap-eligible', () => {
  const previous = process.env.ADMIN_BOOTSTRAP_EMAILS;
  process.env.ADMIN_BOOTSTRAP_EMAILS = 'founder@example.com';

  try {
    // Otherwise anyone able to register the address without proving control could escalate.
    assert.equal(isBootstrapAdmin({ email: 'founder@example.com', emailVerified: false }), false);
    assert.equal(isBootstrapAdmin({ email: undefined, emailVerified: true }), false);
  } finally {
    process.env.ADMIN_BOOTSTRAP_EMAILS = previous;
  }
});

test('User cannot self-grant: an empty allowlist makes nobody bootstrap-eligible', () => {
  const previous = process.env.ADMIN_BOOTSTRAP_EMAILS;
  delete process.env.ADMIN_BOOTSTRAP_EMAILS;
  try {
    assert.equal(isBootstrapAdmin({ email: 'anyone@example.com', emailVerified: true }), false);
  } finally {
    if (previous !== undefined) process.env.ADMIN_BOOTSTRAP_EMAILS = previous;
  }
});

// ---------------------------------------------------------------------------
// Destructive actions require fresh auth
// ---------------------------------------------------------------------------

test('Destructive action without fresh auth_time is rejected', () => {
  const stale = fakeUser({
    authTime: Math.floor(Date.now() / 1000) - (FRESH_AUTH_WINDOW_SECONDS + 60),
  });

  assert.throws(
    () => requireFreshAuth(stale),
    (err: unknown) => err instanceof AdminError && err.code === 'STALE_AUTH' && err.status === 401
  );
});

test('Destructive action with a recent sign-in is permitted', () => {
  const fresh = fakeUser({ authTime: Math.floor(Date.now() / 1000) - 10 });
  assert.doesNotThrow(() => requireFreshAuth(fresh));
});

// ---------------------------------------------------------------------------
// Audit is mandatory for every admin action
// ---------------------------------------------------------------------------

test('Audit record written for every admin action (attempt and outcome)', async () => {
  const written: Array<{ phase: string; action: string; outcome: string }> = [];
  const writer = async (_req: any, _actor: any, params: any) => {
    written.push({ phase: params.phase, action: params.action, outcome: params.outcome });
    return true;
  };

  const result = await withAdminAudit(
    {} as any,
    fakeUser(),
    { action: 'ADMIN_SUSPEND_ACCOUNT', targetUid: 'victim_1' },
    async () => 'done',
    writer as any
  );

  assert.equal(result, 'done');
  assert.deepEqual(
    written.map((w) => w.phase),
    ['ATTEMPT', 'OUTCOME'],
    'an immutable attempt record must precede the action, and an outcome record follow it'
  );
  assert.ok(written.every((w) => w.action === 'ADMIN_SUSPEND_ACCOUNT'));
});

test('Admin action is REFUSED when the audit append fails (fail closed)', async () => {
  let actionRan = false;
  const failingWriter = async () => false;

  await assert.rejects(
    () =>
      withAdminAudit(
        {} as any,
        fakeUser(),
        { action: 'ADMIN_SUSPEND_ACCOUNT', targetUid: 'victim_1' },
        async () => {
          actionRan = true;
          return 'should not happen';
        },
        failingWriter as any
      ),
    (err: unknown) => err instanceof AdminError && err.code === 'AUDIT_WRITE_FAILED'
  );

  assert.equal(actionRan, false, 'no administrative action may run unaudited');
});

test('A failing admin action still records an ERROR outcome', async () => {
  const written: string[] = [];
  const writer = async (_req: any, _actor: any, params: any) => {
    written.push(`${params.phase}:${params.outcome}`);
    return true;
  };

  await assert.rejects(() =>
    withAdminAudit(
      {} as any,
      fakeUser(),
      { action: 'ADMIN_REVOKE_SESSIONS', targetUid: 'victim_1' },
      async () => {
        throw new Error('upstream exploded');
      },
      writer as any
    )
  );

  assert.deepEqual(written, ['ATTEMPT:SUCCESS', 'OUTCOME:ERROR']);
});

// ---------------------------------------------------------------------------
// Admin is denied user content -- structural invariants of firestore.rules
// ---------------------------------------------------------------------------

/**
 * Extracts the body of a `match <path> { ... }` block by brace balance.
 *
 * Path placeholders such as {userId} contain balanced braces of their own, so the scan
 * must start at the brace that opens the BODY -- the last `{` on the match line.
 */
function extractMatchBlock(rules: string, header: string): string {
  const start = rules.indexOf(header);
  assert.ok(start > -1, `rules must contain a "${header}" block`);

  const lineEnd = rules.indexOf('\n', start);
  const from = rules.lastIndexOf('{', lineEnd);
  assert.ok(from > start, `"${header}" must open a block on its own line`);

  let depth = 0;
  for (let i = from; i < rules.length; i++) {
    if (rules[i] === '{') depth++;
    else if (rules[i] === '}') {
      depth--;
      if (depth === 0) return rules.slice(from, i + 1);
    }
  }
  throw new Error('unbalanced braces in firestore.rules');
}

test('Admin denied on user content: no rule under /users consults the admin role', () => {
  const usersBlock = extractMatchBlock(RULES, 'match /users/{userId}');

  assert.ok(
    !/isAdmin\s*\(/.test(usersBlock),
    'the /users subtree must never call isAdmin() -- that would break blind administration'
  );
  assert.ok(
    !/token\.role/.test(usersBlock),
    'the /users subtree must never read request.auth.token.role'
  );
  assert.ok(
    /allow read, delete: if isOwner\(userId\)/.test(usersBlock),
    'journal entries must remain gated on ownership alone'
  );
});

test('Admin denied on user content: aggregates and audit are read-only to admins, unwritable by clients', () => {
  for (const collection of ['aggregates', 'adminAudit']) {
    const scoped = extractMatchBlock(RULES, `match /${collection}/`);
    assert.match(
      scoped,
      /allow read: if isAdmin\(\)/,
      `${collection} must be readable only by administrators`
    );
    assert.match(
      scoped,
      /allow write: if false/,
      `${collection} must reject all client writes`
    );
  }
});

test('Admin denied on user content: no admin route builds a privileged read of /users', () => {
  const adminRoutes = path.join(ROOT, 'app', 'api', 'admin');
  const offenders: string[] = [];

  for (const dir of fs.readdirSync(adminRoutes)) {
    const file = path.join(adminRoutes, dir, 'route.ts');
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, 'utf8');

    // The prove endpoint deliberately attempts a /users read -- with the admin's OWN
    // token, expecting denial. Every other admin route must not reference /users at all.
    if (dir === 'prove') {
      assert.ok(
        source.includes('admin.token'),
        'the prove endpoint must attribute its read to the admin ID token, not a service credential'
      );
      assert.ok(
        !source.includes('getGoogleAccessToken'),
        'the prove endpoint must never fall back to a rules-bypassing service credential'
      );
      continue;
    }
    if (/users\/\$\{/.test(source)) offenders.push(dir);
  }

  assert.deepEqual(offenders, [], 'admin routes must not construct /users/** read paths');
});

// ---------------------------------------------------------------------------
// Small-cell suppression
// ---------------------------------------------------------------------------

test('Small-cell suppression: cells below the threshold are withheld', () => {
  for (let users = 0; users < SMALL_CELL_THRESHOLD; users++) {
    const cell = suppress(9999, users);
    assert.equal(cell.suppressed, true, `${users} users must be suppressed`);
    assert.equal(cell.value, null, 'a suppressed cell must not leak its value');
    assert.equal(cell.users, null, 'a suppressed cell must not leak its population');
  }

  const ok = suppress(42, SMALL_CELL_THRESHOLD);
  assert.equal(ok.suppressed, false);
  assert.equal(ok.value, 42);
});

test('Small-cell suppression: a single-user fleet leaks nothing through the dashboard', () => {
  const doc: AggregateDocument = {
    day: '2026-09-06',
    activeUsers: 1,
    entriesCreated: 12,
    entriesCreatedUsers: 1,
    modelCalls: 30,
    modelCallUsers: 1,
    latencyHistogram: [0, 5, 10, 8, 4, 2, 1, 0, 0],
    latencyBucketsMs: [...LATENCY_BUCKETS_MS],
    tokensIn: 5000,
    tokensOut: 9000,
    redaction: { phone: [7, 1], email: [3, 1] },
    errors: { UPSTREAM_ERROR: [2, 1] },
    rateLimitHits: 4,
    rateLimitUsers: 1,
    updatedAt: new Date().toISOString(),
  };

  const metrics = buildFleetMetrics([doc], {
    start: '2026-09-06',
    end: '2026-09-06',
    missingDays: [],
  });

  assert.equal(metrics.dailyActiveUsers.suppressed, true);
  assert.equal(metrics.entriesCreated.suppressed, true);
  assert.equal(metrics.tokenSpend.total.suppressed, true);
  assert.equal(metrics.latency.p95Ms.suppressed, true);
  assert.deepEqual(metrics.redactionHistogram, [], 'single-user redaction categories are withheld');
  assert.deepEqual(metrics.errorsByCode, [], 'single-user error codes are withheld');
});

test('Small-cell suppression: a populated fleet renders real values', () => {
  const doc: AggregateDocument = {
    day: '2026-09-06',
    activeUsers: 40,
    entriesCreated: 120,
    entriesCreatedUsers: 30,
    modelCalls: 300,
    modelCallUsers: 25,
    latencyHistogram: [0, 100, 120, 50, 20, 8, 2, 0, 0],
    latencyBucketsMs: [...LATENCY_BUCKETS_MS],
    tokensIn: 50000,
    tokensOut: 90000,
    redaction: { phone: [70, 20], email: [30, 12] },
    errors: { UPSTREAM_ERROR: [6, 5] },
    rateLimitHits: 9,
    rateLimitUsers: 6,
    updatedAt: new Date().toISOString(),
  };

  const metrics = buildFleetMetrics([doc], {
    start: '2026-09-06',
    end: '2026-09-06',
    missingDays: [],
  });

  assert.equal(metrics.dailyActiveUsers.value, 40);
  assert.equal(metrics.entriesCreated.value, 120);
  assert.equal(metrics.tokenSpend.total.value, 140000);
  assert.equal(metrics.redactionHistogram.length, 2);
  assert.equal(metrics.errorsByCode[0].code, 'UPSTREAM_ERROR');
});

// ---------------------------------------------------------------------------
// Latency percentiles
// ---------------------------------------------------------------------------

test('Latency percentiles are computed from the additive bucket histogram', () => {
  // 100 samples: 50 in <=100ms, 45 in <=200ms, 5 in <=400ms.
  const histogram = [50, 45, 5, 0, 0, 0, 0, 0, 0];

  const p50 = percentileFromHistogram(histogram, 0.5);
  assert.equal(p50.ms, 100);
  assert.equal(p50.samples, 100);

  const p95 = percentileFromHistogram(histogram, 0.95);
  assert.equal(p95.ms, 200);
  assert.equal(p95.isLowerBound, false);
});

test('Latency percentiles flag the open-ended top bucket as a lower bound', () => {
  const histogram = [0, 0, 0, 0, 0, 0, 0, 0, 10];
  const p95 = percentileFromHistogram(histogram, 0.95);
  assert.equal(p95.isLowerBound, true, 'a percentile in the overflow bucket is a lower bound');
});

test('Latency percentiles handle an empty histogram without dividing by zero', () => {
  const p50 = percentileFromHistogram([0, 0, 0, 0, 0, 0, 0, 0, 0], 0.5);
  assert.equal(p50.samples, 0);
  assert.equal(p50.ms, 0);
});

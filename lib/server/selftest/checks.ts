/**
 * @file lib/server/selftest/checks.ts
 * FEATURE 10: the attacks themselves.
 *
 * Each function performs a real operation against the running system and derives its
 * verdict from what came back. Nothing here returns a predetermined result, and nothing
 * sleeps to simulate work — the elapsed time reported to the UI is the genuine duration
 * of a real network call, filesystem scan, or model round-trip.
 *
 * Where a check cannot be performed honestly (no fixture tenant configured, caller is not
 * an administrator, no built bundle on disk), it returns `skipped` with the reason rather
 * than a pass. A green tick that was never earned is worse than an amber one.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

import { VerifiedAuthUser } from '@/lib/server/auth';
import { rawGetDocument } from '@/lib/server/firestore-rest';
import { LIMITS } from '@/lib/config';
import firebaseConfig from '@/firebase-applet-config.json';
import { CheckId, CheckResult } from './types';
import {
  FIXTURE_ENTRY_ID,
  INJECTION_FIXTURE,
  REDACTION_FIXTURE,
  ensureFixtureSeeded,
  getFixtureUid,
} from './fixtures';

/** Caps any raw response carried back to the browser. */
const RAW_LIMIT = 2000;

function truncate(text: string, limit = RAW_LIMIT): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…[truncated]`;
}

function result(
  id: CheckId,
  status: CheckResult['status'],
  observed: string,
  raw: string,
  startedAt: number,
  extra: Partial<CheckResult> = {}
): CheckResult {
  return {
    id,
    status,
    observed,
    raw: truncate(raw),
    elapsedMs: Date.now() - startedAt,
    at: new Date().toISOString(),
    ...extra,
  };
}

export interface CheckContext {
  user: VerifiedAuthUser;
  /** Absolute origin of the running app, used to attack its own routes over real HTTP. */
  appUrl: string;
}

// ---------------------------------------------------------------------------
// 1 & 2. Cross-tenant isolation
// ---------------------------------------------------------------------------

async function crossTenant(
  id: 'CROSS_TENANT_READ' | 'CROSS_TENANT_LIST',
  ctx: CheckContext
): Promise<CheckResult> {
  const startedAt = Date.now();
  const fixtureUid = getFixtureUid();

  if (!fixtureUid) {
    return result(
      id,
      'skipped',
      'No fixture tenant is configured.',
      '',
      startedAt,
      {
        skipReason:
          'SELFTEST_FIXTURE_UID is unset. The probe needs a synthetic tenant to target; ' +
          'it will not be pointed at a real account.',
      }
    );
  }
  if (fixtureUid === ctx.user.uid) {
    return result(id, 'skipped', 'Fixture uid equals the caller.', '', startedAt, {
      skipReason:
        'You are signed in as the fixture account, so reading it would be permitted and ' +
        'would prove nothing.',
    });
  }

  // Seeding matters: without a document that genuinely exists, a 404 could be mistaken
  // for a denial and the check would pass for the wrong reason.
  let seeded = false;
  try {
    seeded = await ensureFixtureSeeded(fixtureUid);
  } catch {
    seeded = false;
  }

  const target =
    id === 'CROSS_TENANT_READ'
      ? `users/${fixtureUid}/entries/${FIXTURE_ENTRY_ID}`
      : `users/${fixtureUid}/entries`;

  // The decisive line: the caller's OWN ID token is used, so Firestore rules decide.
  const res = await rawGetDocument(target, ctx.user.token);

  let firestoreStatus: string | null = null;
  try {
    firestoreStatus = JSON.parse(res.body)?.error?.status ?? null;
  } catch {
    firestoreStatus = null;
  }

  const denied = res.status === 403 || firestoreStatus === 'PERMISSION_DENIED';

  return result(
    id,
    denied ? 'pass' : 'fail',
    denied
      ? `Firestore refused the read: HTTP ${res.status}${firestoreStatus ? ` ${firestoreStatus}` : ''}.`
      : `Expected a denial, observed HTTP ${res.status}. This is a cross-tenant exposure.`,
    `${res.url}\n\nHTTP ${res.status}\n\n${res.body}`,
    startedAt,
    { detail: { target, fixtureSeeded: seeded, httpStatus: res.status, firestoreStatus } }
  );
}

// ---------------------------------------------------------------------------
// 3. Client-supplied uid must be ignored
// ---------------------------------------------------------------------------

async function uidSpoofing(ctx: CheckContext): Promise<CheckResult> {
  const startedAt = Date.now();
  const forgedUid = getFixtureUid() ?? 'attacker_uid_000000';

  const res = await fetch(`${ctx.appUrl}/api/journal/chat`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ctx.user.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      // A valid token, but the body claims to be somebody else.
      uid: forgedUid,
      userId: forgedUid,
      prompt: 'Self-test: verifying that the server ignores a client-supplied uid.',
      mode: 'reflection',
      privacyMode: 'standard',
      selfTest: true,
    }),
    cache: 'no-store',
  });

  const text = await res.text();
  let resolvedUid: string | null = null;
  try {
    resolvedUid = JSON.parse(text)?.resolvedUid ?? null;
  } catch {
    resolvedUid = null;
  }

  const boundToToken = resolvedUid === ctx.user.uid;
  const ignoredBody = resolvedUid !== forgedUid;
  const ok = res.ok && boundToToken && ignoredBody;

  return result(
    'UID_SPOOFING',
    ok ? 'pass' : 'fail',
    ok
      ? `The server resolved ${resolvedUid} from the token and discarded the body uid ${forgedUid}.`
      : `Expected the token uid ${ctx.user.uid}; the server reported ${resolvedUid ?? 'nothing'}.`,
    `POST ${ctx.appUrl}/api/journal/chat\nbody.uid = ${forgedUid}\n\nHTTP ${res.status}\n\n${text}`,
    startedAt,
    { detail: { forgedUid, tokenUid: ctx.user.uid, resolvedUid, httpStatus: res.status } }
  );
}

// ---------------------------------------------------------------------------
// 4. Unauthenticated access
// ---------------------------------------------------------------------------

async function unauthenticatedAccess(ctx: CheckContext): Promise<CheckResult> {
  const startedAt = Date.now();

  const res = await fetch(`${ctx.appUrl}/api/journal/chat`, {
    method: 'POST',
    // No Authorization header at all.
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'Self-test: unauthenticated probe.', mode: 'reflection' }),
    cache: 'no-store',
  });

  const text = await res.text();
  const leaked = /geminiResponse/.test(text);
  const ok = res.status === 401 && !leaked;

  return result(
    'UNAUTHENTICATED_ACCESS',
    ok ? 'pass' : 'fail',
    ok
      ? 'The route rejected the unauthenticated request with HTTP 401 and returned no model output.'
      : `Expected HTTP 401 with no model output; observed HTTP ${res.status}${leaked ? ' WITH model output' : ''}.`,
    `POST ${ctx.appUrl}/api/journal/chat (no Authorization header)\n\nHTTP ${res.status}\n\n${text}`,
    startedAt,
    { detail: { httpStatus: res.status, returnedModelOutput: leaked } }
  );
}

// ---------------------------------------------------------------------------
// 5. Prompt injection
// ---------------------------------------------------------------------------

async function promptInjection(ctx: CheckContext): Promise<CheckResult> {
  const startedAt = Date.now();

  const res = await fetch(`${ctx.appUrl}/api/journal/chat`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ctx.user.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt: INJECTION_FIXTURE.text,
      mode: 'reflection',
      privacyMode: 'standard',
      selfTest: true,
    }),
    cache: 'no-store',
  });

  const text = await res.text();
  let reply = '';
  try {
    reply = JSON.parse(text)?.geminiResponse ?? '';
  } catch {
    reply = '';
  }

  if (!res.ok) {
    return result(
      'PROMPT_INJECTION',
      'error',
      `The model path returned HTTP ${res.status}, so containment could not be assessed.`,
      `HTTP ${res.status}\n\n${text}`,
      startedAt,
      { detail: { httpStatus: res.status } }
    );
  }

  const leakedMarkers = INJECTION_FIXTURE.leakMarkers.filter((m) =>
    reply.toLowerCase().includes(m.toLowerCase())
  );
  const leakedForeign = INJECTION_FIXTURE.foreignDataMarkers.filter((m) =>
    reply.toLowerCase().includes(m.toLowerCase())
  );

  const contained = leakedMarkers.length === 0 && leakedForeign.length === 0;

  return result(
    'PROMPT_INJECTION',
    contained ? 'pass' : 'fail',
    contained
      ? 'The reply contained no system-prompt markers and no foreign-tenant data.'
      : `Containment failed. Leaked: ${[...leakedMarkers, ...leakedForeign].join(', ')}.`,
    // The model's ACTUAL reply, shown in full so the verdict can be checked by eye.
    `Injection sent:\n${INJECTION_FIXTURE.text}\n\n--- Model reply ---\n${reply}`,
    startedAt,
    {
      detail: {
        leakedMarkers,
        leakedForeignData: leakedForeign,
        replyLength: reply.length,
      },
    }
  );
}

// ---------------------------------------------------------------------------
// 6. Client bundle secret scan
// ---------------------------------------------------------------------------

/**
 * Key-shaped strings. Deliberately matched by SHAPE rather than by value, so a key this
 * codebase has never seen is still caught.
 */
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'Google API key (AIza…)', re: /AIza[0-9A-Za-z_\-]{35}/g },
  { name: 'Service account marker', re: /"type"\s*:\s*"service_account"/g },
  { name: 'PEM private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'private_key_id field', re: /"private_key_id"\s*:/g },
  { name: 'Google OAuth client secret', re: /GOCSPX-[0-9A-Za-z_\-]{20,}/g },
  /**
   * AI Studio / Secret Manager handle, shaped "AQ." followed by a long opaque token.
   *
   * Added after this scanner missed a real one: a Cloud Run service export sitting in the
   * working tree carried a live GEMINI_API_KEY in this format, and every pattern above
   * looked straight past it because it is not shaped like `AIza…`. A scanner that only
   * knows the formats you thought of is a scanner that reassures you while missing the
   * leak that actually happens.
   */
  { name: 'AI Studio / Secret Manager handle', re: /AQ\.[A-Za-z0-9_\-]{30,}/g },
];

/**
 * The Firebase Web API key is intentionally public (it identifies the project and is
 * protected by Firestore rules, not by secrecy), so it must not be reported as a finding.
 * It is excluded by exact value only — never by pattern, which would blind the scan.
 */
function publicFirebaseKeys(): string[] {
  // Both known sources: the env override, and the checked-in config the client falls
  // back to when that override is unset. Missing the second would make this check report
  // a false failure on every run, which is how a security page teaches people to ignore it.
  const keys = [
    (process.env.NEXT_PUBLIC_FIREBASE_API_KEY || '').trim(),
    ((firebaseConfig as { apiKey?: string }).apiKey || '').trim(),
  ];
  return [...new Set(keys.filter(Boolean))];
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else if (/\.(js|mjs|css|json|map|txt|html)$/.test(e.name)) out.push(full);
  }
  return out;
}

/**
 * Distinguishes a production bundle from dev-server output.
 *
 * This matters more than it looks. A running dev server overwrites `.next/static` with a
 * handful of hot-update stubs. Scanning those finds nothing and would report
 * "0 findings across 3 files" — a VACUOUS PASS, which is exactly as dishonest as a
 * hardcoded one and considerably more convincing. The check must skip instead.
 */
async function detectBundleKind(
  root: string
): Promise<{ kind: 'production' | 'development' | 'absent'; buildId: string | null }> {
  let buildId: string | null = null;
  try {
    buildId = (await fs.readFile(path.join(process.cwd(), '.next', 'BUILD_ID'), 'utf8')).trim();
  } catch {
    buildId = null;
  }

  // Unambiguous dev markers, checked before anything else.
  for (const marker of ['development', 'webpack']) {
    try {
      const entries = await fs.readdir(path.join(root, marker));
      if (entries.some((e) => e.includes('hot-update') || e.startsWith('_'))) {
        return { kind: 'development', buildId };
      }
    } catch {
      /* marker absent — keep looking */
    }
  }

  try {
    await fs.access(root);
  } catch {
    return { kind: 'absent', buildId };
  }

  return { kind: buildId ? 'production' : 'development', buildId };
}

async function clientBundleSecrets(): Promise<CheckResult> {
  const startedAt = Date.now();
  const root = path.join(process.cwd(), '.next', 'static');

  const { kind, buildId } = await detectBundleKind(root);
  if (kind !== 'production') {
    return result(
      'CLIENT_BUNDLE_SECRETS',
      'skipped',
      kind === 'development'
        ? 'Only dev-server output is present, not a production bundle.'
        : 'No built client bundle found on disk.',
      `Scan root: ${path.relative(process.cwd(), root)}
BUILD_ID: ${buildId ?? '(absent)'}
Detected: ${kind}`,
      startedAt,
      {
        skipReason:
          kind === 'development'
            ? 'A running dev server replaces .next/static with hot-update stubs. Scanning ' +
              'those would find nothing and report a pass that proves nothing, so this ' +
              'check refuses to run. Stop the dev server, run `npm run build`, and retry.'
            : 'This check scans .next/static, which exists only after `npm run build`.',
        detail: { bundleKind: kind, buildId },
      }
    );
  }

  const files = await walk(root);
  if (files.length === 0) {
    return result(
      'CLIENT_BUNDLE_SECRETS',
      'skipped',
      'The production bundle directory contains no scannable assets.',
      root,
      startedAt,
      { skipReason: 'Nothing to scan means nothing was proven.' }
    );
  }

  const allowed = publicFirebaseKeys();
  const findings: Array<{ file: string; pattern: string; offset: number }> = [];
  // Counted and reported rather than silently dropped, so the reader can disagree.
  let excluded = 0;
  let bytes = 0;

  for (const file of files) {
    let content = '';
    try {
      content = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    bytes += Buffer.byteLength(content);

    for (const { name, re } of SECRET_PATTERNS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        // Never report the matched secret itself — only where it was found.
        if (allowed.includes(m[0])) {
          excluded += 1;
          continue;
        }
        findings.push({
          file: path.relative(process.cwd(), file),
          pattern: name,
          offset: m.index,
        });
      }
    }
  }

  const clean = findings.length === 0;

  return result(
    'CLIENT_BUNDLE_SECRETS',
    clean ? 'pass' : 'fail',
    clean
      ? `Scanned ${files.length} client assets (${bytes.toLocaleString()} bytes). No key-shaped strings found.`
      : `Found ${findings.length} key-shaped string(s) in the client bundle.`,
    clean
      ? [
          `Scanned root: ${path.relative(process.cwd(), root)}`,
          `BUILD_ID: ${buildId ?? '(absent)'}`,
          `Files: ${files.length}`,
          `Bytes: ${bytes}`,
          `Patterns checked: ${SECRET_PATTERNS.map((p) => p.name).join(', ')}`,
          '',
          `Known-public values excluded by exact match: ${excluded}`,
          '  The Firebase Web API key is public by design — it identifies the project and',
          '  is protected by Firestore rules, not by secrecy. It is excluded by VALUE, not',
          '  by pattern, so a genuinely secret Google key would still be reported here.',
        ].join('\n')
      : `Findings (locations only; matched values are deliberately not printed):\n${findings
          .map((f) => `  ${f.file} @${f.offset} — ${f.pattern}`)
          .join('\n')}`,
    startedAt,
    {
      detail: {
        bundleKind: kind,
        buildId,
        filesScanned: files.length,
        bytesScanned: bytes,
        findings: findings.length,
        knownPublicExcluded: excluded,
        patterns: SECRET_PATTERNS.map((p) => p.name),
      },
    }
  );
}

// ---------------------------------------------------------------------------
// 7. Redaction coverage
// ---------------------------------------------------------------------------

async function redactionCoverage(ctx: CheckContext): Promise<CheckResult> {
  const startedAt = Date.now();

  const res = await fetch(`${ctx.appUrl}/api/journal/chat`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ctx.user.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt: REDACTION_FIXTURE.text,
      mode: 'reflection',
      privacyMode: 'standard',
      selfTest: true,
    }),
    cache: 'no-store',
  });

  const text = await res.text();
  let details: any = null;
  try {
    details = JSON.parse(text)?.redactionDetails ?? null;
  } catch {
    details = null;
  }

  if (!res.ok || !details) {
    return result(
      'REDACTION_COVERAGE',
      'error',
      `Could not obtain the egress payload (HTTP ${res.status}).`,
      `HTTP ${res.status}\n\n${text}`,
      startedAt,
      { detail: { httpStatus: res.status } }
    );
  }

  const histogram: Record<string, number> = details.categoryCounts ?? {};
  const upstream: string = details.redactedPayload ?? '';

  const missing = REDACTION_FIXTURE.expectedCategories.filter(
    (c) => !(histogram[c] > 0)
  );
  // The decisive assertion: no raw value may survive into what actually left the server.
  const survivors = REDACTION_FIXTURE.rawValues.filter((v) => upstream.includes(v));

  const ok = missing.length === 0 && survivors.length === 0;

  return result(
    'REDACTION_COVERAGE',
    ok ? 'pass' : 'fail',
    ok
      ? `All ${REDACTION_FIXTURE.expectedCategories.length} categories masked; no raw value survived into the upstream payload.`
      : [
          missing.length ? `Not masked: ${missing.join(', ')}.` : '',
          survivors.length ? `Raw values still present upstream: ${survivors.length}.` : '',
        ]
          .filter(Boolean)
          .join(' '),
    `Masked histogram:\n${JSON.stringify(histogram, null, 2)}\n\n--- Exact payload sent upstream ---\n${upstream}`,
    startedAt,
    {
      detail: {
        histogram,
        missingCategories: missing,
        // Count only. Printing a surviving raw value here would leak it a second time.
        survivingRawValues: survivors.length,
      },
    }
  );
}

// ---------------------------------------------------------------------------
// 8. Admin blindness
// ---------------------------------------------------------------------------

async function adminBlindness(ctx: CheckContext): Promise<CheckResult> {
  const startedAt = Date.now();

  if (ctx.user.role !== 'admin') {
    return result(
      'ADMIN_BLINDNESS',
      'skipped',
      'The current account holds no administrator claim.',
      '',
      startedAt,
      {
        skipReason:
          'This check attempts an administrator read. Signed in as a normal user there is ' +
          'no admin token to attempt it with, and passing it here would prove nothing.',
      }
    );
  }

  const fixtureUid = getFixtureUid();
  if (!fixtureUid || fixtureUid === ctx.user.uid) {
    return result(
      'ADMIN_BLINDNESS',
      'skipped',
      'No fixture tenant available to read against.',
      '',
      startedAt,
      { skipReason: 'SELFTEST_FIXTURE_UID is unset or equals the caller.' }
    );
  }

  try {
    await ensureFixtureSeeded(fixtureUid);
  } catch {
    /* a missing fixture only weakens the evidence; the denial is still meaningful */
  }

  const target = `users/${fixtureUid}/entries/${FIXTURE_ENTRY_ID}`;
  const res = await rawGetDocument(target, ctx.user.token);

  let firestoreStatus: string | null = null;
  try {
    firestoreStatus = JSON.parse(res.body)?.error?.status ?? null;
  } catch {
    firestoreStatus = null;
  }

  const denied = res.status === 403 || firestoreStatus === 'PERMISSION_DENIED';

  return result(
    'ADMIN_BLINDNESS',
    denied ? 'pass' : 'fail',
    denied
      ? `Firestore refused an administrator read of another account's entry: HTTP ${res.status}.`
      : `SECURITY REGRESSION: the administrator token was NOT denied (HTTP ${res.status}).`,
    `${res.url}\nattributed to admin uid ${ctx.user.uid} (role=admin)\n\nHTTP ${res.status}\n\n${res.body}`,
    startedAt,
    { detail: { target, httpStatus: res.status, firestoreStatus, adminUid: ctx.user.uid } }
  );
}

// ---------------------------------------------------------------------------
// 9. Rate limit
// ---------------------------------------------------------------------------

/**
 * Fires the documented limit plus one against a real, authenticated, rate-limited route.
 *
 * The probe target is /api/security/echo rather than the chat route. That endpoint shares
 * the SAME per-uid limiter as every other route — exhausting it genuinely exhausts the
 * caller's quota, and the next real journal request will be refused too — but it makes no
 * model call, so verifying the limiter does not cost 26 Gemini requests.
 */
async function rateLimit(ctx: CheckContext): Promise<CheckResult> {
  const startedAt = Date.now();
  const attempts = LIMITS.RATE_LIMIT_PER_MINUTE + 1;

  const statuses: number[] = [];
  let firstRejection: { status: number; body: string; retryAfter: string | null } | null = null;

  for (let i = 0; i < attempts; i++) {
    const res = await fetch(`${ctx.appUrl}/api/security/echo`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ctx.user.token}` },
      cache: 'no-store',
    });
    statuses.push(res.status);

    if (res.status === 429 && !firstRejection) {
      firstRejection = {
        status: res.status,
        body: await res.text(),
        retryAfter: res.headers.get('Retry-After'),
      };
    } else if (res.status === 429) {
      await res.text();
    } else {
      await res.text();
    }
  }

  if (!firstRejection) {
    return result(
      'RATE_LIMIT',
      'fail',
      `Fired ${attempts} requests against a limit of ${LIMITS.RATE_LIMIT_PER_MINUTE}; no 429 was returned.`,
      `Statuses observed: ${statuses.join(', ')}`,
      startedAt,
      { detail: { attempts, limit: LIMITS.RATE_LIMIT_PER_MINUTE, statuses } }
    );
  }

  // The documented shape: 429 + Retry-After + a structured error body.
  let shapeOk = false;
  let parsed: any = null;
  try {
    parsed = JSON.parse(firstRejection.body);
    shapeOk = typeof parsed?.error === 'string' && typeof parsed?.message === 'string';
  } catch {
    shapeOk = false;
  }

  const hasRetryAfter = Boolean(firstRejection.retryAfter);
  const ok = shapeOk && hasRetryAfter;

  return result(
    'RATE_LIMIT',
    ok ? 'pass' : 'fail',
    ok
      ? `Rejected at request ${statuses.indexOf(429) + 1} of ${attempts} with HTTP 429 and Retry-After: ${firstRejection.retryAfter}.`
      : `A 429 was returned but the shape is wrong${hasRetryAfter ? '' : ' (missing Retry-After)'}${shapeOk ? '' : ' (body is not {error, message})'}.`,
    `Statuses: ${statuses.join(', ')}\n\nFirst rejection:\nHTTP ${firstRejection.status}\nRetry-After: ${firstRejection.retryAfter ?? '(absent)'}\n\n${firstRejection.body}`,
    startedAt,
    {
      detail: {
        attempts,
        limit: LIMITS.RATE_LIMIT_PER_MINUTE,
        rejectedAt: statuses.indexOf(429) + 1,
        retryAfter: firstRejection.retryAfter,
        bodyShapeValid: shapeOk,
      },
    }
  );
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function runCheck(id: CheckId, ctx: CheckContext): Promise<CheckResult> {
  const startedAt = Date.now();
  try {
    switch (id) {
      case 'CROSS_TENANT_READ':
      case 'CROSS_TENANT_LIST':
        return await crossTenant(id, ctx);
      case 'UID_SPOOFING':
        return await uidSpoofing(ctx);
      case 'UNAUTHENTICATED_ACCESS':
        return await unauthenticatedAccess(ctx);
      case 'PROMPT_INJECTION':
        return await promptInjection(ctx);
      case 'CLIENT_BUNDLE_SECRETS':
        return await clientBundleSecrets();
      case 'REDACTION_COVERAGE':
        return await redactionCoverage(ctx);
      case 'ADMIN_BLINDNESS':
        return await adminBlindness(ctx);
      case 'RATE_LIMIT':
        return await rateLimit(ctx);
      default:
        return result(id, 'error', 'Unknown check.', '', startedAt);
    }
  } catch (err) {
    // An exception is reported as an error, never quietly as a pass.
    return result(
      id,
      'error',
      err instanceof Error ? err.message : 'The check threw an unexpected error.',
      err instanceof Error ? (err.stack ?? err.message) : String(err),
      startedAt
    );
  }
}

/**
 * @file tests/retention.test.ts
 * FEATURE 11 verification: Managed Forgetting.
 *
 * The claim being defended is unusually strong — that past the window the details are
 * permanently gone, by every code path, including an administrator's. A claim like that
 * fails silently: nothing breaks if plaintext quietly survives somewhere, and nobody
 * notices until it matters. So most of these tests are structural, asserting that no
 * second copy of the plaintext exists to be forgotten from.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import {
  DEFAULT_RETENTION,
  MINIMUM_RETENTION_DAYS,
  RETENTION_OPTIONS,
  computeRetentionState,
  forgottenLabel,
  isEligibleForForgetting,
  isValidRetention,
  normalizeRetentionPolicy,
  rehydrate,
} from '../lib/server/retention';
import { openUnderDek, sealUnderDek } from '../lib/server/kms';

const ROOT = path.join(__dirname, '..');
const DAY = 86400000;

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
// Policy
// ---------------------------------------------------------------------------

test('The default window is 90 days and "off" is not offered', () => {
  assert.equal(DEFAULT_RETENTION, 90);
  assert.deepEqual([...RETENTION_OPTIONS], [30, 90, 365, 'never']);
  assert.equal(MINIMUM_RETENTION_DAYS, 30);

  // Anything below the floor, and zero in particular, must be rejected outright.
  for (const bad of [0, 1, 7, 29, -1, 'off', null, undefined]) {
    assert.equal(isValidRetention(bad), false, `${String(bad)} must not be a valid window`);
  }
});

test('A corrupt policy document falls back to the default, never to "never"', () => {
  // Failing open to indefinite retention would silently upgrade someone's exposure.
  for (const corrupt of [{}, { window: 'forever' }, { window: 0 }, { window: null }, null]) {
    assert.equal(normalizeRetentionPolicy(corrupt).window, DEFAULT_RETENTION);
  }
  assert.equal(normalizeRetentionPolicy({ window: 'never' }).window, 'never');
  assert.equal(normalizeRetentionPolicy({ window: 30 }).window, 30);
});

// ---------------------------------------------------------------------------
// Window arithmetic
// ---------------------------------------------------------------------------

test('Retention state reports days remaining while inside the window', () => {
  const now = new Date('2026-06-12T12:00:00Z');
  const created = new Date(now.getTime() - 56 * DAY).toISOString();

  const state = computeRetentionState(created, 90, true, now);
  assert.equal(state.status, 'retained');
  assert.equal(state.daysRemaining, 34);
  assert.equal(state.label, 'Details expire in 34 days');
  assert.ok(state.elapsedFraction! > 0.6 && state.elapsedFraction! < 0.65);
});

test('A forgotten entry says so, regardless of what the dates imply', () => {
  const now = new Date('2026-06-12T12:00:00Z');
  const created = new Date(now.getTime() - 1 * DAY).toISOString();

  // Payload absent one day into a 365-day window: the data is genuinely gone, and the
  // arithmetic must not be allowed to claim otherwise.
  const state = computeRetentionState(created, 365, false, now);
  assert.equal(state.status, 'forgotten');
  assert.equal(state.elapsedFraction, 1);

  assert.equal(
    forgottenLabel('2026-06-12T00:00:00Z'),
    'Details forgotten on 12 Jun 2026'
  );
});

test('"never" reports indefinite retention and never expires', () => {
  const now = new Date('2026-06-12T12:00:00Z');
  const created = new Date(now.getTime() - 4000 * DAY).toISOString();

  const state = computeRetentionState(created, 'never', true, now);
  assert.equal(state.status, 'never');
  assert.equal(state.expiresAt, null);
  assert.equal(isEligibleForForgetting(created, 'never', now), false);
});

test('Eligibility flips exactly at the window boundary', () => {
  const now = new Date('2026-06-12T12:00:00Z');

  const justInside = new Date(now.getTime() - 90 * DAY + 1000).toISOString();
  const justPast = new Date(now.getTime() - 90 * DAY - 1000).toISOString();

  assert.equal(isEligibleForForgetting(justInside, 90, now), false);
  assert.equal(isEligibleForForgetting(justPast, 90, now), true);
});

// ---------------------------------------------------------------------------
// The forgetting job destroys payloads and NOTHING else
// ---------------------------------------------------------------------------

test('The forgetting job writes only the payload and its tombstone', () => {
  const code = codeOnly(read('app/api/cron/forget/route.ts'));

  // The single destructive write, and the fields it is allowed to set.
  assert.ok(code.includes('rehydration: null'), 'the payload must be destroyed');
  assert.ok(code.includes('forgottenAt: now.toISOString()'), 'a tombstone date is recorded');

  // It must never touch the body, the title, or anything derived from them.
  for (const forbidden of ['content:', 'title:', 'moodScore:', 'summary:', 'messages/']) {
    assert.ok(
      !code.includes(forbidden),
      `the forgetting job must not write ${forbidden} — it destroys details, not entries`
    );
  }
  // Commitments and chunks are separate subcollections and must be untouched.
  assert.ok(!code.includes('/commitments'), 'commitments must survive forgetting');
  assert.ok(!code.includes('/chunks'), 'recall chunks must survive forgetting');
});

test('The job skips "never", un-expired entries, and entries already forgotten', () => {
  const code = codeOnly(read('app/api/cron/forget/route.ts'));

  assert.ok(
    code.includes("if (!entry.rehydration) continue;"),
    'an entry with no payload must be skipped, so a second run is a no-op'
  );
  assert.ok(code.includes("window === 'never'"), '"never" must be skipped');
  assert.ok(
    code.includes('isEligibleForForgetting'),
    'entries inside their window must be skipped'
  );
});

test('An entry keeps the window in force when it was written', () => {
  // Otherwise lengthening the policy would retroactively resurrect entries that were
  // already due to be forgotten.
  const code = codeOnly(read('app/api/cron/forget/route.ts'));
  assert.ok(
    code.includes('isValidRetention(entry.retentionWindow)'),
    "the entry's own window takes precedence over the current policy"
  );
});

// ---------------------------------------------------------------------------
// A forgotten entry cannot be rehydrated by ANY path, including admin
// ---------------------------------------------------------------------------

test('Rehydration of a forgotten entry returns the redacted text unchanged', () => {
  // rehydrate() is the only function that substitutes plaintext back in. With no map --
  // which is what a destroyed payload yields -- it is the identity function.
  const redacted = 'Dia minta aku follow up ke [EMAIL_1] sebelum Jumat.';

  assert.equal(rehydrate(redacted, null), redacted);
  assert.equal(rehydrate(redacted, {}), redacted);

  // And with a map, it does substitute -- so the null case is a real guarantee, not a
  // function that never worked.
  assert.equal(
    rehydrate(redacted, { '[EMAIL_1]': 'budi@example.invalid' }),
    'Dia minta aku follow up ke budi@example.invalid sebelum Jumat.'
  );
});

test('No admin route can reach a rehydration payload', () => {
  const adminDir = path.join(ROOT, 'app', 'api', 'admin');
  for (const dir of fs.readdirSync(adminDir)) {
    const file = path.join(adminDir, dir, 'route.ts');
    if (!fs.existsSync(file)) continue;
    const code = fs.readFileSync(file, 'utf8');

    assert.ok(
      !code.includes('openRehydrationMap') && !code.includes('unwrapDek'),
      `app/api/admin/${dir} must not be able to open a rehydration payload`
    );
  }
});

test('Only the rehydrate route opens a payload, and only as the signed-in user', () => {
  const code = read('app/api/journal/rehydrate/route.ts');

  assert.ok(code.includes('openRehydrationMap(user.uid'), 'opened under the caller uid');
  // The entry is fetched with the caller's own token, so Firestore rules decide.
  assert.ok(
    code.includes('`users/${user.uid}/entries/${entryId}`, token'),
    'the entry must be read with the caller\'s ID token, not a service credential'
  );
  assert.ok(
    !code.includes('getGoogleAccessToken'),
    'the rehydrate route must never use a rules-bypassing credential'
  );
});

// ---------------------------------------------------------------------------
// Shortening the window destroys immediately
// ---------------------------------------------------------------------------

test('Shortening requires a typed confirmation and destroys in the same request', () => {
  const code = read('app/api/retention/settings/route.ts');

  assert.ok(code.includes('SHORTEN_CONFIRM_PHRASE'), 'a typed phrase is required');
  assert.ok(code.includes('SHORTEN_CONFIRM_REQUIRED'), 'and refused without it');

  const section = codeOnly(code).slice(codeOnly(code).indexOf('let forgotten = 0;'));
  assert.ok(section.includes('rehydration: null'), 'shortening destroys payloads at once');
  assert.ok(
    section.includes('isEligibleForForgetting'),
    'only entries outside the NEW window are destroyed'
  );
});

test('Lengthening the window needs no confirmation', () => {
  const code = codeOnly(read('app/api/retention/settings/route.ts'));
  // The gate is on `shortening` specifically; nothing is lost by keeping details longer.
  assert.ok(
    code.includes('if (shortening && body?.confirm !== SHORTEN_CONFIRM_PHRASE)'),
    'the confirmation gate must apply only to shortening'
  );
});

// ---------------------------------------------------------------------------
// No second copy of the plaintext exists to be forgotten from
// ---------------------------------------------------------------------------

test('The canonical stored body is the redacted text, on every write path', () => {
  const chat = codeOnly(read('app/api/journal/chat/route.ts'));
  const save = codeOnly(read('app/api/journal/save/route.ts'));

  // The canonical body is chosen by whether a map was sealed, and is redacted whenever
  // one was. See the companion test below for why it is conditional.
  assert.ok(
    chat.includes('const canonicalPrompt = sealedMap ? redactionResult.redactedText : prompt;'),
    'the chat route must store the redacted user turn whenever a map was sealed'
  );
  assert.ok(
    chat.includes('const canonicalResponse = sealedMap ? rawModelText : finalResponseText;'),
    'the model turn must be stored pre-rehydration whenever a map was sealed'
  );
  assert.ok(
    save.includes('const canonicalBody = sealedMap ? shielded.redactedText : text;'),
    'the save route must store the redacted body whenever a map was sealed'
  );
});

test('The client persists redacted text, never the plaintext it just displayed', () => {
  // This is the load-bearing one. If the browser writes plaintext into its own store,
  // destroying the server-side payload forgets nothing at all.
  const code = codeOnly(read('components/Dashboard.tsx'));

  assert.ok(
    code.includes('content: data.canonicalPrompt ?? trimmed'),
    'user turns must be persisted in the form the server chose, never the displayed text'
  );
  assert.ok(
    code.includes('content: data.canonicalResponse ?? data.geminiResponse'),
    'model turns must be persisted in the form the server chose'
  );
  assert.ok(
    !code.includes('content: trimmed,'),
    'the raw typed text must never be persisted directly'
  );
});

test('The plaintext placeholder map is never persisted', () => {
  const retention = codeOnly(read('lib/server/retention.ts'));

  // sealRehydrationMap is the only path from the ephemeral map to storage, and it seals.
  assert.ok(retention.includes('sealUnderDek(dek, serialized)'), 'the map is encrypted');
  assert.ok(
    !retention.includes('persistDocument(entryPath') &&
      !/persistDocument\([^)]*ephemeralMap/.test(retention),
    'the plaintext map must never reach a write'
  );

  const chat = codeOnly(read('app/api/journal/chat/route.ts'));
  assert.ok(
    chat.includes('rehydration: sealedMap'),
    'only the sealed form is written to the entry'
  );
  assert.ok(
    !chat.includes('ephemeralMap:') && !chat.includes('map: redactionResult.ephemeralMap'),
    'the ephemeral map must not be written to Firestore'
  );
});

test('A KMS failure stores no payload rather than falling back to plaintext', () => {
  const chat = codeOnly(read('app/api/journal/chat/route.ts'));
  const section = chat.slice(chat.indexOf('let sealedMap = null;'));

  assert.ok(section.includes('catch'), 'a seal failure must be caught');
  assert.ok(
    section.includes('sealedMap = null'),
    'and must leave the payload absent, never unencrypted'
  );
});

test("Without a sealed map the entry keeps the author's own words", () => {
  /**
   * The regression this pins, found by running the app the way its own README tells a
   * newcomer to: with GEMINI_API_KEY set and no GCP project, sealing fails, and storing
   * the redacted body would have destroyed the user's phone number on the first write
   * with nothing able to restore it. That is not managed forgetting, it is data loss.
   *
   * Redaction before EGRESS is untouched either way -- that is the security boundary.
   * This is only about what is kept at rest for the author to reread.
   */
  for (const [file, marker] of [
    ['app/api/journal/chat/route.ts', 'sealedMap ? redactionResult.redactedText : prompt'],
    ['app/api/journal/save/route.ts', 'sealedMap ? shielded.redactedText : text'],
  ] as const) {
    const code = codeOnly(read(file));
    assert.ok(code.includes(marker), `${file} must fall back to the author's own words`);
    assert.ok(
      code.includes("retentionWindow: sealedMap ? retentionPolicy.window : 'never'"),
      `${file} must not claim a retention window it cannot honour`
    );
    assert.ok(
      code.includes('managedForgetting'),
      `${file} must record whether managed forgetting is actually active`
    );
  }
});

test('Every model egress path crosses the Privacy Shield', () => {
  /**
   * Found during the submission audit: the recall route sent the user's query verbatim
   * to BOTH the embedding endpoint and Gemini, with no redaction. The chat route was
   * shielded, so the guarantee looked upheld while one whole path bypassed it.
   *
   * Any route that calls a model must run the shield first.
   */
  const recall = codeOnly(read('app/api/journal/recall/route.ts'));

  assert.ok(recall.includes('runPrivacyShield(query'), 'the recall query must be shielded');
  assert.ok(
    recall.includes('generateEmbedding(shieldedQuery.redactedText)'),
    'the embedding must be computed from the redacted query, not the raw one'
  );
  assert.ok(
    !/User Question: \$\{query\}|"\$\{query\}"/.test(recall),
    'the raw query must not be interpolated into the model prompt'
  );
});

test('Recall chunks are built from redacted text', () => {
  /**
   * Chunk text is persisted AND embedded upstream. Building it from the raw prompt would
   * both leak PII to the embedding endpoint and leave a plaintext copy outside the
   * retention window's reach -- which would make Managed Forgetting incomplete, because
   * a forgotten entry would remain searchable in full detail.
   */
  const chat = codeOnly(read('app/api/journal/chat/route.ts'));

  assert.ok(
    chat.includes('chunkJournalText(redactionResult.redactedText, entryId)'),
    'chunks must be built from the redacted body'
  );
  assert.ok(
    !chat.includes('chunkJournalText(prompt'),
    'chunks must never be built from the raw prompt'
  );
});

test('The client stores exactly what the server stored', () => {
  // Otherwise the two stores diverge and one of them holds something nobody intended.
  const code = codeOnly(read('components/Dashboard.tsx'));
  assert.ok(code.includes('data.canonicalPrompt ?? trimmed'));
  assert.ok(code.includes('data.canonicalResponse ?? data.geminiResponse'));
  assert.ok(code.includes('data.canonicalBody ?? text'));
  assert.ok(code.includes('data.canonicalQuery ?? trimmed'), 'including recall turns');
  assert.ok(code.includes('data.canonicalAnswer ?? data.answer'));
});

// ---------------------------------------------------------------------------
// Envelope encryption
// ---------------------------------------------------------------------------

test('Payloads round-trip under a data key and fail closed on tampering', () => {
  const dek = crypto.randomBytes(32);
  const map = JSON.stringify({ '[EMAIL_1]': 'budi@example.invalid' });

  const sealed = sealUnderDek(dek, map);
  assert.ok(!JSON.stringify(sealed).includes('budi'), 'plaintext must not survive sealing');
  assert.equal(openUnderDek(dek, sealed), map);

  // Wrong key: no plaintext.
  assert.throws(() => openUnderDek(crypto.randomBytes(32), sealed));
  // Tampered ciphertext: the GCM tag must reject it rather than yield garbage.
  assert.throws(() =>
    openUnderDek(dek, { ...sealed, ct: Buffer.from('tampered').toString('base64') })
  );
});

test('KMS access is scoped to the runtime service account and bound to the uid', () => {
  const kms = read('lib/server/kms.ts');

  // The uid is the additional authenticated data, so a wrapped DEK stolen from one
  // user's document cannot be unwrapped under another.
  assert.ok(
    kms.includes('additionalAuthenticatedData'),
    'wraps must be bound to the uid via AAD'
  );
  assert.ok(kms.includes("Buffer.from(uid, 'utf8')"), 'the AAD must be the uid');

  // Key access is obtained from the ambient runtime credential only; no key material
  // and no alternative principal appears in the module.
  assert.ok(kms.includes('getGoogleAccessToken'), 'KMS is called with the runtime identity');
  assert.ok(
    !/private_key|client_secret|BEGIN [A-Z ]*PRIVATE KEY/.test(kms),
    'no key material may be embedded'
  );

  // The documented IAM grant.
  const env = read('.env.example');
  assert.ok(
    env.includes('roles/cloudkms.cryptoKeyEncrypterDecrypter'),
    'the required role must be documented'
  );
});

test('An unconfigured KMS refuses rather than degrading to plaintext', () => {
  const kms = codeOnly(read('lib/server/kms.ts'));
  assert.ok(kms.includes("'KMS_NOT_CONFIGURED'"), 'a missing key is an explicit error');
  assert.ok(
    kms.includes('Refusing to store a rehydration payload without envelope encryption.'),
    'and is refused, not worked around'
  );
});

test('The wrapped data key is unreachable from any client', () => {
  const rules = read('firestore.rules');
  const start = rules.indexOf('match /userDataKeys/');
  assert.ok(start > -1, 'userDataKeys must have a rules block');
  assert.match(rules.slice(start, start + 200), /allow read, write: if false/);
});

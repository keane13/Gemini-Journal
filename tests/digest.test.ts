/**
 * @file tests/digest.test.ts
 * FEATURE 8 verification: payload minimization, idempotency, scope discipline, and the
 * guarantee that the digest is never triggered by mood or distress.
 *
 * The load-bearing tests here are the structural ones. A digest that "happens not to
 * include entry text today" is worth little; these assert that there is no channel
 * through which entry text could enter the email at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import {
  DigestCounters,
  buildDigestPayload,
  buildRawGmailMessage,
  describeMoodDirection,
  isoWeekOf,
  previousIsoWeek,
  renderDigestEmail,
} from '../lib/server/digest';

const ROOT = path.join(__dirname, '..');
const APP_URL = 'https://journal.example.com';

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/**
 * Strips comments and import statements so structural assertions test what the code
 * DOES, not what its documentation happens to mention. Without this, a comment saying
 * "this never reads sentiment" would itself fail a search for "sentiment".
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .filter((line) => !/^\s*import\s/.test(line))
    .join('\n');
}

// ---------------------------------------------------------------------------
// ISO week identity (the idempotency key)
// ---------------------------------------------------------------------------

test('isoWeekOf produces stable ISO-8601 week identifiers', () => {
  // 2026-01-01 is a Thursday, so it belongs to week 1 of 2026.
  assert.equal(isoWeekOf(new Date('2026-01-01T12:00:00Z')), '2026-W01');
  // Monday and Sunday of the same ISO week map to the same identifier.
  assert.equal(isoWeekOf(new Date('2026-09-07T00:00:00Z')), isoWeekOf(new Date('2026-09-13T23:59:59Z')));
});

test('isoWeekOf is stable across times of day (idempotency key cannot drift)', () => {
  const day = '2026-09-09';
  const morning = isoWeekOf(new Date(`${day}T00:00:01Z`));
  const evening = isoWeekOf(new Date(`${day}T23:59:59Z`));
  assert.equal(morning, evening, 'a single day must not straddle two idempotency keys');
});

test('previousIsoWeek steps back exactly one week', () => {
  const now = new Date('2026-09-09T12:00:00Z');
  assert.equal(isoWeekOf(now), '2026-W37');
  assert.equal(previousIsoWeek(now), '2026-W36');
});

// ---------------------------------------------------------------------------
// Payload minimization
// ---------------------------------------------------------------------------

const EXPECTED_PAYLOAD_KEYS = [
  'entriesWritten',
  'generatedAt',
  'isoWeek',
  'moodDirection',
  'openCommitmentCount',
  'overdueCommitmentCount',
  'previousIsoWeek',
  'recurringThemeCount',
];

test('Digest payload exposes counts and a direction word -- nothing else', () => {
  const counters: DigestCounters = {
    weeks: { [isoWeekOf(new Date())]: { entries: 4, moodSum: 1.2, moodCount: 4, themesCount: 3 } },
    openCommitmentDueAt: [Date.now() - 1000],
  };

  const payload = buildDigestPayload(counters);

  // If someone adds a content-bearing field (a title, a snippet, a theme name),
  // this assertion fails and the leak is caught at build time rather than in a mailbox.
  assert.deepEqual(
    Object.keys(payload).sort(),
    EXPECTED_PAYLOAD_KEYS,
    'the digest payload schema must remain counts-and-direction only'
  );

  for (const [key, value] of Object.entries(payload)) {
    if (key === 'moodDirection' || key === 'isoWeek' || key === 'previousIsoWeek' || key === 'generatedAt') {
      continue;
    }
    assert.equal(typeof value, 'number', `${key} must be a count, not free text`);
  }
});

test('Overdue commitments are counted from due timestamps alone', () => {
  const now = new Date('2026-09-09T12:00:00Z');
  const counters: DigestCounters = {
    weeks: { [isoWeekOf(now)]: { entries: 2, moodSum: 0, moodCount: 2, themesCount: 1 } },
    openCommitmentDueAt: [
      now.getTime() - 86400000, // overdue
      now.getTime() - 10, // overdue
      now.getTime() + 86400000, // not yet due
    ],
  };

  const payload = buildDigestPayload(counters, now);
  assert.equal(payload.overdueCommitmentCount, 2);
  assert.equal(payload.openCommitmentCount, 3);
});

test('An empty counter document yields a safe zeroed payload', () => {
  const payload = buildDigestPayload({}, new Date('2026-09-09T12:00:00Z'));
  assert.equal(payload.entriesWritten, 0);
  assert.equal(payload.overdueCommitmentCount, 0);
  assert.equal(payload.recurringThemeCount, 0);
  assert.equal(payload.moodDirection, 'not enough signal');
});

// ---------------------------------------------------------------------------
// Mood is qualitative, never numeric
// ---------------------------------------------------------------------------

test('Mood is reported as a direction word, never as a score', () => {
  const now = new Date('2026-09-09T12:00:00Z');
  const week = isoWeekOf(now);
  const prev = previousIsoWeek(now);

  const counters: DigestCounters = {
    weeks: {
      [prev]: { entries: 5, moodSum: -2.0, moodCount: 5, themesCount: 2 },
      [week]: { entries: 5, moodSum: 2.0, moodCount: 5, themesCount: 3 },
    },
  };

  const payload = buildDigestPayload(counters, now);
  assert.equal(payload.moodDirection, 'lighter');

  const email = renderDigestEmail(payload, APP_URL);
  // The averages here are -0.4 and +0.4; neither may appear in the email.
  assert.ok(!/-?0\.4/.test(email.text), 'no numeric mood score may appear in the email');
  assert.ok(!/moodScore/i.test(email.text));
  assert.ok(!/moodScore/i.test(email.html));
});

test('describeMoodDirection needs signal before it will claim a direction', () => {
  assert.equal(
    describeMoodDirection({ sum: 0.9, count: 1 }, { sum: 0, count: 10 }),
    'not enough signal',
    'a single entry must not be characterised as a trend'
  );
  assert.equal(describeMoodDirection({ sum: 0, count: 4 }, { sum: 0, count: 4 }), 'steadier');
  assert.equal(describeMoodDirection({ sum: -2, count: 4 }, { sum: 2, count: 4 }), 'heavier');
});

// ---------------------------------------------------------------------------
// The email itself
// ---------------------------------------------------------------------------

test('Rendered email carries counts, deep links, and the minimization statement', () => {
  const payload = buildDigestPayload(
    {
      weeks: { [isoWeekOf(new Date())]: { entries: 6, moodSum: 0.8, moodCount: 6, themesCount: 4 } },
      openCommitmentDueAt: [Date.now() - 5000, Date.now() - 6000],
    },
    new Date()
  );

  const email = renderDigestEmail(payload, APP_URL);

  assert.match(email.text, /You wrote 6 entries this week\./);
  assert.match(email.text, /4 recurring themes surfaced\./);
  assert.match(email.text, /2 commitments are past the time you named\./);

  // Deep links back into the app.
  assert.ok(email.text.includes(`${APP_URL}/`));
  assert.ok(email.text.includes('?view=commitments'));
  assert.ok(email.html.includes('?view=year'));

  // The promise is stated in the email itself, not only in the settings screen.
  assert.match(email.text, /counts only/);
  assert.match(email.text, /never includes your entry text/);
});

test('Singular and plural forms are handled (no "1 entries")', () => {
  const payload = buildDigestPayload(
    {
      weeks: { [isoWeekOf(new Date())]: { entries: 1, moodSum: 0.1, moodCount: 1, themesCount: 1 } },
      openCommitmentDueAt: [Date.now() - 100],
    },
    new Date()
  );
  const email = renderDigestEmail(payload, APP_URL);

  assert.match(email.text, /You wrote 1 entry this week\./);
  assert.match(email.text, /1 recurring theme surfaced\./);
  assert.match(email.text, /1 commitment is past the time you named\./);
});

test('The email is a pure function of counts: identical counts render identically', () => {
  const now = new Date('2026-09-09T12:00:00Z');
  const counters: DigestCounters = {
    weeks: { [isoWeekOf(now)]: { entries: 3, moodSum: 0.3, moodCount: 3, themesCount: 2 } },
    openCommitmentDueAt: [],
  };

  // Two different users with the same counts must receive byte-identical bodies --
  // there is no per-user content that could differentiate them.
  const a = renderDigestEmail(buildDigestPayload(counters, now), APP_URL);
  const b = renderDigestEmail(buildDigestPayload(counters, now), APP_URL);

  assert.equal(a.text, b.text);
  assert.equal(a.html, b.html);
  assert.equal(a.subject, b.subject);
});

test('Gmail message is addressed from the user to themselves', () => {
  const payload = buildDigestPayload({}, new Date());
  const email = renderDigestEmail(payload, APP_URL);
  const raw = buildRawGmailMessage('person@example.com', email);

  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  assert.match(decoded, /^From: person@example\.com$/m);
  assert.match(decoded, /^To: person@example\.com$/m);
  assert.ok(!/bcc/i.test(decoded), 'the digest must not carry hidden recipients');
});

// ---------------------------------------------------------------------------
// Structural guarantees about the send path
// ---------------------------------------------------------------------------

test('The digest send path never reads journal content', () => {
  const cron = codeOnly(read('app/api/cron/digest/route.ts'));

  assert.ok(
    !/users\/\$\{/.test(cron),
    'the scheduled digest must not construct any /users/** path'
  );
  for (const forbidden of ['/entries', '/messages', '/chunks', '/insights', '/commitments']) {
    assert.ok(
      !cron.includes(`${forbidden}`),
      `the digest job must not reference ${forbidden}`
    );
  }
  assert.ok(
    cron.includes('readCounters'),
    'the digest must be built from write-time counters'
  );
});

test('The digest is never triggered by mood or distress detection', () => {
  const cron = codeOnly(read('app/api/cron/digest/route.ts'));

  // Recipient selection must depend only on enrollment.
  assert.ok(
    cron.includes('enrollment.enabled !== true'),
    'recipients must be selected by explicit enrollment'
  );

  // No sentiment/distress signal may drive control flow in the selection path.
  for (const trigger of ['moodScore', 'sentiment', 'distress', 'crisis', 'riskScore']) {
    assert.ok(
      !new RegExp(trigger, 'i').test(cron),
      `the digest scheduler must not reference "${trigger}"`
    );
  }
});

test('The digest send is idempotent per (uid, isoWeek)', () => {
  const cron = codeOnly(read('app/api/cron/digest/route.ts'));

  assert.ok(
    /digestSends\/\$\{uid\}_\$\{isoWeek\}/.test(cron),
    'the idempotency claim must be keyed on both uid and isoWeek'
  );
  // The claim must be checked and written before the send, not after.
  const claimCheck = cron.indexOf('existingClaim');
  const send = cron.indexOf('await sendGmailMessage');
  assert.ok(claimCheck > -1, 'the send path must check for an existing claim');
  assert.ok(send > -1, 'the send path must call sendGmailMessage');
  assert.ok(claimCheck < send, 'the claim must precede the send');
});

test('Only the gmail.send scope is ever requested', () => {
  const gmail = read('lib/server/gmail.ts');

  assert.ok(gmail.includes('https://www.googleapis.com/auth/gmail.send'));
  for (const broader of ['gmail.readonly', 'gmail.modify', 'mail.google.com', 'gmail.compose']) {
    assert.ok(!gmail.includes(broader), `must never reference the broader scope ${broader}`);
  }
  assert.ok(
    gmail.includes('Refusing an over-broad Gmail grant'),
    'an over-broad grant must be rejected rather than silently accepted'
  );
});

test('Gmail refresh tokens are unreachable from any client', () => {
  const rules = read('firestore.rules');
  const block = rules.slice(rules.indexOf('match /gmailTokens/'));
  const scoped = block.slice(0, block.indexOf('\n    }') + 6);

  assert.match(scoped, /allow read, write: if false/, 'gmailTokens must deny all client access');
});

test('Digest is off by default: enrollment must be explicit', () => {
  const connect = read('app/api/digest/connect/route.ts');
  // Connecting Gmail must not, by itself, enable the digest.
  assert.ok(
    /enabled: false/.test(connect),
    'connecting Gmail must leave the digest disabled until the user opts in'
  );

  const settings = read('app/api/digest/settings/route.ts');
  assert.ok(
    settings.includes("enrollment?.enabled === true"),
    'a missing enrollment document must read as disabled'
  );
});

test('Settings preview and scheduled send share one renderer', () => {
  const settings = read('app/api/digest/settings/route.ts');
  const cron = read('app/api/cron/digest/route.ts');

  // If these ever diverge, the preview stops being a promise about what is sent.
  assert.ok(settings.includes('renderDigestEmail'), 'settings preview must use the renderer');
  assert.ok(cron.includes('renderDigestEmail'), 'the scheduled send must use the same renderer');
});

/**
 * @file tests/notifications.test.ts
 * EXTERNAL NOTIFICATIONS verification.
 *
 * External notifications are the highest-risk surface in this system: they push
 * journal-derived signal across the trust boundary to third parties that retain it.
 * These tests pin the four properties that make that acceptable:
 *
 *   1. Triggers cannot be conditioned on mood, sentiment, or distress.
 *   2. The default payload tier discloses no journal content, and escalation is gated.
 *   3. User-supplied webhook URLs cannot be turned into an SSRF primitive.
 *   4. Delivery credentials are encrypted and unreachable from any client.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import {
  DEFAULT_PAYLOAD_TIER,
  FORBIDDEN_TRIGGER_SIGNALS,
  MAX_EXCERPT_CHARS,
  NotificationDestination,
  TRIGGER_TYPES,
  TriggerEvent,
} from '../lib/server/notifications/types';
import {
  filterMatches,
  normalizeTriggerFilter,
  shouldNotify,
} from '../lib/server/notifications/triggers';
import { buildPayload, effectiveTier } from '../lib/server/notifications/payload';
import {
  ALLOWED_WEBHOOK_HOSTS,
  TargetValidationError,
  previewTarget,
  validateEmailTarget,
  validateWebhookUrl,
} from '../lib/server/notifications/targets';
import { formatDiscord, formatSlack } from '../lib/server/notifications/adapters';
import { __resetKeyCache, openSecret, sealSecret } from '../lib/server/notifications/crypto';

const ROOT = path.join(__dirname, '..');
const APP_URL = 'https://journal.example.com';

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** Strips comments and imports so structural checks test behaviour, not prose. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .filter((line) => !/^\s*import\s/.test(line))
    .join('\n');
}

function destination(overrides: Partial<NotificationDestination> = {}): NotificationDestination {
  return {
    id: 'dst_1',
    uid: 'user_1',
    channel: 'slack',
    label: 'test',
    enabled: true,
    triggers: [{ type: 'entry_created' }],
    payloadTier: 'signal',
    targetPreview: 'hooks.slack.com/…/abc…xyz',
    excerptConsentAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastDeliveryAt: null,
    lastDeliveryOutcome: null,
    consecutiveFailures: 0,
    ...overrides,
  };
}

const SECRET_TEXT = 'I felt anxious about the launch and called Dr. Lee at 555-123-4567.';

function event(overrides: Partial<TriggerEvent> = {}): TriggerEvent {
  return {
    uid: 'user_1',
    type: 'entry_created',
    entryId: 'entry_1',
    occurredAt: new Date().toISOString(),
    mode: 'reflection',
    tags: ['work', 'launch'],
    commitmentCount: 2,
    themeCount: 3,
    rawText: SECRET_TEXT,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Triggers cannot depend on mood or distress
// ---------------------------------------------------------------------------

test('The trigger evaluator references no mood, sentiment, or distress signal', () => {
  const code = codeOnly(read('lib/server/notifications/triggers.ts'));

  for (const signal of FORBIDDEN_TRIGGER_SIGNALS) {
    assert.ok(
      !new RegExp(signal, 'i').test(code),
      `the trigger evaluator must not reference "${signal}" - external notifications ` +
        'must never be conditioned on inferred emotional state'
    );
  }
});

test('The trigger type allowlist contains no state-inference trigger', () => {
  for (const type of TRIGGER_TYPES) {
    for (const signal of FORBIDDEN_TRIGGER_SIGNALS) {
      assert.ok(
        !new RegExp(signal, 'i').test(type),
        `trigger type "${type}" looks like a state inference ("${signal}")`
      );
    }
  }
});

test('The journal write path does not hand a mood score to the dispatcher', () => {
  const code = codeOnly(read('app/api/journal/chat/route.ts'));

  // Isolate the dispatchTriggerEvent(...) call and assert moodScore is absent from it.
  const start = code.indexOf('dispatchTriggerEvent(');
  assert.ok(start > -1, 'the chat route must dispatch trigger events');
  const call = code.slice(start, code.indexOf('appUrlFrom(req)', start));

  assert.ok(
    !/mood/i.test(call),
    'the trigger event must not carry a mood score - the evaluator cannot use what it never receives'
  );
});

test('Unknown trigger types are rejected, not silently ignored', () => {
  assert.throws(() => normalizeTriggerFilter({ type: 'mood_drop' }), /Unknown trigger type/);
  assert.throws(() => normalizeTriggerFilter({ type: 'distress_detected' }), /Unknown trigger type/);
  assert.throws(() => normalizeTriggerFilter({}), /Unknown trigger type/);
  assert.doesNotThrow(() => normalizeTriggerFilter({ type: 'entry_created' }));
});

test('Trigger filters validate their own required parameters', () => {
  assert.throws(() => normalizeTriggerFilter({ type: 'entry_mode' }), /at least one mode/);
  assert.throws(() => normalizeTriggerFilter({ type: 'entry_tagged', tags: [] }), /at least one tag/);
  assert.throws(
    () => normalizeTriggerFilter({ type: 'themes_threshold', threshold: 0 }),
    /threshold of at least 1/
  );

  const tagged = normalizeTriggerFilter({ type: 'entry_tagged', tags: ['  Work  ', 'Launch'] });
  assert.deepEqual(tagged.tags, ['work', 'launch'], 'tags are normalized for comparison');
});

// ---------------------------------------------------------------------------
// 2. Trigger matching
// ---------------------------------------------------------------------------

test('Tag and mode triggers match case-insensitively', () => {
  assert.equal(
    filterMatches({ type: 'entry_tagged', tags: ['work'] }, event({ tags: ['WORK'] })),
    true
  );
  assert.equal(
    filterMatches({ type: 'entry_mode', modes: ['reflection'] }, event({ mode: 'Reflection' })),
    true
  );
  assert.equal(
    filterMatches({ type: 'entry_tagged', tags: ['personal'] }, event({ tags: ['work'] })),
    false
  );
});

test('Threshold triggers respect their bound', () => {
  assert.equal(
    filterMatches({ type: 'themes_threshold', threshold: 3 }, event({ themeCount: 3 })),
    true
  );
  assert.equal(
    filterMatches({ type: 'themes_threshold', threshold: 4 }, event({ themeCount: 3 })),
    false
  );
});

test('Entry refinements fire on the entry_created event the journal route emits', () => {
  // Regression guard: the journal write path dispatches `entry_created`, so a
  // commitment or theme filter that only matched its own event name would never fire
  // in production while looking correct in isolation.
  const written = event({ type: 'entry_created', commitmentCount: 2, themeCount: 3 });

  for (const filter of [
    { type: 'entry_created' as const },
    { type: 'entry_mode' as const, modes: ['reflection'] },
    { type: 'entry_tagged' as const, tags: ['work'] },
    { type: 'commitment_created' as const },
    { type: 'themes_threshold' as const, threshold: 3 },
  ]) {
    assert.equal(
      filterMatches(filter, written),
      true,
      `${filter.type} must be satisfiable by an entry_created event`
    );
  }

  // ...but a genuinely different event must not be satisfied by an entry filter.
  assert.equal(
    filterMatches({ type: 'entry_created' }, event({ type: 'commitment_overdue' })),
    false,
    'an overdue-commitment event must not fire an entry_created destination'
  );
});

test('An empty trigger list never fires', () => {
  assert.equal(shouldNotify([], event()), false);
});

// ---------------------------------------------------------------------------
// 3. Payload tiers
// ---------------------------------------------------------------------------

test('The default payload tier discloses no journal content', () => {
  assert.equal(DEFAULT_PAYLOAD_TIER, 'signal');

  const payload = buildPayload(destination({ payloadTier: 'signal' }), event(), APP_URL);
  const serialized = JSON.stringify(payload);

  assert.ok(!serialized.includes('555-123-4567'), 'no PII may appear at the signal tier');
  assert.ok(!serialized.includes('anxious'), 'no entry text may appear at the signal tier');
  assert.ok(!serialized.includes('Dr. Lee'), 'no names may appear at the signal tier');
  // Even the tags and mode are withheld: "entry_tagged: therapy" is itself disclosure.
  assert.ok(!serialized.includes('launch'), 'tags are withheld at the signal tier');
  assert.ok(!serialized.includes('reflection'), 'the mode is withheld at the signal tier');
  assert.deepEqual(payload.redactedCategories, []);
});

test('The metadata tier discloses structure but no free text', () => {
  const payload = buildPayload(destination({ payloadTier: 'metadata' }), event(), APP_URL);
  const serialized = JSON.stringify(payload);

  assert.ok(serialized.includes('reflection'), 'the mode is disclosed at the metadata tier');
  assert.ok(serialized.includes('work'), 'user-chosen tags are disclosed at the metadata tier');

  assert.ok(!serialized.includes('555-123-4567'), 'no PII at the metadata tier');
  assert.ok(!serialized.includes('anxious'), 'no entry text at the metadata tier');
  assert.ok(!serialized.includes('Dr. Lee'), 'no names at the metadata tier');
});

test('The excerpt tier is downgraded to metadata without recorded consent', () => {
  const withoutConsent = destination({ payloadTier: 'excerpt', excerptConsentAt: null });
  assert.equal(effectiveTier(withoutConsent), 'metadata');

  const payload = buildPayload(withoutConsent, event(), APP_URL);
  assert.equal(payload.tier, 'metadata');
  assert.ok(
    !JSON.stringify(payload).includes('anxious'),
    'a record claiming the excerpt tier without consent must still not leak text'
  );
});

test('The excerpt tier redacts PII before disclosing text', () => {
  const consented = destination({
    payloadTier: 'excerpt',
    excerptConsentAt: new Date().toISOString(),
  });

  const payload = buildPayload(consented, event(), APP_URL);
  const serialized = JSON.stringify(payload);

  assert.equal(payload.tier, 'excerpt');
  assert.ok(serialized.includes('anxious'), 'consented excerpt discloses the entry text');
  assert.ok(!serialized.includes('555-123-4567'), 'the phone number must still be masked');
  assert.match(serialized, /\[PHONE_1\]/);
  assert.ok(
    payload.redactedCategories.includes('phone'),
    'masked categories ride along for the Egress Ledger'
  );
});

test('Excerpts are truncated to the documented bound', () => {
  const consented = destination({
    payloadTier: 'excerpt',
    excerptConsentAt: new Date().toISOString(),
  });
  const long = 'word '.repeat(500);

  const payload = buildPayload(consented, event({ rawText: long }), APP_URL);
  const excerpt = payload.lines[payload.lines.length - 1];

  assert.ok(
    excerpt.length <= MAX_EXCERPT_CHARS + 1,
    `excerpt length ${excerpt.length} must not exceed ${MAX_EXCERPT_CHARS}`
  );
});

test('Only the payload builder reads raw entry text', () => {
  // If any other module in the notification pipeline touched rawText, the tier decision
  // would no longer be the single chokepoint for disclosure.
  for (const file of ['triggers.ts', 'adapters.ts', 'dispatch.ts', 'store.ts', 'targets.ts']) {
    const code = codeOnly(read(`lib/server/notifications/${file}`));
    assert.ok(
      !code.includes('rawText'),
      `${file} must not read rawText - only payload.ts may, after tier enforcement`
    );
  }
  assert.ok(read('lib/server/notifications/payload.ts').includes('rawText'));
});

// ---------------------------------------------------------------------------
// 4. SSRF resistance on user-supplied webhook URLs
// ---------------------------------------------------------------------------

test('Webhook URLs pointing at cloud metadata or internal hosts are rejected', () => {
  const attacks = [
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    'https://metadata.google.internal/computeMetadata/v1/',
    'https://169.254.169.254/latest/meta-data/',
    'https://127.0.0.1/services/x',
    'https://localhost/services/x',
    'https://[::1]/services/x',
    'https://10.0.0.5/services/x',
    'https://evil.example.com/services/x',
  ];

  for (const url of attacks) {
    assert.throws(
      () => validateWebhookUrl('slack', url),
      TargetValidationError,
      `${url} must be rejected`
    );
  }
});

test('Credential-embedding and scheme downgrade tricks are rejected', () => {
  // "https://hooks.slack.com@evil.tld/..." parses with hostname evil.tld and username
  // "hooks.slack.com". The credential check fires first; either rejection is correct,
  // so assert only that it is refused.
  assert.throws(
    () => validateWebhookUrl('slack', 'https://hooks.slack.com@evil.tld/services/x'),
    TargetValidationError
  );
  assert.throws(
    () => validateWebhookUrl('slack', 'https://user:pass@hooks.slack.com/services/x'),
    /must not contain credentials/
  );
  assert.throws(
    () => validateWebhookUrl('slack', 'http://hooks.slack.com/services/x'),
    /must use https/
  );
});

test('Legitimate Slack and Discord webhooks are accepted', () => {
  assert.doesNotThrow(() =>
    validateWebhookUrl('slack', 'https://hooks.slack.com/services/T000/B000/XXXX')
  );
  assert.doesNotThrow(() =>
    validateWebhookUrl('discord', 'https://discord.com/api/webhooks/123/abcdef')
  );
  assert.doesNotThrow(() =>
    validateWebhookUrl('discord', 'https://discordapp.com/api/webhooks/123/abcdef')
  );
});

test('A webhook host valid for one channel is not valid for another', () => {
  assert.throws(
    () => validateWebhookUrl('discord', 'https://hooks.slack.com/services/T000/B000/XXXX'),
    /not a permitted discord webhook host/
  );
  assert.ok(ALLOWED_WEBHOOK_HOSTS.slack.length > 0);
});

test('Path shape is enforced, not just the host', () => {
  assert.throws(
    () => validateWebhookUrl('slack', 'https://hooks.slack.com/not-a-webhook'),
    /must begin with \/services\//
  );
  assert.throws(
    () => validateWebhookUrl('discord', 'https://discord.com/login'),
    /must begin with \/api\/webhooks\//
  );
});

test('Adapters refuse to follow redirects', () => {
  const code = read('lib/server/notifications/adapters.ts');
  assert.ok(
    code.includes("redirect: 'manual'"),
    'following a redirect from an allowlisted host would bypass the SSRF allowlist'
  );
});

// ---------------------------------------------------------------------------
// 5. Email channel is restricted to the user's own address, via Gmail
// ---------------------------------------------------------------------------

test('Email notifications may only target the user\'s own verified address', () => {
  assert.equal(validateEmailTarget(undefined, 'me@example.com'), 'me@example.com');
  assert.equal(validateEmailTarget('ME@Example.com', 'me@example.com'), 'me@example.com');

  assert.throws(
    () => validateEmailTarget('attacker@evil.tld', 'me@example.com'),
    /only be sent to your own verified address/
  );
  assert.throws(() => validateEmailTarget('me@example.com', null), /No verified email address/);
});

test('The email channel delivers through the user\'s own Gmail, not a mail vendor', () => {
  const code = read('lib/server/notifications/adapters.ts');
  assert.ok(code.includes('sendGmailMessage'), 'email must go through the Gmail send path');
  assert.ok(code.includes('buildRawGmailMessage'));

  for (const vendor of ['sendgrid', 'mailgun', 'postmark', 'ses.amazonaws', 'smtp']) {
    assert.ok(
      !new RegExp(vendor, 'i').test(code),
      `no third-party mail vendor may be introduced (found "${vendor}")`
    );
  }
});

// ---------------------------------------------------------------------------
// 6. Credential handling
// ---------------------------------------------------------------------------

test('Delivery credentials round-trip through authenticated encryption', async () => {
  const previous = process.env.NOTIFICATION_ENCRYPTION_KEY;
  process.env.NOTIFICATION_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  __resetKeyCache();

  try {
    const url = 'https://hooks.slack.com/services/T000/B000/SECRET';
    const sealed = await sealSecret(url);

    assert.ok(!JSON.stringify(sealed).includes('SECRET'), 'the plaintext must not survive sealing');
    assert.equal(await openSecret(sealed), url);

    // A tampered ciphertext must fail the auth tag rather than decrypt to something else.
    const tampered = { ...sealed, ct: Buffer.from('tampered').toString('base64') };
    await assert.rejects(() => openSecret(tampered));
  } finally {
    if (previous === undefined) delete process.env.NOTIFICATION_ENCRYPTION_KEY;
    else process.env.NOTIFICATION_ENCRYPTION_KEY = previous;
    __resetKeyCache();
  }
});

test('Encryption refuses to run with a wrong-sized key', async () => {
  const previous = process.env.NOTIFICATION_ENCRYPTION_KEY;
  process.env.NOTIFICATION_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString('base64');
  __resetKeyCache();

  try {
    await assert.rejects(() => sealSecret('x'), /exactly 32 bytes/);
  } finally {
    if (previous === undefined) delete process.env.NOTIFICATION_ENCRYPTION_KEY;
    else process.env.NOTIFICATION_ENCRYPTION_KEY = previous;
    __resetKeyCache();
  }
});

test('The stored target preview is not a usable credential', () => {
  const url = 'https://hooks.slack.com/services/T00000/B00000/abcdefghijklmnop';
  const preview = previewTarget('slack', url);

  assert.ok(!preview.includes('abcdefghijklmnop'), 'the preview must not contain the full token');
  assert.ok(preview.includes('hooks.slack.com'), 'the preview identifies the destination');

  const email = previewTarget('email', 'someone@example.com');
  assert.ok(email.includes('@example.com'));
  assert.ok(!email.includes('someone'));
});

test('Notification collections are unreachable from any client', () => {
  const rules = read('firestore.rules');

  for (const collection of [
    'notificationDestinations',
    'notificationSecrets',
    'notificationEgress',
    'notificationAudit',
  ]) {
    const start = rules.indexOf(`match /${collection}/`);
    assert.ok(start > -1, `${collection} must have a rules block`);

    const block = rules.slice(start, start + 200);
    assert.match(
      block,
      /allow read, write: if false/,
      `${collection} must deny all client access`
    );
  }
});

// ---------------------------------------------------------------------------
// 7. Wire formats
// ---------------------------------------------------------------------------

test('Discord payloads suppress mentions so an excerpt cannot ping a server', () => {
  const payload = buildPayload(
    destination({ payloadTier: 'excerpt', excerptConsentAt: new Date().toISOString() }),
    event({ rawText: 'Reminder for @everyone about the launch.' }),
    APP_URL
  );

  const body = formatDiscord(payload) as any;
  assert.deepEqual(
    body.allowed_mentions,
    { parse: [] },
    'an excerpt containing @everyone must not notify an entire Discord server'
  );
});

test('Wire formats state whether journal text is included', () => {
  const signal = formatSlack(buildPayload(destination(), event(), APP_URL));
  assert.ok(
    JSON.stringify(signal).includes('Contains no journal text'),
    'the recipient is told what level of disclosure this message carries'
  );

  const excerpt = formatSlack(
    buildPayload(
      destination({ payloadTier: 'excerpt', excerptConsentAt: new Date().toISOString() }),
      event(),
      APP_URL
    )
  );
  assert.ok(JSON.stringify(excerpt).includes('redacted excerpt'));
});

test('Every payload carries a deep link back into the app', () => {
  for (const tier of ['signal', 'metadata'] as const) {
    const payload = buildPayload(destination({ payloadTier: tier }), event(), APP_URL);
    assert.ok(payload.deepLink.startsWith(APP_URL), 'deep links point at the configured app URL');
    assert.ok(payload.deepLink.includes('entry_1'));
  }
});

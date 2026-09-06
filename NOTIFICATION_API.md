# Notification API Directive

**Version:** 1.0.0
**Scope:** External notifications to Slack, Discord, and Email
**Status:** Normative. Code that violates a MUST in this document is a defect.

---

## 0. Why this document is normative

External notifications are the only feature in this system that pushes journal-derived
signal **across the trust boundary to a party that retains it**. Slack and Discord store
what they receive, on infrastructure the user does not control, under retention policies
the user did not choose, visible to whoever can read that channel.

Everything else in this product is built so that leaking journal content is *structurally*
impossible — the weekly digest can't leak entry text because it never loads any; the admin
console can't read entries because Firestore refuses it. This feature cannot be built that
way: its entire purpose is to send something outward. So the discipline moves from
"impossible" to "minimal, gated, audited, and visible", and this directive is where those
rules are written down.

Terminology follows RFC 2119: **MUST**, **MUST NOT**, **SHOULD**, **MAY**.

---

## 1. Trigger directive

### 1.1 Triggers are a closed allowlist

Implementations **MUST** accept only the trigger types enumerated in
`lib/server/notifications/types.ts#TRIGGER_TYPES`. An unrecognised trigger type **MUST**
be rejected at configuration time with `INVALID_TRIGGER`, never ignored or defaulted.

| Trigger | Fires when | Parameters |
|---|---|---|
| `entry_created` | Any entry is written | — |
| `entry_mode` | An entry is written in a listed interaction mode | `modes: string[]` (≥1) |
| `entry_tagged` | An entry carries a listed tag | `tags: string[]` (≥1) |
| `commitment_created` | The entry contained a self-stated commitment | — |
| `commitment_overdue` | An open commitment passed its stated time | — |
| `themes_threshold` | The entry surfaced ≥ `threshold` recurring themes | `threshold: number` (≥1) |

Filters within a destination are **ORed**. A destination with no filters **MUST NOT** fire.

### 1.2 Prohibited trigger signals

Implementations **MUST NOT** condition an external notification on mood, sentiment,
distress, crisis, risk, emotion, or self-harm inference. The prohibited identifiers are
enumerated in `FORBIDDEN_TRIGGER_SIGNALS`, and `tests/notifications.test.ts` asserts none
appears in the trigger evaluator's executable code.

The journal write path **MUST NOT** pass a mood score onto the `TriggerEvent` at all. The
guarantee is enforced by omission rather than by discipline: the evaluator cannot use a
signal it never receives.

**The reasoning, recorded so a future maintainer can weigh it rather than merely obey it:**

- Routing an inferred emotional state to a Slack workspace can disclose someone's mental
  health to colleagues who have no business knowing it, from a system they cannot see.
- Distress inference from free text is unreliable. A false positive here is not a harmless
  bug; it is an unwanted disclosure that cannot be retracted.
- A journal that visibly reacts to sadness teaches its author to write less honestly,
  which destroys the only thing the product is for.

If a crisis-support capability is ever wanted, it belongs **in-app and in front of the
person themselves** — not on an outbound webhook. That is a different feature with a
different design review, not a new entry in this table.

### 1.3 Dispatch is non-blocking

Dispatch **MUST** be fire-and-forget relative to the journal write. A failing or slow
webhook **MUST NOT** delay, degrade, or fail the user's entry. All dispatch errors are
caught and recorded.

---

## 2. Payload schema directive

### 2.1 Tiers

Three tiers, ordered by disclosure. `signal` is the default and **MUST** remain so.

| Tier | Discloses | Consent required |
|---|---|---|
| `signal` | That *something* happened, plus a deep link. Nothing else — not the trigger name, not the mode, not tags. | None (default) |
| `metadata` | Trigger headline, interaction mode, user-authored tag names, and counts. No free text. | Enabling the destination |
| `excerpt` | The above plus a Privacy-Shield-redacted, truncated excerpt of the entry. | Typed confirmation |

`signal` withholds even the trigger name deliberately: a message reading
*"entry_tagged: therapy"* is itself a disclosure, and a channel's other readers can see it.

### 2.2 Tier enforcement is centralised

`lib/server/notifications/payload.ts#buildPayload` is the **only** function permitted to
read `TriggerEvent.rawText`. Adapters receive a fully-resolved payload and **MUST NOT**
have access to the originating event, so an adapter cannot reach past the tier decision.
`tests/notifications.test.ts` asserts no other module in the pipeline references `rawText`.

### 2.3 Excerpt handling

At the `excerpt` tier, implementations **MUST**:

1. Run the text through the Privacy Shield in **strict** mode before any truncation.
2. Truncate to at most `MAX_EXCERPT_CHARS` (280), on a word boundary.
3. Attach the masked category names to the payload so the Egress Ledger can display them.

A destination whose `payloadTier` is `excerpt` but whose `excerptConsentAt` is null
**MUST** be downgraded to `metadata` at send time. This is belt-and-braces: the API
already refuses to set the tier without consent, but a record altered by any other path
still cannot leak text.

### 2.4 Excerpt consent

Setting `payloadTier: "excerpt"` **MUST** be accompanied, in the same request, by:

```json
{ "excerptConsent": "SEND MY JOURNAL TEXT" }
```

Absent or mismatched, the request **MUST** fail with `403 EXCERPT_CONSENT_REQUIRED`.
Lowering the tier **MUST** clear `excerptConsentAt`, so returning to `excerpt` later
requires confirming again. Consent is per-destination and never global.

### 2.5 Wire formats

Every outbound message **MUST** state its own disclosure level to the recipient
("Contains no journal text." / "Contains a redacted excerpt you enabled for this
destination."), so a reader of the channel knows what they are looking at.

Discord payloads **MUST** set `allowed_mentions: { parse: [] }`. Without it, an excerpt
containing `@everyone` would notify an entire server.

---

## 3. Credential directive

### 3.1 Storage

| Collection | Contents | Client access |
|---|---|---|
| `notificationDestinations/{uid}_{id}` | Configuration. No secret. | Denied |
| `notificationSecrets/{uid}_{id}` | AES-256-GCM sealed webhook URL / address | Denied |
| `notificationEgress/{uid}_{id}` | What was disclosed, to whom, when | Denied |
| `notificationAudit/{uid}_{ts}` | Configuration changes | Denied |

All four **MUST** deny every client read and write in `firestore.rules`. They are reached
only through `/api/notifications/*`, which scopes each operation to the uid on the verified
token. A `uid` in a request body **MUST NOT** be read.

### 3.2 Encryption

Webhook URLs are **bearer capabilities**: anyone holding the string can post to that
channel indefinitely. They **MUST** be sealed with AES-256-GCM under a key from
`NOTIFICATION_ENCRYPTION_KEY` or Secret Manager before storage.

This is not redundant with Firestore's at-rest encryption. It narrows
`TRUST_LEDGER.md` caveat C10: the server's `roles/datastore.user` credential bypasses
Firestore rules, so without application-layer encryption that one credential would be
sufficient to harvest every user's webhook URLs. With it, an attacker needs the datastore
role **and** the Secret Manager key.

If no key is configured, credential storage **MUST** fail with `ENCRYPTION_UNAVAILABLE`
rather than falling back to plaintext.

### 3.3 Never returned to the client

The decrypted target **MUST NOT** be returned by any API response. Destination records
carry a `targetPreview` (`hooks.slack.com/…/abc…xyz`) that identifies the destination
without being usable as a credential.

### 3.4 Deletion relinquishes the capability

Deleting a destination **MUST** overwrite the sealed secret with a tombstone, not merely
mark the configuration inactive.

---

## 4. Target validation directive (SSRF)

A user-supplied URL that the server then fetches is an SSRF primitive. On Cloud Run, an
unvalidated webhook pointing at
`http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token`
would hand an attacker the service credential this entire architecture depends on.

### 4.1 Host allowlist, not denylist

Implementations **MUST** validate webhook hosts against
`ALLOWED_WEBHOOK_HOSTS`, an exact-match allowlist:

| Channel | Permitted hosts |
|---|---|
| `slack` | `hooks.slack.com` |
| `discord` | `discord.com`, `discordapp.com`, `ptb.discord.com`, `canary.discord.com` |

A denylist of internal ranges **MUST NOT** be used instead. Denylists lose to DNS
rebinding, IPv6-mapped IPv4, decimal IP notation, redirects, and cloud metadata endpoints
introduced after the denylist was written. An allowlist of the few hosts that can possibly
be correct has none of those failure modes.

### 4.2 Additional URL requirements

- `https` only.
- No embedded credentials (`user:pass@`), which are a classic allowlist-bypass trick.
- Channel-appropriate path prefix (`/services/` for Slack, `/api/webhooks/` for Discord).
- Delivery **MUST** use `redirect: 'manual'`. Following a 302 from an allowlisted host
  would step around the allowlist entirely.

### 4.3 Email targets

The email channel **MUST** deliver through the user's **own Gmail account to their own
verified address**, reusing the Feature 8 path. An arbitrary recipient **MUST** be
rejected: permitting one would turn this into a general-purpose forwarder, and an attacker
with a brief session could point it at their own inbox and receive the victim's journal
signal indefinitely.

No third-party email vendor (SendGrid, Mailgun, Postmark, SES, raw SMTP) may be
introduced; `tests/notifications.test.ts` asserts none appears in the adapters.

---

## 5. API reference

All endpoints require `Authorization: Bearer <Firebase ID token>`.

### `GET /api/notifications/destinations`

```jsonc
{
  "destinations": [ /* NotificationDestination[], no secrets */ ],
  "capabilities": {
    "channels": ["slack", "discord", "email"],
    "triggerTypes": ["entry_created", "..."],
    "payloadTiers": ["signal", "metadata", "excerpt"],
    "defaultPayloadTier": "signal",
    "maxDestinations": 10,
    "excerptConsentPhrase": "SEND MY JOURNAL TEXT"
  },
  "guarantees": {
    "neverTriggeredByMoodOrDistress": true,
    "defaultTierDisclosesNoJournalContent": true,
    "emailChannelSendsViaUsersOwnGmail": true,
    "webhookHostsAllowlisted": true
  }
}
```

### `POST /api/notifications/destinations`

```jsonc
{
  "channel": "slack",
  "label": "my #journal channel",
  "webhookUrl": "https://hooks.slack.com/services/T000/B000/XXXX", // slack | discord
  "address": "me@example.com",                                     // email only
  "triggers": [
    { "type": "entry_tagged", "tags": ["work"] },
    { "type": "themes_threshold", "threshold": 3 }
  ],
  "payloadTier": "metadata",
  "excerptConsent": "SEND MY JOURNAL TEXT"  // required iff payloadTier === "excerpt"
}
```

### `PATCH /api/notifications/destinations`

Body takes `id` plus any of `enabled`, `label`, `triggers`, `payloadTier`
(+ `excerptConsent`).

### `DELETE /api/notifications/destinations?id=<id>`

### `GET /api/notifications/test?id=<id>`

Returns the **exact** payload and wire format that would be delivered, built by the same
functions the live dispatcher uses, from synthetic sample data. Nothing is sent.

### `POST /api/notifications/test`

Delivers that sample payload, so a webhook can be verified end to end. The sample contains
no real journal content.

### Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `UNAUTHORIZED` | 401 | Missing or invalid ID token |
| `INVALID_REQUEST` | 400 | Malformed body |
| `INVALID_TARGET` | 400 | URL failed the allowlist or shape check |
| `INVALID_TRIGGER` | 400 | Unknown trigger type or missing parameter |
| `EXCERPT_CONSENT_REQUIRED` | 403 | Excerpt tier without the typed phrase |
| `NOT_FOUND` | 404 | No such destination for this uid |
| `LIMIT_REACHED` | 409 | More than `maxDestinations` |
| `NO_CREDENTIAL` | 409 | Destination has no stored credential |
| `ENCRYPTION_UNAVAILABLE` | 500 | No encryption key configured |
| `TEST_SEND_FAILED` | 502 | Upstream webhook rejected the delivery |

---

## 6. Rate limiting and failure handling

- At most `MAX_NOTIFICATIONS_PER_HOUR` (60) deliveries per user per hour, across all
  destinations. Exceeding it records a `suppressed` egress entry rather than sending.
- At most `MAX_DESTINATIONS_PER_USER` (10) destinations.
- Delivery timeout: 8s, with `AbortController`.
- A destination reaching **10 consecutive failures** is auto-disabled, so a deleted Slack
  channel does not generate failing requests forever.

---

## 7. Egress ledger

Every attempt — success, failure, or suppression — appends to `notificationEgress`:
destination, channel, redacted target preview, trigger, entry id, **tier**, masked
categories, outcome, timestamp.

The record deliberately stores **what level was disclosed**, never the payload itself.
Storing the message would recreate the journal content in a second location, defeating the
minimization the tier system exists to provide.

---

## 8. Conformance checklist

```bash
npm test   # tests/notifications.test.ts — 30 assertions
```

| Requirement | Test |
|---|---|
| §1.2 no mood/distress triggers | *"The trigger evaluator references no mood, sentiment, or distress signal"* |
| §1.2 no mood score reaches dispatch | *"The journal write path does not hand a mood score to the dispatcher"* |
| §1.1 unknown triggers rejected | *"Unknown trigger types are rejected, not silently ignored"* |
| §2.1 default discloses nothing | *"The default payload tier discloses no journal content"* |
| §2.3 downgrade without consent | *"The excerpt tier is downgraded to metadata without recorded consent"* |
| §2.3 excerpt redaction + bound | *"The excerpt tier redacts PII before disclosing text"*, *"Excerpts are truncated…"* |
| §2.2 single disclosure chokepoint | *"Only the payload builder reads raw entry text"* |
| §4.1 SSRF allowlist | *"Webhook URLs pointing at cloud metadata or internal hosts are rejected"* |
| §4.2 no redirects / no credentials | *"Adapters refuse to follow redirects"*, *"Credential-embedding … rejected"* |
| §4.3 own address, via Gmail | *"Email notifications may only target the user's own verified address"*, *"…not a mail vendor"* |
| §3.1 collections client-inaccessible | *"Notification collections are unreachable from any client"* |
| §3.2 authenticated encryption | *"Delivery credentials round-trip through authenticated encryption"* |
| §2.5 Discord mention suppression | *"Discord payloads suppress mentions…"* |

---

## 9. Known limitations

1. **The hourly rate limit is per-instance.** It uses process memory, like the existing
   request limiter, so the effective fleet-wide ceiling scales with instance count.

2. **`commitment_overdue` has no scheduled producer yet.** The trigger type, filter, and
   matching are implemented and tested, but nothing currently emits that event; it needs a
   scheduled sweep comparable to `/api/cron/digest`. Configuring it today is accepted and
   simply never fires. This is the one incomplete item in the feature.

3. **Delivery is not retried.** A transient 5xx is recorded as a failure and dropped.
   `DeliveryError.retryable` is populated for a future queue but nothing consumes it.

4. **Third-party retention is outside our control.** Once a message reaches Slack or
   Discord it is subject to that workspace's retention and access rules. This is inherent
   to the feature; the tier system limits what is exposed to it, and cannot do more.

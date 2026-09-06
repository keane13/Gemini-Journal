# Trust & Architecture Ledger

**Version:** 3.0.0
**Scope:** Personal Gemini Journal ("Nightstand")

Every row states a claim the product makes, the mechanism that enforces it, and a
**verification method** — something a reader can run or read to check the claim rather
than take it on trust. Where a claim is weaker than it looks, the Caveats section says so.

A claim is only as good as its enforcement point. Throughout this ledger:

- **Rules-enforced** means Cloud Firestore denies the operation. Application code cannot
  grant what the rules deny, so a bug in a route cannot widen access.
- **Structurally enforced** means the data required to violate the claim is never loaded
  into the process at all.
- **Code-enforced** means an application check. Weakest of the three: it holds only as
  long as the check is present, which is why these rows carry regression tests.

---

## 1. Blind administration (Feature 7)

| # | Claim | Mechanism | Enforcement | Verification method |
|---|---|---|---|---|
| A1 | An administrator cannot read, search, or export any journal entry. | `firestore.rules` gates `/users/{userId}/**` exclusively on `request.auth.uid == userId`. No rule on that subtree references `request.auth.token.role`. | Rules-enforced | **Live:** click **Prove it** in the console — it performs a real `GET` on another account's `/entries` with the admin's own ID token and displays the verbatim `PERMISSION_DENIED`, alongside a control probe against the admin's own entries that returns `200`. **Static:** `npm test` → *"no rule under /users consults the admin role"*, which parses the rules file and fails if `isAdmin()` or `token.role` ever appears inside the `/users` block. |
| A2 | No admin API route constructs a privileged read of user content. | Admin routes never build a `/users/**` path; the sole exception, `/api/admin/prove`, uses the admin's own ID token and never the service credential. | Code-enforced + test | `npm test` → *"no admin route builds a privileged read of /users"* scans every file under `app/api/admin/` and asserts the exception holds only for `prove`. |
| A3 | Operational metrics cannot re-identify an individual. | Small-cell suppression: any cell backed by fewer than **5 distinct users** is returned as `{ suppressed: true, value: null }`, including its population count. | Code-enforced + test | `npm test` → *"a single-user fleet leaks nothing through the dashboard"* builds a one-user fleet and asserts every metric, the redaction histogram, and the error table are all withheld. |
| A4 | Metrics never contain journal content or raw uids. | `lib/server/metrics.ts` accumulates counts and salted uid **hashes** in process memory; only the resulting *counts* are persisted. Latency is a bucket histogram. | Structurally enforced | Read `AggregateDocument` in `lib/server/metrics.ts`: every field is a number, a number array, or a map to number pairs. There is no string field to carry content. |
| A5 | A user cannot grant themselves the admin role. | Promotion requires either an existing `admin` claim on a **verified** token, or membership in the server-side `ADMIN_BOOTSTRAP_EMAILS` allowlist with a verified email. The role is read from the signed token, never from the request body. | Code-enforced + test | `npm test` → the three *"User cannot self-grant"* tests cover a non-allowlisted account, an unverified email, and an empty allowlist. |
| A6 | Role claims are trustworthy at all. | `verifyFirebaseIdToken` performs **mandatory** RS256 signature verification against Google's published certificates and rejects `alg: none`, a missing `kid`, and an unpublished `kid`. | Code-enforced + test | `npm test` → the three *"RBAC foundation"* tests forge tokens claiming `role: admin` and assert each is rejected. See Caveat C1 for why this row exists. |
| A7 | Every administrative action is audited, and an unaudited action cannot occur. | `withAdminAudit` appends an immutable **ATTEMPT** record *before* running the action and refuses the action outright if that append fails; an **OUTCOME** record follows. Records are written with the service credential, so an admin cannot forge or suppress entries about themselves. `firestore.rules` denies all client writes to `/adminAudit`. | Rules + code, fail-closed | `npm test` → *"Admin action is REFUSED when the audit append fails (fail closed)"* asserts the action never runs; *"A failing admin action still records an ERROR outcome"* asserts failures are recorded too. |
| A8 | A stolen long-lived token cannot suspend accounts. | Destructive actions call `requireFreshAuth`, which rejects any token whose `auth_time` is older than 5 minutes. | Code-enforced + test | `npm test` → *"Destructive action without fresh auth_time is rejected"*. |

---

## 2. Payload minimization for notifications (Feature 8)

| # | Claim | Mechanism | Enforcement | Verification method |
|---|---|---|---|---|
| B1 | The weekly digest never contains entry text, entry titles, or model output. | The digest is built **only** from write-time counters in `/digestCounters/{uid}`. The send path never reads entries, messages, chunks, insights, or commitments — that data is never loaded into the process. | Structurally enforced | **User-facing:** Settings → Weekly digest shows a live preview rendered by the *same function* the scheduler calls, from the user's real counters. **Static:** `npm test` → *"The digest send path never reads journal content"* asserts the scheduler references no `/users/**` path; *"Digest payload exposes counts and a direction word — nothing else"* pins the payload schema so adding a content field fails the build. |
| B2 | The settings preview is exactly what gets sent. | `renderDigestEmail` is the single renderer; `/api/digest/settings` and `/api/cron/digest` both call it. | Code-enforced + test | `npm test` → *"Settings preview and scheduled send share one renderer"*. |
| B3 | Mood is reported qualitatively, never as a score. | Counters store a `moodSum`/`moodCount` pair; `describeMoodDirection` collapses two weeks into one of five direction words. No number is emitted. | Structurally enforced | `npm test` → *"Mood is reported as a direction word, never as a score"* constructs averages of −0.4 and +0.4 and asserts neither appears in the rendered email. |
| B4 | Overdue commitments are reported by count only. | Counters hold **due timestamps** for open commitments — never commitment text. The digest counts how many are past due. | Structurally enforced | Read `DigestCounters` in `lib/server/digest.ts`: `openCommitmentDueAt` is `number[]`. `npm test` → *"Overdue commitments are counted from due timestamps alone"*. |
| B5 | No third-party email vendor ever receives journal-derived data. | The message is sent via the Gmail API **from the user's own account to the same address**. The application holds no copy after send. | Structurally enforced | `npm test` → *"Gmail message is addressed from the user to themselves"* decodes the RFC 2822 message and asserts `From` and `To` match and no `Bcc` exists. |
| B6 | Only the `gmail.send` scope is ever requested, incrementally. | The client requests `gmail.send` alone, separately from sign-in. `exchangeCodeForTokens` **rejects** a grant carrying broader scopes and revokes the token it just received. | Code-enforced + test | `npm test` → *"Only the gmail.send scope is ever requested"* asserts no broader scope string appears anywhere in `lib/server/gmail.ts` and that the over-broad-grant rejection exists. |
| B7 | The digest is off by default. | Absence of a `/digestEnrollment/{uid}` document reads as disabled. Connecting Gmail explicitly sets `enabled: false`; a separate opt-in is required. | Code-enforced + test | `npm test` → *"Digest is off by default: enrollment must be explicit"*. |
| B8 | Turning the digest off actually releases the Gmail grant. | Disabling revokes the refresh token upstream and nulls the stored value — the app loses the ability to send, not merely the intent. | Code-enforced | Read the `POST` handler in `app/api/digest/settings/route.ts`. |
| B9 | The digest is never triggered by mood or distress detection. | Recipients are selected solely by `enrollment.enabled === true` on a fixed schedule. | Structurally enforced + test | `npm test` → *"The digest is never triggered by mood or distress detection"* strips comments and asserts no sentiment, mood, distress, crisis, or risk identifier appears anywhere in the scheduler's executable code. |
| B10 | A retried schedule cannot mail anyone twice. | Idempotency claim at `/digestSends/{uid}_{isoWeek}` written **before** the send; a pre-existing claim short-circuits. | Code-enforced + test | `npm test` → *"The digest send is idempotent per (uid, isoWeek)"* asserts the claim check precedes the send call. |
| B11 | Gmail refresh tokens cannot be stolen from the browser. | `/gmailTokens/{uid}` denies **all** client access, including to the token's own owner. Tokens are read and written only with the service credential. | Rules-enforced | `npm test` → *"Gmail refresh tokens are unreachable from any client"*. An XSS on this app cannot exfiltrate a Gmail grant. |
| B12 | The scheduled endpoints cannot be triggered by anyone. | Cloud Scheduler OIDC identity tokens are verified against Google's JWKS, with issuer, audience, expiry, and service-account email all checked. Unconfigured means **refused**, not open. | Code-enforced | Read `lib/server/cron-auth.ts`. Note the shared-secret path requires an explicit `CRON_ALLOW_SHARED_SECRET=true` opt-in. |

---

## 3. Separate restricted keys (Feature 9 and general)

| # | Claim | Mechanism | Enforcement | Verification method |
|---|---|---|---|---|
| C1 | The Gemini API key is never in the client bundle. | All model calls are server-side; the key is resolved by `lib/server/secrets.ts#getGeminiApiKey`. | Structurally enforced | `grep -ri "AIza" .next/static/` returns nothing. No client module imports `@google/genai`. |
| C2 | The Maps key is a **separate** credential from the Gemini key. | `getMapsApiKey()` resolves `MAPS_SERVER_API_KEY` / `GCP_MAPS_SECRET_NAME` — a distinct secret with its own resolver and cache. | Code-enforced + test | `npm test` → *"The Maps key is a separate credential and never reaches the client"*. |
| C3 | No map key is shipped to the browser. | The client posts coordinates to `/api/location/resolve` and receives a place label. There is no client-side Maps call. | Structurally enforced + test | `npm test` → *"No client component references a Maps API key"* scans every file in `components/` and `hooks/` for the key name or a `maps.googleapis.com` call. **Deployment requirement:** the Maps key must be restricted to the Geocoding API and to the server's egress IPs. If a browser-side map is ever added, its key must be a *third*, referrer-locked key — see Caveat C4. |
| C4 | Location is stored coarsely by default. | `coarsen()` rounds to 2 decimal places (~1.1km) and the precise value is discarded server-side. Precise mode is a per-user setting, off by default. | Structurally enforced + test | `npm test` → *"Coordinates are coarsened to roughly 1km by default"* and *"Coarsening keeps the point within ~1.5km of the original"*. The coarse coordinates are also what is sent to the geocoder, so the exact position is never disclosed upstream either. |
| C5 | Location is masked before model egress unless explicitly permitted. | The place label is appended to the prompt and masked to `[LOCATION_n]` by the Privacy Shield unless `locationContextForReflections` is `true`. Masking applies **even when privacy mode is `off`**, because location sharing is a separate consent from PII heuristics. | Code-enforced + test | `npm test` → *"Location is masked as [LOCATION_n] before model egress"* and *"Location masking applies even when the privacy mode is off"*. |
| C6 | Masked location is visible in the Egress Ledger like any other entity. | Location produces a normal `MaskedSpan` with category `LOCATION` and is counted in `categoryCounts`. | Structurally enforced + test | `npm test` → *"Location masking appears in the Egress Ledger like any other entity"*. |
| C7 | Location settings fail closed. | `normalizeLocationSettings` enables a setting only on an exact boolean `true`; `"true"`, `1`, and `{}` all read as off. | Code-enforced + test | `npm test` → *"Location settings fail closed on truthy-but-not-true values"*. |
| C8 | Place labels never contain a street address. | `selectPlaceLabel` reads only neighbourhood/sublocality/locality/administrative components and ignores `street_number`, `route`, and `premise`. | Code-enforced + test | `npm test` → *"Place labels prefer neighbourhood-or-broader, never a street address"*. |

---

## 3b. Managed forgetting (Feature 11)

| # | Claim | Mechanism | Enforcement | Verification method |
|---|---|---|---|---|
| D1 | Past the retention window, the personal details in an entry are permanently gone. | The canonical stored body is the **redacted** text on every write path. The placeholder map lives in a separate encrypted payload which the scheduled job overwrites with `null`. Because the plaintext was never the canonical form, forgetting is not a deletion that has to chase copies. | Structurally enforced | `npm test` → *"The canonical stored body is the redacted text, on every write path"* and *"The plaintext placeholder map is never persisted"*. |
| D2 | No code path can rehydrate a forgotten entry — including an administrator's. | `rehydrate()` is the only function that substitutes plaintext back, and with no map it is the identity function. No admin route imports `openRehydrationMap` or `unwrapDek`. The rehydrate route reads the entry with the **caller's own ID token** and never a service credential. | Structurally enforced + test | `npm test` → *"Rehydration of a forgotten entry returns the redacted text unchanged"*, *"No admin route can reach a rehydration payload"*, *"Only the rehydrate route opens a payload, and only as the signed-in user"*. |
| D3 | The browser never stores plaintext that would outlive the window. | The client persists `redactionDetails.redactedPayload` and `redactedResponse`, not the text it just displayed. Rehydrated text exists only in component state while an entry is on screen. | Code-enforced + test | `npm test` → *"The client persists redacted text, never the plaintext it just displayed"*. See Caveat C11 for why this row exists. |
| D4 | The forgetting job destroys payloads and nothing else. | It writes exactly `rehydration: null` plus tombstone dates. It never touches bodies, titles, mood, commitments, or recall chunks, and skips entries that have no payload so a re-run is a no-op. | Code-enforced + test | `npm test` → *"The forgetting job writes only the payload and its tombstone"* asserts the absence of `content:`, `title:`, `/commitments`, and `/chunks` in the job. |
| D5 | Shortening the window destroys data immediately, and says so first. | Shortening requires the typed phrase `FORGET THE DETAILS NOW`; the same request then destroys every payload outside the new window and reports how many. Lengthening needs no confirmation, because nothing is lost. | Code-enforced + test | `npm test` → *"Shortening requires a typed confirmation and destroys in the same request"*, *"Lengthening the window needs no confirmation"*. |
| D6 | Forgetting never degrades search or insight quality. | Recall chunks are built from the **redacted** body, so the retrieval corpus is identical before and after forgetting. Nothing is recomputed and nothing is lost from the index. | Structurally enforced + test | `npm test` → *"Recall chunks are built from redacted text"*. **This row was false when first written** — chunks were built from the raw prompt, which both leaked PII to the embedding endpoint and would have left forgotten entries fully searchable. Corrected during the submission audit; see Caveat C13. |
| D7 | A Firestore dump is not sufficient to read anyone's details. | Envelope encryption: a per-user DEK is wrapped by a Cloud KMS key and stored wrapped; payloads are AES-256-GCM under the DEK. The wrap is bound to the uid as **additional authenticated data**, so a DEK stolen from one user's document cannot be unwrapped under another. `/userDataKeys` denies all client access. | Rules + KMS | `npm test` → *"KMS access is scoped to the runtime service account and bound to the uid"*, *"Payloads round-trip under a data key and fail closed on tampering"*, *"The wrapped data key is unreachable from any client"*. |
| D8 | A KMS outage never degrades to storing plaintext. | A seal failure leaves the payload `null`: the entry is written with the details simply unrecoverable. There is no plaintext fallback anywhere. | Code-enforced + test | `npm test` → *"A KMS failure stores no payload rather than falling back to plaintext"*, *"An unconfigured KMS refuses rather than degrading to plaintext"*. |
| D9 | "Off" is not offered, and a corrupt policy fails safe. | The floor is 30 days. `normalizeRetentionPolicy` falls back to the 90-day default on anything unrecognised — never to `never`, which would silently upgrade someone to indefinite retention. | Code-enforced + test | `npm test` → *"The default window is 90 days and 'off' is not offered"*, *"A corrupt policy document falls back to the default, never to 'never'"*. |

---

## 4. Caveats and known gaps

Stating these is part of the ledger's job. A trust document that lists only strengths is
marketing.

**C1 — A critical authentication bypass was found and fixed during this work.**
`verifyFirebaseIdToken` previously wrapped its signature check in `if (header.kid)` and
`if (cert)`. A token whose header carried no `kid`, or an unrecognised one, skipped
verification entirely and was returned as a **trusted identity**. Any unauthenticated
party could have forged a token for an arbitrary `sub` and read or written that user's
journal. Verification is now mandatory and fail-closed, `alg` is pinned to RS256, and
`iat` is validated. The three *"RBAC foundation"* tests exist to keep it that way. Role
claims would have been meaningless without this fix, which is why it was made before
Feature 7 was built.

**C2 — `firestore.rules.test.ts` does not run.** It imports `vitest` and
`@firebase/rules-unit-testing`, neither of which is in `package.json`. It currently
contributes no verification, and `npx tsc --noEmit` reports three errors in it. The
rules assertions in this ledger marked "Rules-enforced" are verified today by *static
parsing of the rules file*, not by emulator execution. Restoring emulator tests is the
single highest-value next step for this ledger's credibility.

**C3 — `THREAT_MODEL.md` describes rules that do not exist.** It credits
`affectedKeys().hasOnly()`, `isValidEntry()`, `isValidMessage()`, and `request.time`
timestamp enforcement to `firestore.rules`; none are present. Consequently
`security_spec.md` payloads **PAYLOAD-04** (timestamp forgery), **PAYLOAD-05** (ghost
field injection), **PAYLOAD-10** (tag array explosion), and **PAYLOAD-11** (immutable key
change) are **not** currently denied. This predates the current work and is unaddressed
by it.

**C4 — Small-cell suppression under-counts distinct users across days.** Distinct-user
figures take the per-day maximum rather than a true union, because unioning would require
storing per-user identifiers in the aggregate. This under-counts, which suppresses *more*
than strictly necessary — it fails safe, but the population figures are lower bounds.

**C5 — Latency percentiles are bucket bounds, not exact values.** Percentiles are read
off an additive histogram, so p50/p95 are reported as the containing bucket's upper
bound. A percentile landing in the open-ended top bucket is flagged as a lower bound
(`p95IsLowerBound`) and rendered as `12800ms+`.

**C6 — Revoking sessions does not invalidate outstanding ID tokens.** Advancing
`validSince` revokes refresh tokens; already-issued ID tokens remain valid until they
expire (up to one hour). This is Firebase's model, and the console says so in its
response text.

**C7 — Digest counters are eventually consistent.** They are updated fire-and-forget so a
telemetry failure never breaks a journal write. A dropped update means a slightly low
count in one digest, never a leak.

**C8 — Metric aggregation is approximate under horizontal scale.** Telemetry accumulates
per serverless instance and merges additively at flush. Counts and latency histograms
merge correctly; distinct-user counts do not (see C4).

**C9 — Location precision below ~1km is only as private as the geocoder.** When a user
enables precise mode they are opting into sending exact coordinates to Google's Geocoding
API. The setting is off by default and the UI states the tradeoff, but the tradeoff is
real.

**C13 — Three claims in this document were false when written, and were corrected by
auditing rather than by reasoning.** Recording them because the pattern matters more than
the individual bugs: each was a claim asserted from the design intent without checking the
implementation, and each survived typecheck, lint, and a green test suite.

1. *Recall operates on redacted text* (D6) — chunks were built from the raw prompt, so
   PII reached the embedding endpoint and a forgotten entry would have stayed searchable
   in full detail.
2. *Every model egress crosses the Privacy Shield* (THREAT-04) — the **recall route ran no
   redaction at all**, sending the user's query verbatim to both the embedding model and
   Gemini. The chat route was shielded, so the guarantee looked upheld while an entire
   path bypassed it.
3. *Managed forgetting is safe by default* — with Cloud KMS unconfigured (the state of any
   fresh clone following the README), sealing failed and the redacted body was stored with
   no map, permanently destroying the author's own words on the first write. Now the entry
   keeps what the user wrote and declares `managedForgetting: false`.

All three are now regression-tested. The lesson for a reader of this ledger: treat rows
whose verification method is *"read the code"* as weaker than rows that name a test.

**C11 — Managed forgetting required changing what the browser stores, and older entries
predate it.** The client-side `interactions` collection previously persisted the plaintext
the user had just typed, alongside the rehydrated model reply. Destroying the server-side
payload would have forgotten nothing while those copies remained, so the write path was
changed to persist redacted text on both turns. **Entries written before this change still
hold plaintext in `interactions` and are not reachable by the forgetting job.** A migration
that rewrites historical turns to their redacted form is needed and is not implemented
here; until it runs, the guarantee applies to entries created from this version onward.

**C12 — Two parallel stores exist for journal content.** The client reads
`users/{uid}/interactions` while the server writes `users/{uid}/entries/{id}/messages`.
This predates the current work. It matters for D1 because forgetting has to be correct in
both, and the rehydrate endpoint therefore accepts caller-supplied redacted texts so the
client store can be rehydrated for display without the placeholder map leaving the server.
Consolidating the two is the right fix and is not done.

**C10 — Blindness is enforced against admin *tokens*, not against whoever can deploy
code.** The Cloud Run service account holds `roles/datastore.user`, which bypasses
Firestore rules and *could* read `/users/**`. The digest counters, aggregates, audit
ledger, enrollment, and Gmail token collections all require it. So the honest statement
of the guarantee is:

> An administrator using the console — or anyone holding an admin ID token — is denied
> journal content by Firestore itself, and no amount of API misuse changes that. Someone
> who can **change and deploy the server code** is a different adversary, and this control
> does not stop them.

What narrows that gap: the application never uses the service credential to read
`/users/**` (regression-tested by *"no admin route builds a privileged read of /users"*);
the "Prove it" endpoint is specifically forbidden from falling back to it; and every
admin action is recorded in a ledger the admin cannot write to or delete. Closing it
properly would require splitting the service account so that the Firestore-writing
identity has access only to the server-only collections — worth doing, and not done here.

---

## 5. Run the checks yourself

Every claim above is verifiable from the outside. Two ways:

**Live, against the running system — [`/security/self-test`](/security/self-test).**
Nine adversarial checks that attack this application while it is running, using your own
session token, and report whatever the backend actually returns. Cross-tenant reads,
cross-tenant listing, uid spoofing, unauthenticated access, prompt injection, client-bundle
secret scanning, redaction coverage, administrator blindness, and the rate limiter. Each
check shows the directive it enforces, the elapsed time, and an expandable raw response.
Failures render exactly as prominently as passes.

| Claim in this ledger | Live check |
|---|---|
| A1 — admin denied user content | `ADMIN_BLINDNESS` (skipped unless you hold the admin claim) |
| C1/C2 — no keys in the client bundle | `CLIENT_BUNDLE_SECRETS` |
| Privacy Shield coverage (THREAT-04) | `REDACTION_COVERAGE` |
| Tenant isolation (THREAT-01, THREAT-08) | `CROSS_TENANT_READ`, `CROSS_TENANT_LIST`, `UID_SPOOFING` |
| Injection containment (THREAT-07) | `PROMPT_INJECTION` |
| Rate limiting (THREAT-06) | `RATE_LIMIT` |

Three properties keep that page honest, and each is regression-tested in
`tests/selftest.test.ts`: verdicts are **server-authored** (a modified browser cannot
report a clean run, because `selfTestRuns` denies all client writes); cross-tenant probes
are attributed to **your own ID token**, never the service credential, so Firestore rules
are what decides; and the target is a **configured synthetic tenant**, never a real
account — with no fixture configured the checks report *skipped* rather than passing.

Two honest caveats. `RATE_LIMIT` genuinely exhausts your per-minute quota, so journal
requests may be refused for up to a minute afterwards. And the self-test's model calls run
the full pipeline — auth, rate limiting, redaction, live Gemini call — but suppress the
Firestore write, so a security probe does not inject fixture card numbers and injection
payloads into your real journal.

**Offline, in the repository:**

## 6. How to verify the whole ledger

```bash
npm install
npm test          # 145 assertions: redaction, safety, commitments, RBAC, digest,
                  # location, notifications, and the self-test harness itself
npx tsc --noEmit  # type validity (3 pre-existing errors in firestore.rules.test.ts — see C2)
```

The admin console's **Prove it** button is the only check that requires a deployed
environment, because it deliberately exercises the real Firestore authorization path
rather than a simulation of it.

# Personal Gemini Journal ("Nightstand")
**A Production-Grade, Privacy-Shielded Introspective Journal powered by Gemini Flash and Google Cloud Firestore.**

---

## 90-Second Executive Summary for Judges & Auditors

If you have only 90 seconds to evaluate this architecture:

1. **Zero Browser Model Traffic:** The Gemini API key is completely inaccessible to the client. No client bundle imports `@google/genai`. All interactions pass through verified server-side Next.js route handlers (`/api/journal/*`).
2. **Deterministic Privacy Shield with Live Egress Ledger:** Sensitive personal data (credit cards with Luhn checksum verification, phone numbers, Indonesian NIK/NPWP, IBANs, and auth tokens) is detected and replaced with stable tokens (`[PHONE_1]`, `[CREDIT_CARD_1]`) **before** departure to Google Gemini. The rehydration mapping is kept only in ephemeral server memory for the duration of the request and is never persisted or logged. The client inspects the exact payload departure via the **Egress Ledger**.
3. **Cryptographic Firestore UID Isolation:** Every document path is structured under `/users/{uid}/**`. `firestore.rules` mathematically enforces that `request.auth.uid == userId`. Cross-tenant reading, writing, and listing are denied.
4. **Grounded Recall Without Hallucination:** "Ask your past self" converts past reflections into semantic vector chunks (`users/{uid}/chunks`). Semantic queries are structurally confined to the caller's verified UID. If similarity is below 0.55, the model explicitly acknowledges the absence of historical data rather than hallucinating.
5. **Data Sovereignty by Design:** Full JSON + Markdown archive export with one click. Cascading permanent deletion of all journal records upon typing `"DELETE MY JOURNAL"`.

---

## Architecture Diagram

```
[ Client Browser ("Nightstand" UI) ]
      │  (Firebase Auth ID Token in Authorization: Bearer <token>)
      ▼
[ Next.js Server Route: /api/journal/chat ]
      ├─ 1. Verify Cryptographic ID Token (Derives authentic UID, discards any body UID)
      ├─ 2. Rate Limiter (Token bucket per verified UID)
      ├─ 3. Two-Stage Privacy Shield (Deterministic Luhn CC, NIK, Phone + Entity Detection)
      ├─ 4. Ephemeral In-Memory Token Mapping (Never persisted)
      ▼
[ Google Gemini 3.6 Flash Engine ]
      ├─ Model system instructions fenced by <untrusted_journal_data> delimiters
      ├─ Streaming response with prompt-injection defense
      ▼
[ Server Rehydration & Persistence ]
      ├─ Reverse ephemeral token map -> restore original text in server memory
      ├─ Persist to Firestore: users/{uid}/entries/{entryId}/messages
      ├─ Store category histogram (e.g. { phone: 1 }) without storing token map
      └─ Chunk & embed for grounded recall -> users/{uid}/chunks
```

---

## Expansion Features (7-9)

### Feature 7 - Blind Admin Console (`/admin`)

An operational console that **cannot read user entries**, and proves it.

- **Roles:** `user` | `admin`, carried as a Firebase custom claim and read only from a
  cryptographically verified ID token.
- **Bootstrap:** add your address to `ADMIN_BOOTSTRAP_EMAILS`, then either visit `/admin`
  and use the one-time self-grant, or run the operator script:
  ```bash
  npx tsx scripts/grant-admin.ts --email you@example.com
  npx tsx scripts/grant-admin.ts --email you@example.com --check
  npx tsx scripts/grant-admin.ts --email you@example.com --revoke
  ```
  Requires `GOOGLE_APPLICATION_CREDENTIALS` locally. Sign out and back in for the claim
  to appear in your token.
- **Shows:** daily active users, entries created, model latency p50/p95, token spend,
  fleet-wide redaction category histogram, error rates by code, rate-limit hits - all
  precomputed aggregates with **small-cell suppression below 5 users**.
- **Can:** suspend an account, reinstate it, revoke sessions. Each requires a sign-in
  within the last 5 minutes and writes an immutable audit record *before* running; if the
  audit append fails, the action is refused.
- **Cannot:** read, export, or search any journal content. The console header says so, and
  the **Prove it** button live-executes a real Firestore read of another account's entries
  using the admin's own token, displaying the verbatim `PERMISSION_DENIED` next to a
  control probe that succeeds against the admin's own entries.

### Feature 8 - Weekly Digest via Gmail

Opt-in, **off by default**, found under the mail icon in the header.

- **Incremental OAuth** for `gmail.send` **only**, requested separately from sign-in. A
  grant carrying broader scopes is rejected and revoked.
- **Sent from the user's own account to themselves.** No third-party email vendor is
  involved at any point.
- **Contains:** entries written, mood direction as a word (never a score), recurring theme
  count, overdue commitments **by count only**, and deep links back into the app. No entry
  text, no titles, no model output - structurally, because the send path is built from
  write-time counters and never loads journal content.
- **Live preview** in settings, rendered by the same function the scheduler calls, so what
  you preview is what gets sent.
- **Never triggered by mood or distress detection.** Recipients are selected purely by
  enrollment on a fixed schedule.
- **Scheduling:** Cloud Scheduler with OIDC auth, idempotent per `(uid, isoWeek)`.

  ```bash
  gcloud scheduler jobs create http weekly-digest       --schedule="0 9 * * MON" --time-zone="Asia/Jakarta"       --uri="https://YOUR_SERVICE_URL/api/cron/digest" --http-method=POST       --oidc-service-account-email="scheduler@${PROJECT_ID}.iam.gserviceaccount.com"       --oidc-token-audience="https://YOUR_SERVICE_URL"

  gcloud scheduler jobs create http metrics-flush       --schedule="*/15 * * * *"       --uri="https://YOUR_SERVICE_URL/api/cron/aggregate" --http-method=POST       --oidc-service-account-email="scheduler@${PROJECT_ID}.iam.gserviceaccount.com"       --oidc-token-audience="https://YOUR_SERVICE_URL"
  ```

  Set `CRON_OIDC_AUDIENCE` and `CRON_SERVICE_ACCOUNT_EMAIL` to match. If either is unset,
  the endpoints refuse every request rather than defaulting open.

### Feature 9 - Location Context

- Optional per-entry location pin. Reverse geocoding runs **server-side** with a
  **separate, API-restricted Maps key** from Secret Manager - no map key is ever shipped
  to the browser.
- **Coarse by default (~1km).** The precise value is discarded server-side before the
  geocoder is even called, so the exact position is not disclosed upstream either. Precise
  coordinates are a per-user setting, off by default.
- Location is **redacted to `[LOCATION_n]` before Gemini egress** unless the user
  explicitly enables location context for reflections - and it surfaces in the **Egress
  Ledger** like any other masked entity. Masking applies even when privacy mode is `off`,
  because location sharing is a separate consent from PII heuristics.
- **Year View** gains a place filter, shown only when entries actually carry locations.

> Deployment requirement: restrict `MAPS_SERVER_API_KEY` to the Geocoding API and to your
> server's egress IPs. If a browser-side map is ever added, it must use a *third*,
> referrer-locked key - never this one.


### Feature 11 - Managed Forgetting

A journal that deliberately forgets. The inverse of what every other AI product does.

**The inversion:** the canonical stored body is the **redacted** text — always, on every
write path, server and client. The personal details live in a separate payload holding the
placeholder map, encrypted under a Cloud KMS-wrapped per-user data key. Past the retention
window a scheduled job destroys that payload. The entry stays fully readable and fully
searchable; only the details are gone:

> Dia minta aku follow up ke `[EMAIL_1]`

Because the plaintext was never the canonical form, forgetting is not a deletion that has
to chase copies. There is nothing to chase.

- **Window:** 30 / 90 (default) / 365 / never. "Off" is not offered — below 30 days the
  details would vanish before you had read your own reflection back, which is data loss
  rather than a privacy control.
- **Irreversible by design.** The plaintext map is never stored anywhere else, so there is
  no archive, no backup copy, and no administrator who can recover it.
- **Shortening destroys immediately** and requires typing `FORGET THE DETAILS NOW`.
  Lengthening needs no confirmation, because nothing is lost.
- **Retention state is shown plainly** under the entry title ("Details expire in 34 days" /
  "Details forgotten on 12 Jun 2026") and as a hollow gutter mark that fills as the window
  elapses.
- **Forgetting costs no retrieval quality.** Recall and Patterns already operate on the
  redacted text, so the search corpus is identical before and after.

```bash
# Cloud KMS key (see .env.example for the full IAM grant)
gcloud kms keyrings create journal --location=global
gcloud kms keys create rehydration --location=global --keyring=journal     --purpose=encryption
gcloud kms keys add-iam-policy-binding rehydration --location=global     --keyring=journal     --member="serviceAccount:journal-app-sa@${PROJECT_ID}.iam.gserviceaccount.com"     --role="roles/cloudkms.cryptoKeyEncrypterDecrypter"

# The nightly forgetting job
gcloud scheduler jobs create http managed-forgetting     --schedule="0 3 * * *" --time-zone="Asia/Jakarta"     --uri="https://YOUR_SERVICE_URL/api/cron/forget" --http-method=POST     --oidc-service-account-email="scheduler@${PROJECT_ID}.iam.gserviceaccount.com"     --oidc-token-audience="https://YOUR_SERVICE_URL"
```

> If Cloud KMS is not configured, entries are still written with the redacted body as
> canonical but **no rehydration payload is stored at all** — the details are simply never
> recoverable. The application never falls back to storing the placeholder map unencrypted.

> **Migration note:** entries written before this feature still hold plaintext in the
> client-side `interactions` store and are not reachable by the forgetting job. Managed
> forgetting applies to entries created from this version onward. See `TRUST_LEDGER.md`
> caveat C11.

---

## Trust Documentation

| Document | What it is |
|---|---|
| [`TRUST_LEDGER.md`](./TRUST_LEDGER.md) | Every trust claim, its enforcement mechanism, and **how to verify it yourself**. Includes a frank caveats section covering known gaps. |
| [`THREAT_MODEL.md`](./THREAT_MODEL.md) | STRIDE matrix (15 threats), expansion trust boundaries, and known gaps in the document itself. |
| [`security_spec.md`](./security_spec.md) | Data invariants and the "Dirty Dozen" malicious payloads. |

**Read `TRUST_LEDGER.md` §4 first if you are evaluating this system.** It records a
critical authentication bypass found and fixed during the expansion work, and it lists
which documented protections are not currently implemented.

---

## Local Setup & Development

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
Copy `.env.example` to `.env.local` and provide your Gemini API key:
```bash
cp .env.example .env.local
# Set GEMINI_API_KEY=your_key_here
```

### 3. Run Development Server
```bash
npm run dev
```
The application will be accessible at `http://localhost:3000`.

---

## Firestore Emulator Workflow & Security Testing

The codebase includes an automated security verification test suite (`firestore.rules.test.ts`) that runs against the Firebase Local Emulator to prove the Four Axioms of Fortress Security:
- **Axiom A:** Owner can read/write their own subtree.
- **Axiom B:** Cross-user isolation (Bob receives `PERMISSION_DENIED` trying to get or list Alice's entries, messages, chunks, or insights).
- **Axiom C:** Unauthenticated guests receive `PERMISSION_DENIED`.
- **Axiom D:** Malformed field shapes and out-of-bounds mood scores are rejected.

### Command to Run Security Suite:
```bash
npx firebase emulators:exec --only firestore "npx vitest run firestore.rules.test.ts"
```

---

## Production Deployment to Cloud Run

### 1. Provision Secret in Google Cloud Secret Manager
```bash
gcloud secrets create gemini-api-key --replication-policy="automatic"
echo -n "YOUR_GEMINI_API_KEY" | gcloud secrets versions add gemini-api-key --data-file=-
```

### 2. Grant Secret Accessor Role to Cloud Run Service Account
```bash
gcloud secrets add-iam-policy-binding gemini-api-key \
    --member="serviceAccount:YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
```

### 3. Deploy Firestore Rules
```bash
npx firebase deploy --only firestore:rules
```

### 4. Build and Deploy Container
```bash
npm run build
gcloud run deploy personal-gemini-journal \
    --source . \
    --platform managed \
    --region us-central1 \
    --allow-unauthenticated \
    --set-env-vars GCP_PROJECT_ID=YOUR_PROJECT_ID,GCP_GEMINI_SECRET_NAME=gemini-api-key
```

---

## 90-Second Demo Script for Evaluators

| Timestamp | Screen Action | What the Judge Sees / Evaluates |
| :--- | :--- | :--- |
| **0:00 - 0:15** | Arrive at landing page and click **"Continue with Google"**. | Authenticates via Google Sign-In. Observes the calm **"Nightstand"** aesthetic (desaturated slate, humanist serif typography, zero violet gradients). |
| **0:15 - 0:35** | Type an entry containing a phone number and card: <br> *"I felt anxious about the launch. Called Dr. Lee at +1-555-432-8765 to reschedule, and put $45 on my Visa 4532-1188-9922-3456."* Click **"Reflect"**. | **Flagship Feature 1:** The **Egress Ledger** immediately reveals on the right rail that the phone number and Luhn-validated credit card were masked into `[PHONE_1]` and `[CREDIT_CARD_1]` *before* egress. The model provides an empathetic reflection with zero sensitive numbers sent upstream. |
| **0:35 - 0:50** | Switch mode to **"Recall"** in the segmented control. Ask: *"What was I anxious about regarding the launch?"* | **Feature 2:** The model answers using historical chunks from `users/{uid}/chunks`, citing `[Entry: entry_xxx]` inline. Clicking the citation deep-links directly to the historical passage. |
| **0:50 - 1:05** | Click the **"Patterns"** button in the header. | **Feature 3:** Displays weekly longitudinal patterns, recurring themes, observed friction points, and a single provocative Socratic question for next week. |
| **1:05 - 1:20** | Click the **"Trust Ledger"** shield icon in the header. Click **"Export Archive"**. | **Feature 4:** Instant download of `journal-export.json` and human-readable `journal-archive.md`. Open "Hard Delete", type `"DELETE MY JOURNAL"`, and confirm cascading wipe leaving an immutable audit tombstone. |
| **1:20 - 1:30** | Attempt cross-user access in a second browser profile / incognito tab. | Firestore rules mathematically return `PERMISSION_DENIED`. The security boundaries hold completely. |

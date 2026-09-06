# I Found a Critical Auth Bypass in My Own Hackathon Project — Then Built a Page That Lets You Verify the Fix

### Building Nightstand: a private AI journal on Gemini and Firebase, and why I stopped asking anyone to trust me

---

![A quiet writing surface for honest introspection — the Nightstand landing page](screenshots/01-landing.png)

*Nightstand. The promise on the landing page is the one the rest of this article has to earn.*

---

A journaling app is the worst possible place to be casual about privacy.

People write things in a journal they would never say out loud. A medical worry. A number
they should not have written down. A name attached to a feeling. And the moment you point
a language model at that text, you have created an **egress path** — a place where the most
private sentence someone owns leaves their machine and lands in somebody else's logs.

So I built **Nightstand** for the Google APAC Academy hackathon: a private journal on
Gemini 3.6 Flash, Firebase Auth, Cloud Firestore, Secret Manager and Cloud KMS.

Every product in this category promises privacy. I wanted to build one where **you never
have to take my word for it.**

---

## The bug that changed how I built everything after it

Two hours in, I was reading `verifyFirebaseIdToken` — the function that decides who you
are — and found this:

```ts
// Cryptographic Signature Verification using Google's Public Key
if (header.kid) {
  const certs = await getGooglePublicKeys();
  const cert = certs[header.kid];
  if (cert) {
    // ... verify signature ...
  }
}
```

Read those two `if` statements carefully.

If a token's header had **no `kid`**, the entire signature check was skipped — and the
function returned a *trusted identity* anyway. Anyone could have forged a token for any
user id, with no signature at all, and read that person's journal.

It was my own code. It passed typecheck. It passed lint. No test caught it, because the
tests asserted what the function *returned*, never what it *refused*.

The fix itself is unremarkable: verification is now mandatory and fail-closed, the
algorithm is pinned to RS256, and a missing or unknown `kid` is a hard rejection. What
mattered was the lesson — **a security claim nobody can check is just a sentence.**

Here is that exact attack against the running application:

```bash
curl -X POST http://localhost:3000/api/journal/chat \
  -H "Authorization: Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJhdHRhY2tlciIsInJvbGUiOiJhZG1pbiJ9." \
  -d '{"prompt":"test"}'
```

```json
{
  "error": "UNAUTHORIZED: Valid Firebase ID token is required.",
  "details": "Unsupported token algorithm: none. Expected RS256."
}
```

An unsigned token claiming to be an administrator. Refused.

That single experience set the design rule for everything else: **every privacy claim in
this app ships with a way to falsify it.** Here are the five features that came out of it.

---

## Feature 1 — The Privacy Shield, and the Egress Ledger that proves it

**What it is.** A deterministic redaction pipeline that runs on the server, before any
text reaches Gemini.

**What it does.** It detects and masks emails, phone numbers, credit cards (verified with
a Luhn checksum, so it does not fire on random digits), IBANs, access tokens embedded in
URLs — and, because I am building for an Indonesian context, **NIK and NPWP numbers** and
**Indonesian street addresses** (`Jl.`, `Gg.`, `Komplek`, RT/RW, kelurahan, kecamatan).

Each detected value becomes a stable placeholder — `[EMAIL_1]`, `[PHONE_1]`. The model
sees only the placeholders. Your own words are restored in server memory before display.
**The mapping is never written to a database and never logged.**

**Why it matters.** Every off-the-shelf PII detector I looked at handles US phone formats
and misses a 16-digit NIK entirely — which is precisely the number an Indonesian user is
most likely to write down and least able to afford leaking.

Try it. Write this entry:

> Met with Budi Santoso from PT Meridian Karya today about the Q4 contract. He asked me to
> follow up at budi.santoso@meridian.example and confirm on +62 812-3456-7890. For the
> paperwork he sent his NIK 3174052509900001, and his office is at Jl. Jenderal Sudirman
> No. 52, Kebayoran Baru, Jakarta Selatan. I'm not sure the price I quoted really reflects
> the value of the work.

What actually leaves the server is this — copied verbatim from the pipeline, not tidied up
for the article:

> Met with Budi Santoso from PT Meridian Karya today about the Q4 contract. He asked me to
> follow up at `[EMAIL_1]` and confirm on `[PHONE_1]`. For the paperwork he sent his NIK
> `[INDONESIAN_NIK_1]`, and his office is at `[ADDRESS_1]`, Jakarta Selatan. I'm not sure
> the price I quoted really reflects the value of the work.

Masked categories: `{"email":1,"phone":1,"indonesian_nik":1,"address":1}`

Note what survived: **"Jakarta Selatan"**. The street address is gone, but the city district
remains. That is the honest behaviour of a pattern-based detector, and I am showing it
rather than cropping it out — a district of two million people is a very different
disclosure from a street number, but it is not nothing, and you should know the difference
before you trust the pipeline.

Gemini still answers the real question — the one about whether you priced your work
correctly — because the *meaning* survives redaction even when the identifiers do not.

![The Egress Ledger showing masked entity counts and the exact payload sent upstream](screenshots/02-egress-ledger.png)

*The Egress Ledger. Not a summary of what was sent — the actual bytes.*

And you do not have to believe any of it, because the **Egress Ledger** in the right rail
shows you the exact payload that departed, expandable, verbatim.

---

## Feature 2 — The Adversarial Self-Test

**What it is.** A page at `/security/self-test` that attacks the running application and
reports whatever the backend actually returns.

**What it does.** Nine checks, run in sequence against the live system using your own
session token:

| Check | What it attacks |
|---|---|
| `CROSS_TENANT_READ` | Reads another account's entry document |
| `CROSS_TENANT_LIST` | Lists another account's entries collection |
| `UID_SPOOFING` | Valid token, forged user id in the request body |
| `UNAUTHENTICATED_ACCESS` | The model route with no Authorization header |
| `PROMPT_INJECTION` | A real injection payload through the real model path |
| `CLIENT_BUNDLE_SECRETS` | Scans the built client bundle for key-shaped strings |
| `REDACTION_COVERAGE` | Submits fixture PII, asserts none survives upstream |
| `ADMIN_BLINDNESS` | An administrator reading a user's journal |
| `RATE_LIMIT` | Fires the documented limit plus one |

**No mocks. No hardcoded outcomes. No simulated delays.** Every verdict is computed from a
real HTTP status, a real Firestore response, or a real model reply — and every check
expands to show you the raw response.

![The self-test page with nine checks passing, each showing elapsed time and directive](screenshots/03-selftest-results.png)

*Nine adversarial checks against the running app. Failures render exactly as prominently as passes.*

**Why it matters.** Three properties keep that page honest, and each is regression-tested:

- **Verdicts are server-authored.** The browser drives the sequence so the UI can show
  progress, but every verdict is computed server-side and written to a run document that
  Firestore denies all client writes to. A modified client cannot fake a clean run.
- **Probes use your own token,** never a service credential. A probe using the
  rules-bypassing admin credential would succeed — and pass while proving the opposite of
  what it claims.
- **The target is a synthetic tenant.** Cross-tenant probes only ever point at a configured
  throwaway account. With none configured they report **skipped**, never *pass* — because a
  security page that performs the attack it exists to disprove is not a security page.

![The expanded raw response for the prompt injection check, showing Gemini's actual reply](screenshots/04-selftest-injection.png)

*The injection check shows Gemini's actual reply, so you judge containment yourself rather than trusting a green tick.*

---

## Feature 3 — The Blind Admin Console

**What it is.** An operational dashboard for whoever runs the service.

**What it does.** It shows fleet health only: daily active users, model latency p50/p95,
token spend, error rates, rate-limit hits, and a fleet-wide histogram of which PII
categories are being masked. Administrators can suspend an account and revoke its sessions.

**Administrators cannot read, search, or export any journal content.**

Every figure is a precomputed aggregate, and any cell backed by **fewer than five distinct
users** is withheld — because "one user triggered NIK redaction in Jakarta" is not an
anonymous statistic, it is a name.

The header states it plainly: **"This console cannot read user entries."** Underneath is a
button labelled **Prove it**.

![The admin console header stating it cannot read user entries, with suppressed metrics](screenshots/05-admin-console.png)

*Cells backed by fewer than five users read "withheld". That is the feature working, not a bug.*

Clicking **Prove it** performs a real Firestore read of another account's journal using the
administrator's own token, and shows the verbatim response:

```
GET .../users/{other_uid}/entries
HTTP 403 · PERMISSION_DENIED
```

Alongside it runs a **control probe** — the same token reading the admin's *own* entries,
which returns `200`. That second request is the honest part. Without it a `403` could just
mean an expired token. With it, you know the denial was a real authorization decision.

![The Prove it panel showing a 403 PERMISSION_DENIED next to a successful 200 control probe](screenshots/06-admin-prove-it.png)

*Target probe denied. Control probe succeeds. The token works — the refusal is authorization.*

**Why it matters.** The mechanism is boring, which is exactly why it holds:
`firestore.rules` gates `/users/{userId}/**` on `request.auth.uid == userId`, and **no rule
anywhere consults the admin role.** The console is blind because the database refuses it,
not because the application politely declines.

---

## Feature 4 — Managed Forgetting

**What it is.** A retention policy for the personal details inside your entries.

**What it does.** Entries store the **redacted** text as the canonical body — always. The
personal details live in a separate payload holding the placeholder map, encrypted under a
per-user data key wrapped by Cloud KMS. After your window (30 / 90 / 365 days, default 90),
a scheduled job destroys that payload.

The entry stays fully readable and fully searchable. Only the details are gone:

> He asked me to follow up at `[EMAIL_1]` before Friday.

![The retention settings panel showing 30/90/365/never options and the irreversibility warning](screenshots/07-managed-forgetting.png)

*Every other AI product races to remember more about you. This one deliberately forgets.*

**Why it matters.** Because the plaintext was never the canonical form, forgetting is not a
deletion that has to chase copies across backups. There is nothing to chase.

Two details I am proud of:

- **Forgetting costs you nothing.** Recall and Patterns already operate on the redacted
  text, so search works exactly as well afterwards. Forgetting does not degrade the product.
- **Shortening your window destroys data immediately,** so it demands you type
  `FORGET THE DETAILS NOW` first. It cannot be undone, and the interface says so plainly
  instead of hedging about backups.

---

## Feature 5 — A journal, not a chat client

**What it is.** The reading and writing surface.

**What it does.** Your text sits directly on the page — no bubble, no avatar, no inline
timestamp. The model's reply is indented behind a hairline rule, one step smaller and in a
secondary colour, so it reads as a **margin note on your own writing** rather than a reply
from a person.

A narrow left gutter carries marks derived entirely from the content beside them: a filled
arc encoding the mood of that passage, a small amber square where personal data was masked,
a tick where a commitment was extracted, and a hollow ring that fills as the retention
window elapses.

![The journal entry view with the marginalia gutter, text column and context rail](screenshots/08-journal-entry.png)

*Marks in the gutter are an index of the text, never decoration. Nothing appears there that is not derived from the content beside it.*

**Why it matters.** A chat client spends its layout on *attribution* — who said this, when.
A journal answers a different question: *what did I think?* So the attribution apparatus is
deleted, and what replaces it is **provenance**: what this passage carried, what left the
server, what you committed to.

There is also a **"Save without reply"** button. The model is optional, not a toll gate.

---

## Two more bugs, found the same way

Auditing the finished app before submission turned up two more real problems that every
automated check had missed.

**The recall route bypassed the Privacy Shield entirely.** The chat route was shielded, so
the guarantee *looked* upheld — but semantic recall sent your query verbatim to both the
embedding model and Gemini. Ask *"what did I discuss with budi@example.com?"* and that
address went straight to Google. Fixed, and now regression-tested across every egress path.

**Recall chunks were built from raw text,** not redacted text. PII reached the embedding
endpoint, and a "forgotten" entry would have stayed fully searchable in its original
detail — quietly defeating the entire forgetting feature.

I had already written in my own trust documentation that recall operated on redacted text.
It did not. I had asserted it from the design intent without checking the implementation.

---

## What this app does *not* do

A trust document that lists only strengths is marketing. So the repository ships a
**Trust & Architecture Ledger** where every claim names its enforcement mechanism *and* the
test that verifies it — followed by a caveats section that includes:

- **The Firestore rules unit tests do not currently run.** They need dependencies that are
  not installed. Rules claims are verified today by live probes against real Firestore, not
  by an emulator suite. That is weaker, and it is labelled as weaker.
- **The service account can technically read user documents.** Blindness is enforced against
  admin *tokens*, not against whoever can deploy code. Closing that needs a split service
  account, and I have not done it.
- **Managed forgetting applies only to entries created after the feature shipped.** Older
  entries need a migration.
- **The Privacy Shield is deterministic, not magic.** It catches patterns. Person names are
  only caught in strict mode.

I would rather a judge read that list from me than discover it themselves.

---

## The engineering, briefly

- **145 tests**, 144 passing, one skipped because it needs a live API key. Zero failures.
- 24 API routes. Clean production build, clean lint, clean typecheck.
- Zero console errors and zero server errors on a cold start.
- **23 threats** catalogued in a STRIDE model, each with a mitigation and a verification method.
- Secrets resolved from Google Cloud Secret Manager with an env fallback. **Zero hardcoded
  keys** — the only `AIza` string anywhere is the Firebase *web* key, which is public by
  design, and the bundle scanner excludes it **by exact value rather than by pattern**, so a
  genuinely secret Google key would still be reported.

---

## What I actually learned

Every real bug in this project was found by **running something**, not by reasoning about it.

The auth bypass came from reading the code with an attacker's eye. The recall gap came from
grepping for which routes call a model. A third bug — where the app permanently destroyed a
user's phone number on the very first write — came from running it the way my own README
tells a newcomer to, with only a Gemini key set.

Every one of those passed typecheck, lint, and a green test suite first.

So the feature I would defend hardest is not the redaction pipeline or the encryption. It is
the page that attacks the app and shows you the raw response. Not because it makes the
system secure — it does not — but because it makes the security claims **falsifiable**.

If something on that page is red, believe it. That is the whole point.

---

*Built for the Google APAC Academy hackathon with Gemini 3.6 Flash, Firebase Auth, Cloud
Firestore, Secret Manager and Cloud KMS.*

---
---

# ⚠️ DELETE EVERYTHING BELOW BEFORE PUBLISHING

## Screenshot capture checklist

Eight images. Capture at **1440×900**, light or dark theme — just stay consistent.
On Windows: `Win + Shift + S`.

| # | File | Where | Exactly what to capture |
|---|---|---|---|
| 1 | `01-landing.png` | `localhost:3000`, logged out | ✅ **Already verified rendering.** Full landing page including the headline and the three cards |
| 2 | `02-egress-ledger.png` | After submitting the demo entry | Right rail: **"Sent upstream"** with the category counts, **and** the expanded *"Exact payload that departed"* showing `[EMAIL_1]` / `[PHONE_1]` / `[INDONESIAN_NIK_1]` |
| 3 | `03-selftest-results.png` | `/security/self-test` after **Run the checks** | The full checklist with pass marks, elapsed times and check ids |
| 4 | `04-selftest-injection.png` | Same page | Expand **`PROMPT_INJECTION`** → the raw response showing the injection sent and Gemini's actual reply |
| 5 | `05-admin-console.png` | `/admin` | The header line *"This console cannot read user entries."* plus the metric cards (several will say **"withheld"** — that is the point) |
| 6 | `06-admin-prove-it.png` | `/admin`, after **Prove it** | Both probes side by side: target `HTTP 403 PERMISSION_DENIED`, control `HTTP 200` |
| 7 | `07-managed-forgetting.png` | Clock icon in header | The retention panel with 30/90/365/never and the irreversibility copy. **Bonus:** select a shorter window first so the red `FORGET THE DETAILS NOW` confirmation box is visible |
| 8 | `08-journal-entry.png` | Any entry with the demo text | The three-column layout: gutter marks on the left, entry text in the middle, context rail on the right |

**Optional but strong:** a terminal screenshot of the `curl` command with the `alg:none`
token being rejected. Put it right after the code block in *"The bug that changed how I
built everything after it"*.

## Notes on the demo entry

Use the English prompt from Feature 1 verbatim. Every value in it is **fake**:

- `budi.santoso@meridian.example` — `.example` is reserved by RFC 2606 and can never resolve
- `+62 812-3456-7890` — sequential, not a real number
- `3174052509900001` — structurally valid NIK format, not a real citizen record

**Never use real personal data in a demo screenshot**, including your own.

## Three claims to avoid making

- ❌ Do **not** say the Firestore rules are tested with the emulator. They are not. Say
  *"verified by live probes against real Firestore"* — true, and stronger anyway.
- ❌ Do **not** claim all PII is always caught. It is pattern-based and deterministic.
- ❌ Do **not** imply Managed Forgetting covers entries written before the feature shipped.

## If a self-test check shows "skipped"

`CROSS_TENANT_READ` and `CROSS_TENANT_LIST` report **skipped** when `SELFTEST_FIXTURE_UID`
is not set. That is correct, deliberate behaviour — the probe refuses to be aimed at a real
account. Either set the variable to a throwaway account's uid before capturing screenshot 3,
or explain it in the caption. Do not present it as a failure.

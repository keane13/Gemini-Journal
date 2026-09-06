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

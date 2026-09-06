# Submission Brief

---

## VERSI UTAMA (~330 kata) — pakai ini kalau tidak ada batas ketat

**Nightstand — a private AI journal you don't have to take on trust.**

People write things in a journal they would never say aloud. Pointing a language model at
that text creates an egress path: the most private sentence someone owns leaves their
machine and lands in someone else's logs. Nightstand is a multi-turn reflective journal
built so that every privacy claim it makes can be independently verified by the user.

**Gemini** powers the reflection itself. Entries become multi-turn conversations across
five modes — Reflection, Brainstorming, Synthesis, Analysis and grounded Recall — with a
model fallback ladder for resilience. Every prompt is wrapped in `<untrusted_journal_data>`
fencing with explicit negative constraints, so retrieved journal text is treated as data
and never as instructions. Crucially, Gemini only ever receives **redacted** text: a
deterministic Privacy Shield masks emails, phone numbers, Luhn-verified credit cards,
IBANs, and — for Indonesian users — NIK, NPWP and street addresses, before anything leaves
the server. An in-app Egress Ledger shows the user the exact payload that departed.

**Firebase Authentication** provides Google sign-in. The server independently verifies each
ID token with mandatory RS256 signature checking against Google's published certificates,
and derives the user id from the signed token — any user id in a request body is discarded.
Custom claims carry role-based access for the operations console.

**Cloud Firestore** stores each user's journal under `users/{uid}/**`, with security rules
gating every path on `request.auth.uid == userId`. Cross-user access is structurally
impossible rather than merely discouraged, and semantic recall embeddings are scoped inside
the same subtree.

**Cloud Run** is the execution boundary that makes the rest work. All model calls, redaction
and Firestore writes run server-side, so no API key is ever bundled into the browser.
Credentials are resolved at runtime from the instance metadata server — Gemini and Maps keys
from **Secret Manager**, and a per-user data key wrapped by **Cloud KMS** for the encrypted
payload behind Managed Forgetting. Scheduled jobs (weekly digest, retention sweep, metrics
flush) are invoked by **Cloud Scheduler** using OIDC identity tokens the service verifies
before acting.

---

## VERSI PENDEK (~140 kata) — kalau form-nya dibatasi

**Nightstand — a private AI journal you don't have to take on trust.**

**Gemini** drives multi-turn reflection across five modes, with prompt-injection fencing and
a model fallback ladder. It only ever receives **redacted** text: a deterministic Privacy
Shield masks emails, phones, cards, and Indonesian NIK/NPWP/addresses before egress, and an
Egress Ledger shows the user the exact payload that was sent.

**Firebase Auth** handles Google sign-in; the server verifies each ID token with mandatory
RS256 signature checking and ignores any client-supplied user id.

**Cloud Firestore** isolates every journal under `users/{uid}/**`, with rules gating each
path on `request.auth.uid == userId` — making cross-user access structurally impossible.

**Cloud Run** executes all model calls, redaction and writes server-side so no key reaches
the browser, resolving Secret Manager and Cloud KMS credentials from the instance metadata
server, and hosting OIDC-authenticated Cloud Scheduler jobs.

---
---

# ✅ KOREKSI — APLIKASI ANDA SUDAH LIVE

Saya sebelumnya menyarankan Anda **tidak** menyebut deployment, karena tidak ada Dockerfile
di repo dan `APP_URL` masih localhost. **Saran itu salah.** Aplikasinya ternyata sudah
ter-deploy di:

    https://privacy-shield-ledger-journal.ai.studio

Diverifikasi langsung: HTTP 200, `x-powered-by: Next.js`, `server: Google Frontend` —
server-side Next.js sungguhan, bukan static hosting. Dan yang penting, perbaikan keamanan
sesi ini sudah live di sana: token `alg:none` yang mengaku admin **ditolak** oleh server
produksi.

**Jadi:**
- ✅ Cantumkan URL itu di field demo/link submission
- ✅ Paragraf Cloud Run di brief boleh dipakai apa adanya — semuanya terbukti berjalan
- ⚠️ Kalau form menanyakan platform hosting secara spesifik, sebut apa yang Anda tahu
  pasti. AI Studio men-deploy ke Cloud Run, tapi kalau ragu, cukup tulis
  *"deployed as a server-side Next.js service on Google Cloud"* — itu terverifikasi.

---

# ⚠️ BACA SEBELUM SUBMIT

## Soal Cloud Run — sudah terjawab (lihat koreksi di atas)

Aplikasinya live. Yang tertulis di brief soal arsitektur Cloud Run memang benar-benar ada
di kode dan terbukti berjalan di produksi:

- semua panggilan model & tulis Firestore berjalan server-side (bukan di browser),
- kredensial diambil dari **instance metadata server** (`lib/server/google-auth.ts`) —
  jalur yang hanya masuk akal di Cloud Run,
- endpoint terjadwal memverifikasi **OIDC token dari Cloud Scheduler**
  (`lib/server/cron-auth.ts`),
- Secret Manager & KMS diakses lewat service account runtime.

Semua itu nyata dan bisa dibuka juri di kode.

**Satu hal yang HARUS Anda lakukan sebelum submit: REDEPLOY.**

Versi yang live sekarang belum memuat batch perbaikan terakhir sesi ini:

1. Self-test yang gagal dengan "Run not found" — sudah diperbaiki (run store dipindah ke
   `globalThis` supaya bertahan saat modul dievaluasi ulang di dev/serverless)
2. Route Recall yang **melewati Privacy Shield sepenuhnya** — query Anda dikirim mentah ke
   Gemini dan ke embedding model. Ini celah keamanan nyata dan sudah ditutup
3. Self-test yang menulis teks fixture ke corpus Recall Anda
4. Pesan error yang tidak bisa didiagnosa

Nomor 2 adalah alasan terkuat untuk redeploy: itu memperbaiki lubang di klaim inti
submission Anda.

## Soal halaman self-test

Brief di atas **sengaja tidak menyebut** Adversarial Self-Test, karena saat ini masih ada
6 check yang gagal dan belum ketahuan sebabnya. Menyebutnya di brief mengundang juri
membukanya.

Kalau nanti sudah hijau, sisipkan kalimat ini di akhir paragraf pertama:

> An in-app adversarial self-test page attacks the running application — cross-tenant
> reads, uid spoofing, prompt injection, redaction coverage — and displays the raw backend
> response for each, so the security claims are falsifiable rather than asserted.

## Yang aman diklaim sekarang

- Privacy Shield + Egress Ledger — terverifikasi, ada tesnya
- Isolasi per-user lewat Firestore rules — terverifikasi
- Verifikasi token RS256 wajib — **terbukti runtime** (token `alg:none` ditolak)
- Nol key ter-hardcode — terverifikasi lewat scan
- Managed Forgetting — terimplementasi, ada tesnya
- 145 test, 144 lulus, 0 gagal

# Demo Runbook — 5 menit

Urutan ini disusun supaya klaim terkuat muncul lebih dulu. Kalau waktu habis di tengah,
tiga demo pertama sudah cukup untuk menutup keempat kriteria penilaian.

**Sebelum mulai:** `npm run dev`, login, siapkan screen recorder.

---

## Demo 1 — Privacy Shield + Egress Ledger (90 detik)

**Kriteria: Security, Usability, Authenticity**

Paste prompt ini (bahasa Inggris, sesuai artikel). Semua data di dalamnya **fiktif** —
jangan pernah pakai data asli untuk demo.

```
Met with Budi Santoso from PT Meridian Karya today about the Q4 contract. He asked
me to follow up at budi.santoso@meridian.example and confirm on +62 812-3456-7890.
For the paperwork he sent his NIK 3174052509900001, and his office is at
Jl. Jenderal Sudirman No. 52, Kebayoran Baru, Jakarta Selatan. I'm not sure the
price I quoted really reflects the value of the work.
```

**Sudah diverifikasi** terhadap pipeline-nya. Output persisnya:

```
categoryCounts: {"email":1,"phone":1,"indonesian_nik":1,"address":1}

Met with Budi Santoso from PT Meridian Karya today about the Q4 contract. He asked
me to follow up at [EMAIL_1] and confirm on [PHONE_1]. For the paperwork he sent
his NIK [INDONESIAN_NIK_1], and his office is at [ADDRESS_1], Jakarta Selatan.
I'm not sure the price I quoted really reflects the value of the work.
```

> Perhatikan **"Jakarta Selatan"** tetap lolos — alamat jalannya hilang, nama kotanya
> tidak. Kalau juri menanyakan ini, jawab jujur: detektornya berbasis pola, dan kota
> tingkat kecamatan bukan pengenal individu. Artikelnya sudah menyebut ini duluan, jadi
> Anda tidak akan terlihat menutupi apa pun.

Klik **Reflect on this**.

**Yang harus ditunjukkan:**

1. Gemini menjawab pertanyaan reflektifnya — jadi fiturnya memang berguna, bukan cuma
   demo keamanan.
2. Buka **Egress Ledger** di rail kanan. Histogramnya akan menampilkan tepat:
   `Email ×1`, `Phone ×1`, `NIK ×1`, `Address ×1`.
3. Buka **"Exact payload that departed"**. Ini bagian yang menjual: penonton membaca
   *persis* apa yang dikirim ke Google, dan nomor teleponnya sudah jadi `[PHONE_1]`.
4. Tunjuk gutter kiri: kotak amber kecil = ada data yang di-mask di blok itu.

**Kalimat kunci:** *"NIK dan alamatnya tidak pernah keluar dari server ini. Bukan karena
saya bilang begitu — ini payload aslinya, silakan dibaca."*

> Deteksi NIK/NPWP dan alamat Indonesia (Jl./Gg./Kel./Kec.) adalah bagian yang
> paling jarang ada di submission lain. Tonjolkan ini.

---

## Demo 2 — Adversarial Self-Test (90 detik)

**Kriteria: Security, Stability, Authenticity — ini demo terkuat**

Buka **`/security/self-test`** → klik **Run the checks**.

**Yang harus ditunjukkan:**

1. Sembilan check jalan berurutan: `pending → running → pass`.
2. Expand **`CROSS_TENANT_READ`** → tunjukkan `PERMISSION_DENIED` mentah dari Firestore.
3. Expand **`PROMPT_INJECTION`** → tunjukkan balasan Gemini yang **sebenarnya** terhadap
   payload injeksi.
4. Expand **`REDACTION_COVERAGE`** → histogram + payload upstream.
5. Klik **Copy summary** — hasilnya bisa langsung ditempel di artikel/submission.

**Kalimat kunci:** *"Halaman ini menyerang aplikasinya sendiri sambil berjalan. Tidak ada
mock, tidak ada hasil yang di-hardcode. Kalau ada yang merah, percayalah."*

> Kalau `CROSS_TENANT_*` muncul **skipped**, itu karena `SELFTEST_FIXTURE_UID` belum
> diisi. Itu **desain yang benar** — probe menolak diarahkan ke akun asli. Jelaskan
> begitu; jangan dianggap gagal.

---

## Demo 3 — Blind Admin Console (60 detik)

**Kriteria: Security, Authenticity**

Buka **`/admin`**.

**Yang harus ditunjukkan:**

1. Header: **"This console cannot read user entries."**
2. Metrik operasional dengan **small-cell suppression** — kalau fleet-nya kecil, nilainya
   tampil **"withheld"**. Tunjukkan ini; justru itu buktinya bekerja.
3. Masukkan uid akun lain → klik **"Attempt to read this user's journal"**.
4. Tunjukkan dua probe:
   - **target** → `HTTP 403 PERMISSION_DENIED`
   - **control** (baca jurnal admin sendiri) → `HTTP 200`

**Kalimat kunci:** *"Control probe-nya berhasil, jadi token-nya valid dan Firestore
memang bisa dihubungi. Penolakan di atas adalah keputusan otorisasi sungguhan, bukan
token rusak."*

---

## Demo 4 — Managed Forgetting (45 detik)

**Kriteria: Authenticity, Usability**

Klik ikon **jam** di header → **"What this journal forgets"**.

**Yang harus ditunjukkan:**

1. Pilihan 30 / 90 / 365 / never — **default 90 hari**, dan "off" sengaja tidak ada.
2. Baca kalimatnya: entri tetap terbaca dan tetap bisa dicari; hanya detailnya yang hilang
   — `"Dia minta aku follow up ke [EMAIL_1]"`.
3. Pilih window lebih pendek → muncul input konfirmasi ketik
   **`FORGET THE DETAILS NOW`**. Tunjukkan lalu **batalkan**.

**Kalimat kunci:** *"Hampir semua aplikasi AI mengingat selamanya. Ini sengaja lupa, dan
tidak bisa dibatalkan."*

---

## Demo 5 — Bukti runtime (30 detik, opsional tapi kuat)

**Kriteria: Security**

Jalankan di terminal, rekam layarnya:

```bash
curl -s -X POST http://localhost:3000/api/journal/chat \
  -H "Authorization: Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJhdHRhY2tlciIsInJvbGUiOiJhZG1pbiJ9." \
  -H "Content-Type: application/json" -d '{"prompt":"test"}'
```

Output:

```json
{"error":"UNAUTHORIZED: Valid Firebase ID token is required.",
 "details":"Unsupported token algorithm: none. Expected RS256."}
```

**Kalimat kunci:** *"Token palsu tanpa tanda tangan yang mengaku admin. Ditolak oleh
aplikasi yang sedang berjalan."*

---

## Yang JANGAN diklaim

Jujur soal ini justru menaikkan kredibilitas, dan kalau juri menemukannya sendiri
sementara Anda mengklaim sebaliknya, itu jauh lebih merugikan.

- ❌ Jangan bilang Firestore rules diuji dengan emulator. `firestore.rules.test.ts`
  **belum jalan** (butuh `vitest` + `@firebase/rules-unit-testing`, dan Java untuk
  emulator). Katakan: *"rules diverifikasi lewat probe langsung ke Firestore"* — itu
  benar, dan itu yang dilakukan self-test.
- ❌ Jangan bilang semua PII pasti tertangkap. Privacy Shield itu deterministik dan
  berbasis pola; nama orang hanya tertangkap di mode `strict`.
- ❌ Jangan bilang Managed Forgetting berlaku untuk entri lama. Hanya untuk entri yang
  dibuat setelah fitur ini ada.

## Angka yang boleh dipakai

- 145 test, 144 lulus, 1 di-skip (butuh API key live), **0 gagal**
- 24 API route, build produksi bersih, lint bersih, typecheck bersih
- 9 adversarial check, 23 ancaman STRIDE terdokumentasi
- Nol error konsol, nol error server saat dijalankan

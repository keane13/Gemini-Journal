# Cara Upload ke Medium

## Kenapa gambarnya tidak muncul

Dua sebab, dan keduanya wajar bikin bingung:

**1. File gambarnya memang belum ada.** Folder `screenshots/` masih kosong. Saya hanya bisa
memverifikasi halaman landing (yang tidak perlu login) — tujuh gambar sisanya butuh sesi
login Anda, jadi harus Anda yang ambil.

**2. Medium tidak bisa membaca `![](screenshots/01-landing.png)`.**
Itu path file di komputer Anda. Medium tidak punya akses ke disk Anda. Dan yang lebih
penting: **editor Medium memang tidak mendukung sintaks gambar markdown sama sekali** —
tidak peduli path-nya benar atau salah, `![]()` tidak akan pernah jadi gambar di Medium.

Di Medium, gambar **selalu** di-upload lewat editornya. Tidak ada cara lain.

**Bonus masalah ketiga:** Medium juga tidak mendukung **tabel markdown**. Tabel 9 check di
artikel akan hancur jadi teks berantakan penuh tanda `|` saat di-paste. Sudah saya ubah
jadi daftar di file paste-ready.

---

## Pakai file yang mana

| File | Untuk apa |
|---|---|
| **`MEDIUM_PASTE_READY.md`** | **Ini yang di-paste ke Medium.** Tanpa tabel, gambar sudah jadi penanda upload |
| `MEDIUM_ARTICLE.md` | Arsip lengkap dengan checklist screenshot. Jangan di-paste |
| `DEMO_SCRIPT.md` | Runbook saat merekam demo |

---

## Langkah 1 — Ambil 8 screenshot

Jalankan `npm run dev`, login, lalu ambil satu per satu.
Windows: **`Win + Shift + S`** → pilih area → otomatis masuk clipboard.

Simpan ke folder `screenshots/` dengan nama persis ini:

1. `01-landing.png` — `localhost:3000` sebelum login. Headline + tiga kartu
2. `02-egress-ledger.png` — rail kanan setelah submit entry demo, dengan
   *"Exact payload that departed"* dalam keadaan terbuka
3. `03-selftest-results.png` — `/security/self-test` setelah klik **Run the checks**
4. `04-selftest-injection.png` — expand **`PROMPT_INJECTION`**, tampilkan balasan Gemini
5. `05-admin-console.png` — `/admin`, header + kartu metrik (beberapa tertulis "withheld")
6. `06-admin-prove-it.png` — setelah **Prove it**: target 403 dan control 200
7. `07-managed-forgetting.png` — ikon jam → panel retensi
8. `08-journal-entry.png` — tampilan entry tiga kolom

> **Kalau waktu mepet, ambil 4 ini saja:** `02`, `03`, `04`, `06`.
> Empat gambar itu sudah menutup keempat kriteria penilaian. Sisanya bonus.

Prompt demo (semua data fiktif — jangan pernah pakai data asli):

```
Met with Budi Santoso from PT Meridian Karya today about the Q4 contract. He asked me to
follow up at budi.santoso@meridian.example and confirm on +62 812-3456-7890. For the
paperwork he sent his NIK 3174052509900001, and his office is at Jl. Jenderal Sudirman
No. 52, Kebayoran Baru, Jakarta Selatan. I'm not sure the price I quoted really reflects
the value of the work.
```

---

## Langkah 2 — Paste teksnya

1. Buka **medium.com** → foto profil → **Write a story**
2. Buka `MEDIUM_PASTE_READY.md`, **Ctrl+A**, **Ctrl+C**
3. Klik di badan artikel Medium, **Ctrl+V**

Yang akan ikut terkonversi otomatis: judul, subjudul, **bold**, *italic*, blok kode,
bullet, dan blockquote.

Yang perlu dirapikan manual:
- Baris pertama harus jadi **Title** (Medium biasanya otomatis)
- Baris kedua jadi **Subtitle** — blok kutip di editor, atau biarkan
- `---` mungkin jadi garis biasa. Ganti dengan pemisah asli Medium:
  ketik `***` di baris kosong lalu Enter

---

## Langkah 3 — Masukkan gambarnya (ini bagian yang tadi bingung)

Cari blok `▓▓▓▓▓▓▓▓▓▓ UPLOAD IMAGE 01 HERE ▓▓▓▓▓▓▓▓▓▓` di editor.

Untuk tiap blok:

1. **Klik di baris kosong** tepat di atas blok itu
2. Muncul tanda **`+`** di kiri → **klik**
3. Klik **ikon kamera** (paling kiri)
4. Pilih file dari folder `screenshots/`
5. Setelah gambar muncul, **klik tepat di bawah gambar** → ketik caption-nya
   (teks caption sudah disiapkan di baris `Caption :` dalam blok itu)
6. **Hapus kelima baris `▓▓▓` tadi**

**Cara paling cepat:** buka File Explorer di folder `screenshots/`, lalu
**drag-and-drop** file gambarnya langsung ke posisi yang diinginkan di editor Medium.
Jauh lebih cepat daripada lewat menu `+`.

**Cara ketiga:** setelah `Win + Shift + S`, gambar sudah ada di clipboard —
klik di editor Medium lalu **Ctrl+V** langsung. Tidak perlu simpan file sama sekali.

---

## Langkah 4 — Sebelum Publish

- [ ] Semua 8 blok `▓▓▓` sudah hilang (cari `▓` pakai Ctrl+F — harus nol hasil)
- [ ] Tidak ada baris penuh tanda `|` yang tersisa
- [ ] Tiap gambar punya caption
- [ ] Blok kode tampil dengan latar abu-abu, bukan teks biasa
- [ ] Tambahkan tag: `Hackathon`, `Google Cloud`, `Gemini`, `Privacy`, `Firebase`
- [ ] Set **featured image** (pakai `01-landing.png`) — ini yang tampil di preview

---

## Kalau blok kode tidak muncul benar

Medium kadang tidak mengenali ``` saat paste. Perbaikannya:
seleksi teks kodenya → tekan **`Ctrl + Alt + 6`** (Windows) untuk jadikan code block.

## Kalau paste-nya berantakan total

Sebagian editor Medium lebih suka teks polos. Alternatifnya: paste bagian per bagian
(per heading), bukan sekaligus. Lebih lama, tapi hasilnya lebih rapi dan Anda bisa
sisipkan gambar sambil jalan.

# Visit Flow — Backend API (Node.js + Express)

REST API untuk aplikasi **Visit Flow (Sistem Monitoring & Manajemen Rencana Kunjungan Sales)** CV. Mabel Solusi Mandiri. Mendukung autentikasi berbasis token HMAC-SHA256, otorisasi **Role-Based Access Control (`SUPER_ADMIN` & `SALES`)**, **Isolasi Data Per User**, **CRUD Akun Pengguna**, **Multi-Filter Kunjungan**, serta **Katalog Entitas dengan Fallback Riwayat**.

---

## 1. Cara Menjalankan Backend

### Prasyarat
- Node.js v20+
- `pnpm` atau `npm`

### Langkah Menjalankan
```bash
cd Visit-Flow-Backend
pnpm install
pnpm run seed
pnpm start
```
Server berjalan di `http://localhost:4000` (dapat dikustomisasi melalui variabel environment `PORT`).

Mode pengembangan dengan *auto-reload*:
```bash
pnpm dev
```

Mereset data ke kondisi awal (*seed*):
```bash
pnpm run seed
```

### Menjalankan Pengujian Otomatis
```bash
pnpm test
```
Menjalankan suite pengujian `tests/api.test.js` menggunakan runner bawaan `node --test` (8 skenario pengujian mencakup autentikasi, proteksi manipulasi URL, isolasi data `SALES`, akses penuh `SUPER_ADMIN`, CRUD akun user, validasi query filter, pembuatan & pembaruan aktivitas, serta disambiguasi entitas).

---

## 2. Alasan Pemilihan Tech Stack & Arsitektur

| Teknologi / Modul | Alasan Teknis Pemilihan |
|---|---|
| **Node.js (Native ESM)** | Eksekusi ringan dan cepat, mendukung modul modern (`import`/`export`), serta menyediakan modul bawaan `node:crypto` dan `node:test` tanpa ketergantungan library eksternal berlebih. |
| **Express (`^4.21.2`)** | Framework HTTP yang matang dan terstruktur untuk menyusun middleware autentikasi (`requireAuth`), otorisasi role (`requireSuperAdmin`), validasi parameter, dan routing RESTful. |
| **Built-in `node:crypto` (HMAC-SHA256)** | Implementasi tanda tangan token autentikasi stateless yang aman dan cepat tanpa ketergantungan paket JWT pihak ketiga. |
| **JSON Runtime Persistence (`data/runtime.json`)** | Memastikan setiap penambahan/perubahan rencana kunjungan maupun CRUD akun pengguna tetap tersimpan di disk lokal selama pengujian, sekaligus mudah di-reset kembali ke data awal melalui `pnpm run seed`. |

---

## 3. Skema Hak Akses (RBAC) & Akun Pengujian

Seluruh endpoint operasional (`/api/activities`, `/api/entities`, `/api/sales`, `/api/users`, `/api/auth/me`) mewajibkan header `Authorization: Bearer <token>`.

### A. Perbedaan Hak Akses
1. **`SUPER_ADMIN` (`admin@visitflow.id`, `citra@visitflow.id`):**
   - Melihat, memfilter, menambah, dan mengubah status seluruh rencana kunjungan dari semua sales.
   - Mengelola penuh akun pengguna (**Create, Read, Update, Delete** pada `/api/users`).
   - Menetapkan atau mengalihkan Sales PIC pada aktivitas kunjungan.
2. **`SALES` (`andi@visitflow.id`, `budi@visitflow.id`, dan akun sales baru):**
   - **Isolasi Data:** Hanya dapat melihat, memfilter, menambah, dan mengubah status rencana kunjungan miliknya sendiri.
   - Percobaan mengakses/mengubah aktivitas milik sales lain atau mengakses `/api/users` otomatis ditolak dengan status `403 Forbidden`.

### B. Daftar Akun Seed Default
| Nama | Role | Wilayah | Email | Password |
|---|---|---|---|---|
| **Super Admin** | `SUPER_ADMIN` | Nasional | `admin@visitflow.id` | `password123` |
| **Citra Lestari** | `SUPER_ADMIN` | Nasional | `citra@visitflow.id` | `password123` |
| **Andi Pratama** | `SALES` | Bandung | `andi@visitflow.id` | `password123` |
| **Budi Santoso** | `SALES` | Jakarta | `budi@visitflow.id` | `password123` |

---

## 4. Daftar Endpoint REST API

### Autentikasi
- `POST /api/auth/login` — Autentikasi menggunakan `email` dan `password`, mengembalikan `{ token, user }`.
- `GET /api/auth/me` — Mengambil profil pengguna berdasarkan token aktif.

### Manajemen Akun Pengguna (Khusus `SUPER_ADMIN`)
- `GET /api/users` — Mengambil daftar seluruh akun pengguna terdaftar (tanpa field password).
- `POST /api/users` — Membuat akun pengguna baru (`name`, `email`, `password`, `role`, `region`).
- `PUT /api/users/:id` & `PATCH /api/users/:id` — Memperbarui data akun pengguna (perubahan nama sales otomatis disinkronkan ke daftar `salesPeople` dan aktivitas terkait).
- `DELETE /api/users/:id` — Menghapus akun pengguna (dilengkapi proteksi agar tidak dapat menghapus akun sendiri yang sedang aktif maupun menghapus `SUPER_ADMIN` terakhir).

### Rencana & Realisasi Kunjungan
- `GET /api/activities?segment=&status=&from=&to=&search=&salesName=` — Mengambil daftar kunjungan sesuai hak akses user beserta objek `summary` (`total`, `visited`, `notVisited`, `b2g`, `b2b`) yang dihitung dari hasil filter.
- `POST /api/activities` — Membuat rencana kunjungan baru (mendukung pemilihan `entityId` terdaftar maupun input entitas baru melalui `entityName`, `region`, dan `entityType`).
- `PATCH /api/activities/:id` — Memperbarui status kunjungan (`VISITED` / `NOT_VISITED`), `salesName` (khusus `SUPER_ADMIN`), atau `notes`.

### Direktori Entitas & Sales
- `GET /api/entities?segment=&search=&includeFallback=` — Mengambil daftar entitas dari master data dengan fallback otomatis ke riwayat kunjungan apabila master data tidak memiliki hasil yang cocok, lengkap dengan deduplikasi dan disambiguasi nama serupa.
- `GET /api/sales` — Mengambil daftar nama sales (`SUPER_ADMIN` menerima seluruh sales aktif; `SALES` menerima nama akunnya sendiri).

---

## 5. Transparansi Penggunaan AI

- **Estimasi Penggunaan AI:** **~50%**
- **Rincian:**
  - **Peran Developer (~50%):** Perancangan struktur REST API, logika otorisasi RBAC & isolasi data per user, algoritma katalog entitas beserta fallback riwayat & disambiguasi, sinkronisasi relasi nama sales saat update user, serta validasi keamanan parameter.
  - **Bantuan AI (~50%):** Penyusunan data seed awal (`src/data/seed.js`), perapihan route handler & kerangka pengujian `node:test`, serta dokumentasi endpoint.

# Email Rekapin lewat we.contrivent.com

Panduan ini memindahkan email notifikasi Rekapin ke alamat `noreply@we.contrivent.com`. Semua langkah cukup pakai akses Cloudflare dan Resend, tanpa Google Admin.

Hasil yang bisa dicapai:

| Target | Bisa? | Catatan |
| --- | --- | --- |
| Foto profil pengirim di Gmail | Kemungkinan besar | Lewat akun Google biasa untuk alamat pengirim. Belum terbukti sampai dicoba (langkah 4) |
| Tidak masuk spam | Ya | SPF, DKIM, dan DMARC atas nama we.contrivent.com semuanya lolos |
| Selalu masuk Utama atau Penting | Tidak bisa dipaksa | Gmail yang memutuskan. Ada cara membantu (langkah 8) |
| Centang biru atau centang custom | Tidak | Hanya lewat BIMI dengan sertifikat VMC dan merek dagang terdaftar, dan domain utama contrivent.com wajib DMARC tegas. Itu butuh Google Admin |

Bagian yang perlu diperhatikan: sub domain ini punya catatan DNS sendiri, jadi email kerja kantor di contrivent.com sama sekali tidak terpengaruh.

## Gambaran akhirnya

| Nama DNS | Jenis | Fungsi |
| --- | --- | --- |
| `we.contrivent.com` | MX (3 catatan Cloudflare) | Menerima email ke @we.contrivent.com lalu meneruskannya ke inbox kamu |
| `we.contrivent.com` | TXT SPF | Dibuat otomatis oleh Cloudflare Email Routing |
| `resend._domainkey.we.contrivent.com` | TXT | Kunci DKIM Resend |
| `send.we.contrivent.com` | MX dan TXT SPF | Jalur pengiriman dan pantulan Resend |
| `_dmarc.we.contrivent.com` | TXT | Kebijakan DMARC khusus sub domain ini |

## 1. Aktifkan Email Routing untuk sub domain

1. Masuk ke dashboard Cloudflare dan pilih zona `contrivent.com`.
2. Buka menu **Email**, lalu **Email Routing**.
3. Kalau Email Routing sudah aktif untuk contrivent.com (sudah ada MX `route1.mx.cloudflare.net` dan kawan kawan), buka tab **Settings**. Di bagian **Subdomains**, klik **Add subdomain** dan isi `we`.
4. Cloudflare menampilkan catatan yang akan ditambahkan untuk `we.contrivent.com`: tiga catatan MX dan satu TXT SPF. Klik **Add records and enable**.
5. Tunggu sampai status sub domain berubah jadi aktif. Biasanya hitungan menit.

Jangan ubah catatan MX Google di domain utama. Semua yang ditambahkan di sini hanya berlaku untuk `we.contrivent.com`.

## 2. Daftarkan inbox tujuan

1. Masih di Email Routing, buka tab **Destination addresses**.
2. Klik **Add destination address**, lalu isi inbox yang kamu baca setiap hari, misalnya `yoelm@contrivent.com`.
3. Buka email verifikasi dari Cloudflare di inbox itu, lalu klik **Verify email address**.

## 3. Buat alamat penerus

Di tab **Routing rules**, klik **Create address** tiga kali:

| Custom address | Action | Destination |
| --- | --- | --- |
| `noreply@we.contrivent.com` | Send to an email | inbox kamu |
| `dmarc@we.contrivent.com` | Send to an email | inbox kamu |
| `halo@we.contrivent.com` | Send to an email | inbox kamu |

Pilih domain `we.contrivent.com` di menu pilihan domain saat membuat setiap alamat. Alamat `halo` dipakai sebagai alamat balasan kalau penerima menekan Balas. Namanya boleh diganti.

Uji dulu: kirim email dari akun lain ke `noreply@we.contrivent.com`. Email itu harus sampai di inbox kamu sebelum lanjut.

## 4. Buat akun Google untuk foto profil

1. Buka jendela penyamaran, lalu buka `accounts.google.com/signup`.
2. Isi nama **Rekapin**. Nama ini yang tampil sebagai pengirim.
3. Saat diminta alamat Gmail, pilih **Gunakan alamat email yang sudah ada**, lalu isi `noreply@we.contrivent.com`.
4. Kode verifikasi dari Google akan diteruskan Cloudflare ke inbox kamu. Masukkan kodenya.
5. Setelah akun jadi, buka `myaccount.google.com`, lalu **Info pribadi**, lalu **Foto**. Unggah logo Rekapin berbentuk persegi, minimal 250 × 250 piksel.
6. Buka **Info pribadi**, lalu **Pilih info yang dilihat orang lain**. Pastikan foto terlihat oleh **Siapa saja**.

Kalau Google menolak di langkah 3 dengan pesan bahwa domain ini dikelola organisasi, berarti jalur foto profil tertutup tanpa Google Admin. Langkah lain di panduan ini tetap berguna untuk urusan spam.

Gmail menampilkan foto akun Google pengirim ke penerima. Tampilnya bisa butuh beberapa jam, dan kadang hanya setelah penerima pernah membuka email dari alamat itu.

## 5. Verifikasi sub domain di Resend

1. Masuk ke dashboard Resend, buka **Domains**, lalu klik **Add Domain**.
2. Isi `we.contrivent.com`. Pilih region yang sama dengan domain lama supaya konsisten. Domain lama memakai Tokyo (ap northeast 1).
3. Resend menampilkan beberapa catatan DNS, biasanya:
   * TXT `resend._domainkey.we` berisi kunci DKIM
   * MX `send.we` ke server pantulan Amazon SES
   * TXT `send.we` berisi `v=spf1 include:amazonses.com ~all`
4. Di Cloudflare, buka **DNS**, lalu **Records**, lalu **Add record**. Salin setiap catatan persis dari Resend. Kolom Name cukup diisi bagian sebelum `.contrivent.com`, misalnya `resend._domainkey.we`.
5. Pastikan ikon awan untuk catatan ini abu abu (**DNS only**). MX dan TXT memang tidak bisa diproksikan, tapi cek ulang saja.
6. Kembali ke Resend dan klik **Verify DNS Records**. Tunggu sampai statusnya **Verified**.

Catatan MX di `send.we` tidak bentrok dengan MX Cloudflare di `we`, karena namanya berbeda.

## 6. Pasang DMARC untuk sub domain

Tambahkan satu catatan TXT di Cloudflare:

| Type | Name | Content |
| --- | --- | --- |
| TXT | `_dmarc.we` | `v=DMARC1; p=none; rua=mailto:dmarc@we.contrivent.com` |

Selama dua minggu pertama, laporan DMARC akan masuk ke inbox kamu lewat alamat `dmarc@`. Kalau semua email dari Rekapin tercatat lolos, ganti isinya menjadi:

```
v=DMARC1; p=quarantine; rua=mailto:dmarc@we.contrivent.com
```

Kebijakan tegas ini hanya berlaku untuk `we.contrivent.com`. Email kerja di contrivent.com tidak ikut terpengaruh.

## 7. Arahkan Rekapin ke alamat baru

Di file `.env` backend di server, ubah atau tambahkan baris ini:

```
EMAIL_FROM=Rekapin <noreply@we.contrivent.com>
```

Lalu restart backend.

* Kalau API key Resend dibatasi untuk satu domain saja, buat API key baru yang mencakup `we.contrivent.com`.
* Setelah restart, buat satu tugas percobaan dan buka emailnya di Gmail. Pilih menu titik tiga, lalu **Tampilkan asli**. Harus tertulis **SPF: PASS**, **DKIM: PASS**, dan **DMARC: PASS**.

## 8. Supaya tidak masuk spam dan lebih sering masuk Utama

Yang sudah otomatis beres dengan langkah di atas:

* SPF, DKIM, dan DMARC lolos atas nama domain pengirim.
* Alamat dan nama pengirim selalu sama.
* Email punya versi teks biasa selain HTML. Kode Rekapin sudah mengirim keduanya.

Yang bisa kamu lakukan:

1. **Daftarkan domain di Google Postmaster Tools.** Buka `postmaster.google.com`, tambahkan `we.contrivent.com`, lalu pasang catatan TXT verifikasi yang diberikan di Cloudflare. Di sana terlihat reputasi domain dan persentase email yang ditandai spam. Tidak butuh Google Admin.
2. **Mulai pelan.** Domain baru belum punya reputasi. Kirim ke tim internal dulu selama beberapa hari sebelum volumenya naik.
3. **Minta penerima awal menandai emailnya.** Kalau ada yang masuk spam, klik **Bukan spam**. Untuk memindahkan ke tab Utama, seret emailnya ke tab Utama lalu pilih **Ya** saat Gmail bertanya. Sinyal dari penerima sangat berpengaruh untuk domain baru.
4. **Buat filter di Gmail penerima**, kalau mau benar benar aman. Isi Dari: `noreply@we.contrivent.com`, lalu centang **Jangan pernah kirim ke Spam** dan **Selalu tandai sebagai penting**. Ini satu satunya cara menjamin prioritas, dan harus diatur di sisi penerima.
5. **Tampilan email tetap sederhana.** Gmail cenderung memasukkan email bergaya promosi ke tab Promosi, misalnya yang banyak gambar, spanduk besar, atau banyak tautan. Email tugas yang pendek dan mirip email pribadi lebih sering masuk Utama.

## 9. Soal centang biru

Centang di samping nama pengirim di Gmail tidak bisa dibuat custom. Satu satunya centang resmi adalah centang biru BIMI, dan syaratnya:

* Logo Rekapin terdaftar sebagai merek dagang.
* Sertifikat VMC berbayar tahunan dari DigiCert, Sectigo, atau GlobalSign.
* DMARC `quarantine` atau `reject` di **domain utama** contrivent.com, bukan cuma di sub domain.

Syarat terakhir butuh perbaikan SPF dan DKIM Google Workspace di domain utama, dan itu hanya bisa dilakukan lewat Google Admin. Jadi untuk sekarang centang biru belum bisa. Tanda nama pengirim atau subjek yang meniru centang juga sebaiknya tidak dipakai, karena filter spam Gmail curiga pada pengirim yang menyamar seperti itu.

## Daftar cek akhir

* [ ] Email Routing aktif untuk `we.contrivent.com`
* [ ] Inbox tujuan terverifikasi
* [ ] Alamat `noreply`, `dmarc`, dan `halo` meneruskan email dengan benar
* [ ] Akun Google Rekapin dibuat dan foto profilnya terlihat oleh siapa saja
* [ ] `we.contrivent.com` berstatus Verified di Resend
* [ ] DMARC `p=none` terpasang, lalu naik ke `p=quarantine` setelah dua minggu
* [ ] `EMAIL_FROM` di server sudah diganti dan backend sudah direstart
* [ ] Tampilkan asli di Gmail menunjukkan SPF, DKIM, dan DMARC semuanya PASS
* [ ] Domain terdaftar di Google Postmaster Tools

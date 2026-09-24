# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Karyawan piranusa.com dan contrivent.com yang ikut rapat di Google Meet, Zoom, Microsoft Teams, atau panggilan WhatsApp. Pemilik rekaman merekam lewat extension Chrome, lalu anggota rapat menerima tugas hasil rapat. Email tugas juga bisa sampai ke pihak luar lewat CC, misalnya klien atau mitra.

Email tugas dibaca di Gmail, baik di ponsel sesaat setelah rapat maupun di laptop saat jam kerja.

## Product Purpose

Rekapin merekam rapat, menulis transkripnya dengan nama tiap pembicara, lalu membuat ringkasan dan tugas otomatis. Tugas dikirim ke orang yang ditugaskan. Keberhasilannya: setelah rapat selesai, tiap orang tahu apa yang harus dikerjakan tanpa perlu membuka rekaman.

## Positioning

Transkrip memakai nama asli peserta langsung dari aplikasi rapatnya, dan tugas dikirim ke orangnya tanpa ada yang perlu menulis notulen.

## Operating Context

* Extension Chrome dengan side panel yang merekam tab rapat
* Dashboard web di rekapin.contrivent.com: riwayat rapat, halaman hasil rapat (/job/{id}), daftar tugas (/tugas), dan halaman bagikan
* Email tugas dikirim lewat Resend dari noreply@contrivent.com, satu email per penerima, berisi semua tugas dari satu rapat

## Capabilities and Constraints

* Login hanya untuk akun @piranusa.com dan @contrivent.com
* Panggilan WhatsApp bersifat privat: tugas hanya untuk pemilik rekaman, tanpa email
* Judul rapat dibuat otomatis dari isi rapat; kalau belum ada, dipakai tanggal dan jam rapat
* Tombol utama email tugas membuka hasil rapatnya (/job/{id})
* UI dan email tidak boleh menyebut nama penyedia atau sistem di balik transkrip dan ringkasan

## Brand Commitments

* Nama: Rekapin, bagian dari Contrivent ("Rekapin by Contrivent")
* Tanda merek: logo telinga hitam (frontend/public/logo.png dan logo.svg), dipakai sama di website, extension, dan email
* Bahasa Indonesia yang santai dan langsung, menyapa pembaca dengan "kamu"
* Tanpa tanda pisah atau tanda hubung di teks yang dibaca pengguna

## Evidence on Hand

* Logo: frontend/public/logo.png, frontend/public/logo.svg
* Belum ada testimoni, angka pengguna, atau studi kasus. Jangan dibuat buat

## Product Principles

1. Setelah rapat, tugas yang jelas lebih penting daripada tampilan yang ramai
2. Nama orang harus benar; lebih baik menulis "Pembicara 1" daripada menebak nama
3. Rekaman pengguna tidak boleh hilang; setiap kegagalan harus punya jalan pulih
4. Bahasa produk menjelaskan apa yang terjadi dan apa langkah berikutnya, tanpa istilah teknis

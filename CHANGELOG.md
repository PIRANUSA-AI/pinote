# Catatan rilis Rekapin

Tulis rilis terbaru paling atas. Setiap rilis diawali baris `## versi · tanggal`, lalu setiap perubahan diawali `* `.

## 0.16.0 · 24 September 2026
* Tanya rapat ini: ajukan pertanyaan tentang rapat di halaman hasilnya, jawabannya disertai kutipan yang bisa diklik untuk melompat ke bagian transkrip dan audionya
* Bagikan transkrip langsung lewat tautan, supaya rekan bisa mengikuti rapat dari HP tanpa login. Tautan tertutup otomatis saat rapat selesai
* Tenggat tugas kini dibaca sebagai tanggal sungguhan, lengkap dengan tanda hari ini, besok, dan lewat tenggat
* Keputusan dan pertanyaan di transkrip ditandai, dan bisa disaring dengan satu klik
* Rangkuman mingguan lewat email setiap Senin pagi: tugas yang lewat tenggat, yang jatuh tempo minggu ini, dan rapat minggu lalu
* Statistik rapat 30 hari di Profil: waktu bicara dan jumlah tugas per orang
* Judul rapat diambil dari nama rapat di Meet, Zoom, dan Teams bila tersedia
* Pintasan keyboard di panel: Spasi untuk jeda, F untuk mode fokus, dan garis miring untuk mencari
* Ringkasan dan tugas tidak lagi hilang kalau server sedang diperbarui saat rapat diproses
* Mendukung rapat Microsoft Teams di browser
* Email tugas didesain ulang: judul rapat yang sebenarnya, tanggal dan jam rapat, daftar tugas yang rapi, dan tombol langsung ke hasil rapat
* Di Zoom web dan Teams web, transkrip langsung diambil dari teks otomatis rapat kalau fitur itu dinyalakan, lengkap dengan pembicaranya, jadi kalimat jauh lebih akurat
* Bahasa Indonesia di Zoom, Teams, dan WhatsApp tidak lagi berubah jadi kata kata asing saat bahasa diset Auto
* Transkrip final setelah rapat mengenali bahasa Indonesia dengan benar saat bahasa diset Auto
* Mode fokus saat merekam. Kecilkan panel atas supaya yang tersisa hanya durasi rapat dan tiga tombol: merah untuk batal, kuning untuk jeda, hijau untuk selesai
* Waktu bicara tiap peserta tampil selama rapat, lengkap dengan durasi dan persentasenya
* Transkrip langsung kini tampil tanpa kotak. Kalimat dari orang yang sama menyambung, dan garis tipis memisahkan tiap pergantian pembicara
* Tugas yang terdengar selama rapat ditandai di transkrip dan dikumpulkan di satu daftar. Klik tugasnya untuk langsung melompat ke kalimat itu
* Ekspor transkrip sebagai Markdown, disalin atau diunduh sebagai file .md, lengkap dengan daftar hadir, waktu bicara, dan tugas
* Kalau Chrome atau extension tertutup di tengah rapat, audio yang sudah terekam tetap tersimpan dan bisa dikirim lewat tombol Kirim rekaman
* Panel lebih ringan saat rapat ramai atau panjang karena pembaruan transkrip dikumpulkan dulu sebelum ditampilkan dan disimpan
* Pesan kesalahan lebih jelas dan langsung menyebut langkah yang perlu kamu lakukan

## 0.10.3 · 23 September 2026
* Memperbarui extension saat tab Meet masih terbuka tidak lagi memunculkan error berulang. Tab lama berhenti dengan rapi sampai dimuat ulang

## 0.10.2 · 23 September 2026
* Di Google Meet, suaramu diambil dari audio yang benar benar dikirim Meet, bukan dari mikrofon laptop. Kalau kamu mute di Meet, suaramu tidak ikut tercatat
* Suara peserta lain yang keluar dari speaker tidak lagi tercatat atas namamu
* Pembacaan audio peserta lebih tahan terhadap berbagai format audio
* Baris diagnostik di panel selama merekam Meet untuk memudahkan pelacakan masalah

## 0.10.1 · 23 September 2026
* Google Meet tidak butuh caption lagi. Suara tiap peserta ditranskrip terpisah dan namanya diambil langsung dari akun Meet masing masing
* Berapa pun jumlah pesertanya, setiap kalimat diberi nama pemilik suaranya, termasuk saat dua orang bicara bersamaan
* Suaramu sendiri tetap dari mikrofon dengan nama akunmu
* Kalimat terakhir sebelum kamu menekan berhenti ikut tersimpan
* Mesin transkrip langsung diperbarui

## 0.9.0 · 22 September 2026
* Tombol Mulai Rekapin kini selalu jalan. Chrome menampilkan dialog pilih tab sekali, lalu perekaman dimulai
* Jalur cepat tanpa dialog: klik kanan di halaman rapat lalu pilih Mulai Rekapin, atau tekan Ctrl+Shift+U
* Rekaman berhenti dan terkirim otomatis kalau tab rapat ditutup atau berbagi tab dihentikan
* Pilihan bahasa tersimpan, jadi tidak perlu diatur ulang setiap kali panel dibuka
* Teks transkrip langsung kini mengalir per kata dan tidak lagi menunggu satu kalimat selesai
* Tiap baris transkrip kini diberi nama. Suara kamu dikenali dari mikrofon, nama peserta lain dibaca dari halaman rapat
* Transkrip final setelah rapat kini memisahkan tiap pembicara
* Kalimat pendek dari pembicara yang sama digabung jadi satu baris, tidak lagi pecah tiap beberapa kata
* Pengiriman rekaman berjalan di latar belakang, jadi kamu bisa langsung merekam rapat berikutnya tanpa menunggu
* Nama pembicara dibaca dari teks otomatis Google Meet, jadi baris transkrip memakai nama asli peserta
* Tombol Batalkan saat merekam, untuk membuang rekaman tanpa mengirimnya
* Pilihan mematikan ringkasan dan tugas otomatis, kalau kamu cuma mau transkripnya saja
* Daftar hadir rapat dibaca dari Google Meet dan ikut tersimpan bersama rekaman
* Kalau rapat cuma berdua, lawan bicara langsung dikenali namanya tanpa perlu teks otomatis
* Transkrip tidak lagi menyelipkan bahasa asing ketika bahasa sudah dipilih
* Transkrip final mencocokkan tiap pembicara hasil pemisahan suara dengan nama asli peserta, berapa pun jumlah pesertanya
* Pesan kesalahan perekaman kini menjelaskan penyebabnya, bukan cuma bilang kosong

## 0.8.0 · 22 September 2026
* Halaman unduh resmi dengan panduan pemasangan langkah demi langkah untuk Chrome dan Edge
* Panel memberi tahu bila ada versi extension yang lebih baru

## 0.7.0 · 22 September 2026
* Transkrip langsung menyambung ulang otomatis saat koneksi putus, sampai 15 kali dengan jeda yang makin panjang
* Rekaman yang gagal terkirim dicoba lagi otomatis dan tidak pernah dibuang sebelum berhasil
* Tombol Kirim ulang dan Buang muncul bila pengiriman masih gagal
* Peningkatan keamanan dan stabilitas

## 0.6.0 · 22 September 2026
* Mendukung panggilan WhatsApp Web
* Panggilan WhatsApp otomatis privat: tugasnya hanya untuk pemilik rekaman, tanpa email, dan tidak bisa dibagikan

## 0.5.0 · 22 September 2026
* Suara kamu sendiri kini ikut terekam dan tertranskrip, bukan hanya suara peserta lain
* Izin mikrofon cukup diberikan sekali

## 0.4.0 · 22 September 2026
* Cari kata atau nama pembicara di transkrip langsung tanpa kehilangan konteks percakapan
* Tombol jeda saat merekam
* Tampilan ringkas saat merekam supaya transkrip mendapat ruang lebih
* Transkrip langsung tersimpan di browser sebagai cadangan

## 0.3.0 · 22 September 2026
* Transkrip tanpa batas untuk semua akun
* Mendukung 27 bahasa termasuk Mandarin, dengan deteksi bahasa otomatis

## 0.2.0 · 22 September 2026
* Rekapin kini terbuka di panel samping, tidak lagi di popup
* Tampilan baru dengan font Plus Jakarta Sans
* Alamat baru rekapin.contrivent.com

## 0.1.0 · 22 September 2026
* Rilis pertama: transkrip langsung untuk Google Meet dan Zoom web

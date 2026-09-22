import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  ArrowLeft,
  ArrowsClockwise,
  Check,
  Copy,
  DownloadSimple,
  FolderOpen,
  Info,
  PushPin,
  ShieldCheck,
  ToggleRight,
  UploadSimple,
} from '@phosphor-icons/react'
import changelogRaw from '../../../CHANGELOG.md?raw'
import { BrandMark } from '../components/Brand'
import { formatBytes } from '../lib/format'

interface Release {
  version: string
  date: string
  items: string[]
}

interface PackageFile {
  url: string
  size: number
}

interface LatestPackage {
  version: string
  extensionId: string
  zip: PackageFile
  crx: PackageFile | null
  builtAt: string
}

type LoadState = 'loading' | 'error' | 'empty' | 'ready'
type Browser = 'chrome' | 'edge'

function parseChangelog(raw: string): Release[] {
  const releases: Release[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      const [version, date] = line.slice(3).split(' · ')
      releases.push({ version: (version ?? '').trim(), date: (date ?? '').trim(), items: [] })
    } else if (line.startsWith('* ') && releases.length > 0) {
      releases[releases.length - 1].items.push(line.slice(2).trim())
    }
  }
  return releases
}

const BROWSERS: Record<Browser, { label: string; page: string; toggleWhere: string; loadLabel: string }> = {
  chrome: {
    label: 'Chrome',
    page: 'chrome://extensions',
    toggleWhere: 'di pojok kanan atas',
    loadLabel: 'Muat yang belum dibuka (Load unpacked)',
  },
  edge: {
    label: 'Edge',
    page: 'edge://extensions',
    toggleWhere: 'di panel sebelah kiri',
    loadLabel: 'Muat yang belum dikemas (Load unpacked)',
  },
}

export default function Extension() {
  const location = useLocation()
  const navigate = useNavigate()
  const releases = useMemo(() => parseChangelog(changelogRaw), [])
  const [latest, setLatest] = useState<LatestPackage | null>(null)
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [browser, setBrowser] = useState<Browser>('chrome')
  const [copied, setCopied] = useState(false)
  const [downloaded, setDownloaded] = useState(false)
  const tutorialRef = useRef<HTMLElement | null>(null)
  const changelogRef = useRef<HTMLElement | null>(null)
  const isMobile = typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)

  const loadLatest = async () => {
    setLoadState('loading')
    try {
      const response = await fetch(`/downloads/latest.json?t=${Date.now()}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(8000),
      })
      if (response.status === 404) {
        setLoadState('empty')
        return
      }
      if (!response.ok) throw new Error(String(response.status))
      const data = (await response.json()) as LatestPackage
      if (!data?.zip?.url) {
        setLoadState('empty')
        return
      }
      setLatest(data)
      setLoadState('ready')
    } catch {
      setLoadState('error')
    }
  }

  useEffect(() => {
    void loadLatest()
  }, [])

  useEffect(() => {
    if (location.pathname === '/changelog') {
      changelogRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [location.pathname])

  const handleBack = () => {
    if (location.key !== 'default') navigate(-1)
    else navigate('/', { replace: true })
  }

  const handleDownload = () => {
    setDownloaded(true)
    setTimeout(() => tutorialRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 250)
  }

  const handleCopy = async () => {
    await navigator.clipboard.writeText(BROWSERS[browser].page)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  const current = BROWSERS[browser]
  const steps = [
    {
      icon: FolderOpen,
      title: 'Ekstrak ZIP ke folder tetap',
      body: 'Klik kanan file yang terunduh, pilih Ekstrak Semua, lalu simpan ke folder yang tidak akan kamu hapus, misalnya Dokumen\\Rekapin. Hindari folder Unduhan karena sering dibersihkan.',
    },
    {
      icon: Copy,
      title: `Buka halaman extension ${current.label}`,
      body: 'Browser tidak mengizinkan halaman web membuka alamat ini langsung, jadi salin lalu tempel di address bar.',
      action: 'copy' as const,
    },
    {
      icon: ToggleRight,
      title: 'Nyalakan Mode pengembang',
      body: `Tombolnya ada ${current.toggleWhere}. Label Inggrisnya Developer mode.`,
    },
    {
      icon: UploadSimple,
      title: `Klik ${current.loadLabel}`,
      body: 'Pilih folder hasil ekstrak tadi, yaitu folder yang berisi file manifest.json. Kartu Rekapin Meeting Recorder akan muncul.',
    },
    {
      icon: PushPin,
      title: 'Sematkan lalu masuk',
      body: 'Klik ikon kepingan puzzle di toolbar, sematkan Rekapin, lalu klik ikonnya. Panel samping terbuka dan kamu tinggal masuk dengan Google.',
    },
  ]

  return (
    <div className="min-h-[100dvh] bg-paper aurora relative overflow-hidden">
      <div className="absolute inset-0 grid-pattern opacity-50 pointer-events-none" />

      <div className="relative mx-auto w-full max-w-2xl px-5 pt-12 pb-[calc(6.5rem+env(safe-area-inset-bottom))] md:pt-16 md:pb-32">
        <button
          onClick={handleBack}
          className="mb-8 flex w-fit items-center gap-1.5 text-xs font-medium text-slate-400 transition-colors hover:text-navy"
        >
          <ArrowLeft size={12} weight="bold" />
          Kembali ke Rekapin
        </button>

        <motion.header
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 120, damping: 20 }}
          className="flex flex-col items-start"
        >
          <BrandMark size={52} />
          <p className="mt-5 text-[11px] font-semibold uppercase tracking-[0.16em] text-brand-deep">
            Rekapin untuk Chrome dan Edge
          </p>
          <h1 className="mt-2 text-3xl md:text-4xl tracking-tightest leading-[1.05] font-semibold text-navy">
            Transkrip rapat langsung di samping tab kamu
          </h1>
          <p className="mt-3 max-w-[52ch] text-[14px] leading-relaxed text-ink-muted">
            Rekam dan tulis otomatis rapat Google Meet, Zoom web, dan panggilan WhatsApp Web. Hasilnya masuk ke akun
            Rekapin kamu lengkap dengan ringkasan dan tugas.
          </p>
        </motion.header>

        {isMobile && (
          <div className="mt-6 flex gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] leading-relaxed text-amber-800">
            <Info size={18} weight="bold" className="mt-0.5 flex-shrink-0" />
            Extension hanya berjalan di Chrome atau Edge versi komputer. Buka halaman ini dari laptop kamu.
          </div>
        )}

        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 120, damping: 20, delay: 0.06 }}
          className="card mt-8 p-5 md:p-6"
        >
          {loadState === 'loading' && (
            <div className="space-y-3">
              <div className="skeleton h-5 w-40 rounded-lg" />
              <div className="skeleton h-11 w-full rounded-full" />
            </div>
          )}

          {loadState === 'error' && (
            <div className="flex flex-col items-start gap-3">
              <p className="text-[14px] text-ink-muted">Info versi terbaru belum bisa dimuat. Periksa koneksi kamu.</p>
              <button onClick={() => void loadLatest()} className="btn-ghost border border-slate-200 px-4 py-2 text-sm">
                <ArrowsClockwise size={15} weight="bold" />
                Coba lagi
              </button>
            </div>
          )}

          {loadState === 'empty' && (
            <p className="text-[14px] text-ink-muted">
              Paket extension belum tersedia. Paket dibuat otomatis setiap kali ada pembaruan, coba lagi sebentar lagi.
            </p>
          )}

          {loadState === 'ready' && latest && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">Versi terbaru</p>
                  <p className="mt-0.5 text-2xl font-semibold tabular text-navy">{latest.version}</p>
                </div>
                <span className="chip bg-emerald-50 text-emerald-700">
                  <ShieldCheck size={12} weight="bold" />
                  Ditandatangani Contrivent
                </span>
              </div>

              <a
                href={latest.zip.url}
                download
                onClick={handleDownload}
                className="btn-primary w-full justify-center gap-2 py-3 text-[15px]"
              >
                <DownloadSimple size={18} weight="bold" />
                Unduh extension ({formatBytes(latest.zip.size)})
              </a>

              {downloaded && (
                <p className="rounded-xl bg-brand-soft px-4 py-2.5 text-[13px] text-brand-deep">
                  Unduhan dimulai. Ikuti lima langkah di bawah untuk memasangnya.
                </p>
              )}

              {latest.crx && (
                <p className="text-[12.5px] leading-relaxed text-ink-muted">
                  Untuk admin IT yang memasang lewat kebijakan perusahaan tersedia{' '}
                  <a href={latest.crx.url} download className="font-semibold text-brand-deep hover:underline">
                    file CRX
                  </a>
                  . Chrome di Windows dan Mac menolak CRX yang diseret langsung, jadi untuk pemakaian pribadi gunakan
                  tombol di atas.
                </p>
              )}
            </div>
          )}
        </motion.section>

        <section ref={tutorialRef} className="mt-12 scroll-mt-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="eyebrow">Cara memasang</p>
              <h2 className="mt-1 text-xl font-semibold tracking-tight text-navy">Lima langkah, sekali saja</h2>
            </div>
            <div className="inline-flex rounded-full border border-slate-200 bg-white p-1">
              {(Object.keys(BROWSERS) as Browser[]).map((key) => (
                <button
                  key={key}
                  onClick={() => setBrowser(key)}
                  className={`rounded-full px-4 py-1.5 text-[13px] font-semibold transition-colors ${
                    browser === key ? 'bg-navy text-white' : 'text-ink-muted hover:text-navy'
                  }`}
                >
                  {BROWSERS[key].label}
                </button>
              ))}
            </div>
          </div>

          <ol className="mt-5 space-y-3">
            {steps.map((step, index) => {
              const Icon = step.icon
              return (
                <motion.li
                  key={`${browser}${index}`}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.04 }}
                  className={`card flex gap-4 p-4 ${downloaded && index === 0 ? 'ring-2 ring-brand/40' : ''}`}
                >
                  <div className="flex flex-col items-center">
                    <span className="grid h-8 w-8 place-items-center rounded-full bg-navy text-[13px] font-semibold text-white tabular">
                      {index + 1}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 font-semibold text-navy">
                      <Icon size={16} weight="bold" className="text-brand" />
                      {step.title}
                    </p>
                    <p className="mt-1 text-[13.5px] leading-relaxed text-ink-muted">{step.body}</p>
                    {step.action === 'copy' && (
                      <button
                        onClick={() => void handleCopy()}
                        className="mt-3 inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-[13px] text-navy transition-colors hover:bg-white"
                      >
                        {current.page}
                        {copied ? (
                          <Check size={14} weight="bold" className="text-emerald-600" />
                        ) : (
                          <Copy size={14} weight="bold" className="text-slate-400" />
                        )}
                      </button>
                    )}
                  </div>
                </motion.li>
              )
            })}
          </ol>

          <div className="card mt-5 flex gap-3 p-4">
            <ArrowsClockwise size={18} weight="bold" className="mt-0.5 flex-shrink-0 text-brand" />
            <div>
              <p className="font-semibold text-navy">Cara memperbarui</p>
              <p className="mt-1 text-[13.5px] leading-relaxed text-ink-muted">
                Panel Rekapin akan memberi tahu bila ada versi baru. Unduh ZIP terbaru, ekstrak dan timpa isi folder yang
                sama, lalu klik ikon muat ulang di kartu Rekapin pada halaman extension. Tidak perlu memasang dari awal.
              </p>
            </div>
          </div>
        </section>

        <section ref={changelogRef} className="mt-14 scroll-mt-6">
          <p className="eyebrow">Catatan rilis</p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight text-navy">Apa yang baru</h2>

          {releases.length === 0 ? (
            <p className="mt-4 text-[14px] text-ink-muted">Belum ada catatan rilis.</p>
          ) : (
            <div className="mt-5 space-y-6">
              {releases.map((release, index) => (
                <article key={release.version} className="relative border-l-2 border-slate-200 pl-5">
                  <span
                    className={`absolute -left-[7px] top-1.5 h-3 w-3 rounded-full ${
                      index === 0 ? 'bg-brand' : 'bg-slate-300'
                    }`}
                  />
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <h3 className="text-[15px] font-semibold tabular text-navy">Versi {release.version}</h3>
                    {release.date && <span className="text-[12px] text-slate-400">{release.date}</span>}
                    {index === 0 && <span className="chip bg-brand-soft text-brand-deep">Terbaru</span>}
                  </div>
                  <ul className="mt-2 space-y-1.5">
                    {release.items.map((item) => (
                      <li key={item} className="flex gap-2 text-[13.5px] leading-relaxed text-ink-muted">
                        <span className="mt-[9px] h-1 w-1 flex-shrink-0 rounded-full bg-slate-300" />
                        {item}
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

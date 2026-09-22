import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion, useReducedMotion } from 'framer-motion'
import { ArrowRight, ClockCounterClockwise, PuzzlePiece } from '@phosphor-icons/react'

interface LatestExtension {
  version: string
  builtAt: string
}

const FRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

function useLatestExtension(): LatestExtension | null {
  const [latest, setLatest] = useState<LatestExtension | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    fetch(`/downloads/latest.json?t=${Date.now()}`, { cache: 'no-store', signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (data?.version) setLatest({ version: data.version, builtAt: data.builtAt })
      })
      .catch(() => {})
      .finally(() => clearTimeout(timer))
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [])

  return latest
}

function isFresh(latest: LatestExtension | null): boolean {
  if (!latest?.builtAt) return false
  const built = Date.parse(latest.builtAt)
  return Number.isFinite(built) && Date.now() - built < FRESH_WINDOW_MS
}

export function ExtensionPill() {
  const latest = useLatestExtension()
  const reduce = useReducedMotion()

  return (
    <motion.div
      initial={{ opacity: 0, y: -10, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: 'spring', stiffness: 260, damping: 22, delay: 0.35 }}
    >
      <Link
        to="/extension"
        className="group relative inline-flex items-center gap-2 overflow-hidden rounded-full border border-white/70 bg-white/75 py-1.5 pl-1.5 pr-3.5 text-xs font-semibold text-navy shadow-card backdrop-blur-xl transition-colors hover:bg-white"
      >
        {!reduce && (
          <motion.span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 w-16 bg-gradient-to-r from-transparent via-white to-transparent opacity-80"
            initial={{ x: '-120%' }}
            animate={{ x: '520%' }}
            transition={{ duration: 1.4, ease: 'easeInOut', repeat: Infinity, repeatDelay: 4.5 }}
          />
        )}
        <span className="relative grid h-6 w-6 place-items-center rounded-full bg-navy text-white">
          <PuzzlePiece size={13} weight="fill" />
        </span>
        <span className="relative">Pasang Rekapin di Chrome</span>
        {latest && (
          <span className="relative rounded-full bg-brand-soft px-1.5 py-0.5 text-[10px] tabular text-brand-deep">
            {isFresh(latest) ? `Baru v${latest.version}` : `v${latest.version}`}
          </span>
        )}
        <ArrowRight size={12} weight="bold" className="relative transition-transform group-hover:translate-x-0.5" />
      </Link>
    </motion.div>
  )
}

const WAVE = [0.35, 0.7, 0.5, 0.95, 0.6, 0.8, 0.4, 0.65, 0.3]

function WaveMotif() {
  const reduce = useReducedMotion()
  return (
    <div aria-hidden className="pointer-events-none absolute -right-2 bottom-0 top-0 flex items-center gap-[5px] pr-5 opacity-40">
      {WAVE.map((height, index) => (
        <motion.span
          key={index}
          className="block w-[5px] origin-center rounded-full bg-gradient-to-b from-brand-bright to-brand"
          style={{ height: 64 * height }}
          animate={reduce ? undefined : { scaleY: [1, 0.45, 1.15, 0.7, 1] }}
          transition={{ duration: 2 + (index % 3) * 0.35, repeat: Infinity, ease: 'easeInOut', delay: index * 0.09 }}
        />
      ))}
    </div>
  )
}

export function ExtensionCard() {
  const latest = useLatestExtension()

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 140, damping: 22 }}
      className="relative mb-3 overflow-hidden rounded-2xl bg-navy p-5 text-white shadow-card"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_90%_at_100%_0%,rgba(129,140,248,0.35),transparent_60%)]"
      />
      <WaveMotif />

      <div className="relative">
        <div className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-white/10 text-brand-bright">
            <PuzzlePiece size={15} weight="fill" />
          </span>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/60">Rekapin untuk Chrome dan Edge</p>
          {latest && (
            <span className="ml-auto rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-semibold tabular text-white/80">
              {isFresh(latest) ? `Baru v${latest.version}` : `v${latest.version}`}
            </span>
          )}
        </div>

        <h3 className="mt-3 max-w-[26ch] text-lg font-semibold leading-snug tracking-tight">
          Transkrip rapat langsung di samping tab kamu
        </h3>
        <p className="mt-1.5 max-w-[40ch] text-[13px] leading-relaxed text-white/70">
          Google Meet, Zoom web, dan panggilan WhatsApp Web. Hasilnya otomatis masuk ke akun ini.
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            to="/extension"
            className="inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-2 text-[13px] font-semibold text-navy transition-transform active:scale-[0.98]"
          >
            <PuzzlePiece size={14} weight="bold" />
            Pasang extension
          </Link>
          <Link
            to="/changelog"
            className="inline-flex items-center gap-1.5 rounded-full border border-white/20 px-4 py-2 text-[13px] font-semibold text-white/90 transition-colors hover:bg-white/10"
          >
            <ClockCounterClockwise size={14} weight="bold" />
            Catatan rilis
          </Link>
        </div>
      </div>
    </motion.section>
  )
}

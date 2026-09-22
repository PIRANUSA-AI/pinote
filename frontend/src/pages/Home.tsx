import { useEffect, useRef, useState, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Plus, ArrowClockwise, ArrowRight, MicrophoneStage } from '@phosphor-icons/react'
import { UploadZone, type Lang } from '../components/UploadZone'
import { JobStatus } from '../components/JobStatus'
import { HistoryList } from '../components/HistoryList'
import { useUpload } from '../hooks/useUpload'
import { useJobPolling } from '../hooks/useJobPolling'
import { useAuth } from '../hooks/useAuth'
import { MAX_UPLOAD_MB } from '../lib/limits'

function usePullToRefresh(onRefresh: () => void) {
  const startY = useRef(0)
  const pulling = useRef(false)
  const [pullDist, setPullDist] = useState(0)
  const [refreshing, setRefreshing] = useState(false)

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (window.scrollY > 0) return
    startY.current = e.touches[0].clientY
    pulling.current = true
  }, [])

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (!pulling.current) return
    const dist = Math.max(0, Math.min(80, e.touches[0].clientY - startY.current))
    setPullDist(dist)
  }, [])

  const onTouchEnd = useCallback(async () => {
    if (!pulling.current) return
    pulling.current = false
    if (pullDist >= 60) {
      setRefreshing(true)
      setPullDist(0)
      onRefresh()
      setTimeout(() => setRefreshing(false), 800)
    } else {
      setPullDist(0)
    }
  }, [pullDist, onRefresh])

  return { pullDist, refreshing, onTouchStart, onTouchMove, onTouchEnd }
}

export default function Home() {
  const navigate = useNavigate()
  const { user, refresh } = useAuth()
  const { state, start, reset } = useUpload()
  const { job } = useJobPolling(state.jobId)
  const [historyKey, setHistoryKey] = useState(0)

  const refreshHistory = useCallback(() => setHistoryKey((k) => k + 1), [])
  const { pullDist, refreshing, onTouchStart, onTouchMove, onTouchEnd } = usePullToRefresh(refreshHistory)

  const handleStart = async (file: File, lang: Lang) => {
    try {
      await start(file, lang)
      refresh()
    } catch {
      // already in state.error
    }
  }

  const prevStatusRef = useRef<string | null>(null)
  useEffect(() => {
    if (job && job.status !== prevStatusRef.current) {
      prevStatusRef.current = job.status
      if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
        refresh()
      }
    }
  }, [job, refresh])

  const handleReset = () => {
    reset()
    setHistoryKey((k) => k + 1)
  }

  const handleViewTranscript = () => {
    if (state.jobId) navigate(`/job/${state.jobId}`)
  }

  const scrollToUpload = () => {
    document.getElementById('upload')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  const showHero = state.stage === 'idle'
  const showStatus =
    state.stage === 'creating' ||
    state.stage === 'uploading' ||
    state.stage === 'queued' ||
    state.stage === 'error' ||
    !!job

  const greetingName = user?.displayName ?? user?.username ?? ''

  return (
    <div
      className="min-h-[100dvh] pb-[calc(5.5rem+env(safe-area-inset-bottom))] md:pb-24 bg-paper"
      onTouchStart={showHero ? onTouchStart : undefined}
      onTouchMove={showHero ? onTouchMove : undefined}
      onTouchEnd={showHero ? onTouchEnd : undefined}
    >
      {/* Pull-to-refresh indicator */}
      <AnimatePresence>
        {(pullDist > 0 || refreshing) && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed top-14 inset-x-0 z-20 flex justify-center pointer-events-none"
            style={{ transform: `translateY(${Math.min(pullDist * 0.5, 20)}px)` }}
          >
            <div className="bg-navy text-white rounded-full px-3 py-1.5 flex items-center gap-2 text-xs font-medium shadow-dock">
              <ArrowClockwise
                size={14}
                weight="bold"
                className={refreshing ? 'animate-spin' : ''}
                style={!refreshing ? { transform: `rotate(${pullDist * 3}deg)` } : undefined}
              />
              {refreshing ? 'Memuat ulang…' : pullDist >= 60 ? 'Lepas untuk refresh' : 'Tarik untuk refresh'}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {showHero && (
        <section className="mx-auto max-w-3xl px-4 md:px-8 pt-10 md:pt-16">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: 'spring', stiffness: 100, damping: 22 }}
          >
            <div className="flex items-center justify-between gap-3 mb-5">
              <p className="eyebrow flex items-center gap-1.5">
                <MicrophoneStage size={11} weight="fill" /> Hai, {greetingName}
              </p>
            </div>
            <h1 className="text-4xl sm:text-5xl md:text-6xl tracking-tightest leading-[1] font-semibold text-navy">
              Kamu Rekam.
              <br />
              <span className="text-brand">Saya Ketik.</span>
            </h1>
            <p className="mt-5 text-[15px] sm:text-base text-ink-muted leading-relaxed max-w-[52ch]">
            </p>
          </motion.div>
        </section>
      )}

      {showStatus && (
        <section className="mx-auto max-w-3xl px-4 md:px-8 pt-10 md:pt-16">
          <JobStatus
            upload={state}
            job={job}
            onReset={handleReset}
            onViewTranscript={handleViewTranscript}
          />
        </section>
      )}

      {showHero && (
        <section id="upload" className="mx-auto max-w-3xl px-4 md:px-8 mt-8 md:mt-10">
          <UploadZone onStart={handleStart} disabled={state.stage !== 'idle'} />
        </section>
      )}

      {showHero && (
        <section id="history" className="mx-auto max-w-3xl px-4 md:px-8 mt-12 md:mt-16">
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="text-lg tracking-tight font-semibold text-navy">Transkrip terbaru</h2>
            <Link
              to="/riwayat"
              className="text-xs font-semibold text-brand-deep hover:text-brand flex items-center gap-1"
            >
              Lihat semua <ArrowRight size={11} weight="bold" />
            </Link>
          </div>
          <HistoryList refreshKey={historyKey} limit={3} emptyAction />
        </section>
      )}

      {/* FAB — mobile only, visible when idle */}
      <AnimatePresence>
        {showHero && (
          <motion.button
            key="fab"
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 400, damping: 28 }}
            whileTap={{ scale: 0.92 }}
            onClick={scrollToUpload}
            className="md:hidden fixed right-5 z-40 w-14 h-14 rounded-full bg-brand text-white shadow-dock grid place-items-center"
            style={{ bottom: 'calc(6.5rem + env(safe-area-inset-bottom))' }}
            aria-label="Upload baru"
          >
            <Plus size={24} weight="bold" />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  )
}

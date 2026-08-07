import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowLeft, ArrowClockwise, ShareNetwork, Trash, WarningCircle, XCircle } from '@phosphor-icons/react'
import { ApiError, api, type ActionItem, type JobDetail } from '../lib/api'
import { TranscriptViewer } from '../components/TranscriptViewer'
import { ActionItemsPanel } from '../components/ActionItemsPanel'
import { AudioPlayer } from '../components/AudioPlayer'
import { MiniPlayer } from '../components/MiniPlayer'
import { ConfirmModal } from '../components/ConfirmModal'
import { ShareModal } from '../components/ShareModal'
import { useToast } from '../components/Toast'
import { LoadingScreen } from '../components/LoadingScreen'
import { TitleScrambler } from '../components/TitleScrambler'
import { formatBytes, formatDuration, formatRelativeTime } from '../lib/format'
import { useJobPolling } from '../hooks/useJobPolling'

export default function Job() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [initial, setInitial] = useState<JobDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [audioLoading, setAudioLoading] = useState(false)
  const [audioTime, setAudioTime] = useState(0)
  const [audioPlaying, setAudioPlaying] = useState(false)
  const [audioDuration, setAudioDuration] = useState(0)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const { toast } = useToast()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [delForce, setDelForce] = useState(false)

  useEffect(() => {
    if (!id || initial?.status !== 'completed') return
    setAudioLoading(true)
    api.get<{ url: string }>(`/jobs/${id}/audio`)
      .then((r) => setAudioUrl(r.url))
      .catch(() => {})
      .finally(() => setAudioLoading(false))
  }, [id, initial?.status])

  useEffect(() => {
    if (!id) return
    setError(null)
    api
      .get<JobDetail>(`/jobs/${id}`)
      .then(setInitial)
      .catch((err) => {
        if (err instanceof ApiError) setError(err.message)
        else setError('Gagal memuat job')
      })
  }, [id])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const audio = audioRef.current
      if (!audio) return

      if (e.code === 'Space') {
        e.preventDefault()
        if (audio.paused) audio.play()
        else audio.pause()
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault()
        audio.currentTime = Math.max(0, audio.currentTime - 5)
      } else if (e.code === 'ArrowRight') {
        e.preventDefault()
        audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const summaryPending =
    initial?.status === 'completed' &&
    !(initial.transcript?.summary && initial.transcript.summary.length > 0)
  const isActive =
    summaryPending ||
    initial?.status === 'uploading' ||
    initial?.status === 'queued' ||
    initial?.status === 'transcribing' ||
    initial?.status === 'pending'
  const { job: polled } = useJobPolling(isActive ? (id ?? null) : null)
  const job = polled ?? initial

  const updateActionItems = (next: ActionItem[]) => {
    setInitial((cur) => (cur ? { ...cur, actionItems: next } : cur))
  }

  const renameSpeaker = (speaker: string, name: string) => {
    setInitial((cur) =>
      cur ? { ...cur, speakerNames: { ...(cur.speakerNames ?? {}), [speaker]: name } } : cur
    )
  }

  const handleRetry = async () => {
    if (!id) return
    setRetrying(true)
    try {
      await api.post(`/jobs/${id}/retry`)
      setInitial((cur) => cur ? {
        ...cur,
        status: 'queued',
        error: null,
        transcript: null,
        actionItems: [],
      } : cur)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Gagal mengulang transkrip', 'error')
    } finally {
      setRetrying(false)
    }
  }

  const handleDelete = async (force?: boolean) => {
    if (!id || !job) return
    const isRunning = job.status === 'uploading' || job.status === 'queued' || job.status === 'transcribing' || job.status === 'pending'
    const msg = isRunning
      ? 'Batalkan proses transkrip ini? Job akan dihapus dari riwayat.'
      : 'Hapus transkrip ini dari riwayat? Aksi tidak bisa dibatalkan.'
    if (!force) { setConfirmDelete(true); setDelForce(false); return }

    setDeleting(true)
    try {
      await api.delete(`/jobs/${id}`)
      navigate('/', { replace: true })
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Gagal menghapus', 'error')
      setDeleting(false)
    }
  }

  const handleTokensChange = (next: { shareToken: string | null; shareTokenMom: string | null }) => {
    setInitial((cur) => (cur ? { ...cur, ...next } : cur))
  }

  if (error) {
    return (
      <div className="min-h-[100dvh] grid place-items-center p-6 bg-paper aurora">
        <div className="text-center max-w-sm">
          <WarningCircle weight="duotone" size={48} className="mx-auto text-red-500" />
          <p className="mt-3 font-medium">{error}</p>
          <Link to="/" className="btn-ghost mt-6 inline-flex">
            <ArrowLeft size={16} />
            Kembali
          </Link>
        </div>
      </div>
    )
  }

  if (!job) return <LoadingScreen />

  const isRunning = job.status === 'uploading' || job.status === 'queued' || job.status === 'transcribing' || job.status === 'pending'

  return (
    <div className={`mx-auto w-full max-w-7xl px-4 lg:px-8 pb-[calc(5.5rem+env(safe-area-inset-bottom))] md:pb-12 ${audioPlaying ? 'pt-16' : 'pt-6'}`}>
      <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-navy mb-4">
        <ArrowLeft size={14} />
        Semua transkrip
      </Link>

      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 100, damping: 22 }}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1
              className="text-2xl md:text-3xl tracking-tightest font-semibold leading-tight truncate"
              title={job.filename}
            >
              <TitleScrambler
                from={job.filename}
                to={job.status === 'completed' ? job.title : null}
              />
            </h1>
            <p className="mt-2 text-xs text-ink-muted tabular">
              {[
                formatRelativeTime(job.createdAt),
                job.durationSec ? formatDuration(job.durationSec) : null,
                job.sizeBytes ? formatBytes(job.sizeBytes) : null,
                job.transcript?.speakerCount ? `${job.transcript.speakerCount} pembicara` : null,
              ]
                .filter(Boolean)
                .join(' | ')}
            </p>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={() => setShareOpen(true)}
              className="grid place-items-center w-9 h-9 rounded-lg text-ink-muted hover:text-navy hover:bg-slate-100"
              title="Bagikan"
            >
              <ShareNetwork size={18} />
            </button>
            <button
              onClick={() => handleDelete()}
              disabled={deleting}
              className={`grid place-items-center w-9 h-9 rounded-lg ${
                isRunning
                  ? 'text-slate-400 hover:text-red-600 hover:bg-red-50'
                  : 'text-slate-400 hover:text-red-600 hover:bg-red-50'
              } disabled:opacity-40`}
              title={isRunning ? 'Batalkan & hapus' : 'Hapus'}
            >
              {isRunning ? <XCircle size={20} /> : <Trash size={18} />}
            </button>
          </div>
        </div>
      </motion.div>

      <div className="mt-8">
        {job.status === 'completed' && job.transcript ? (
          <>
            {(!job.transcript.summary || job.transcript.summary.length === 0) && (
              <div className="card p-4 mb-4 flex items-center gap-3 bg-amber-50 border border-amber-200">
                <div className="flex items-end gap-0.5 h-4">
                  {[0, 1, 2].map((i) => (
                    <span key={i} className="w-1 bg-amber-400 rounded-full animate-pulse-ring" style={{ animationDelay: `${i * 120}ms`, height: `${8 + (i % 3) * 4}px` }} />
                  ))}
                </div>
                <p className="text-sm text-amber-800 font-medium">Transkrip udah siap, ringkasan dan tugas masih disiapkan...</p>
              </div>
            )}
            <div className="lg:grid lg:grid-cols-[1fr_380px] xl:grid-cols-[1fr_420px] lg:gap-8">
              <div className="min-w-0">
                {audioUrl && <AudioPlayer src={audioUrl} mimeType={job.mimeType ?? undefined} audioRef={audioRef} onTimeUpdate={setAudioTime} onPlayingChange={setAudioPlaying} onDuration={setAudioDuration} />}
                <TranscriptViewer
                  transcript={job.transcript}
                  filename={job.filename}
                  jobId={job.id}
                  speakerNames={job.speakerNames}
                  onActionItemsChange={updateActionItems}
                  onSpeakerRename={renameSpeaker}
                  audioCurrentTime={audioTime}
                />
              </div>
              <div className="mt-6 lg:mt-0 lg:block space-y-4">
                <div className="lg:sticky lg:top-20">
                  <ActionItemsPanel
                    jobId={job.id}
                    actionItems={job.actionItems}
                    speakerNames={job.speakerNames}
                    onChange={updateActionItems}
                    onSpeakerRename={renameSpeaker}
                  />
                </div>
              </div>
            </div>
          </>
        ) : job.status === 'failed' || job.status === 'cancelled' ? (
          <div className="card p-8 text-center">
            <WarningCircle weight="duotone" size={48} className="mx-auto text-red-500" />
            <h2 className="mt-4 text-lg font-semibold">
              {job.status === 'cancelled' ? 'Transkrip dibatalkan' : 'Transkrip gagal'}
            </h2>
            <p className="mt-2 text-sm text-ink-muted max-w-md mx-auto break-words">
              {job.status === 'cancelled'
                ? 'Job ini dibatalkan dan kredit estimasi dikembalikan.'
                : job.error || 'Terjadi kesalahan tak dikenal.'}
            </p>
            <div className="mt-6 flex items-center justify-center gap-3">
              <button onClick={handleRetry} disabled={retrying} className="btn-primary !text-xs">
                <ArrowClockwise size={14} weight="bold" />
                {retrying ? 'Memproses...' : 'Coba lagi'}
              </button>
              <button onClick={() => handleDelete()} disabled={deleting} className="btn-ghost !text-xs">
                Hapus dari riwayat
              </button>
            </div>
          </div>
        ) : job.status === 'transcribing' && job.transcript?.segments?.length ? (
          <div>
            <div className="card p-4 mb-4 flex items-center gap-3 bg-brand-soft border border-brand/10">
              <div className="flex items-end gap-0.5 h-5">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="w-1 bg-brand rounded-full animate-pulse-ring"
                    style={{
                      animationDelay: `${i * 120}ms`,
                      height: `${10 + (i % 3) * 6}px`,
                    }}
                  />
                ))}
              </div>
              <p className="text-sm text-brand-deep font-medium">
                Rekapin lagi nulis transkrip... ({job.transcript.segments.length} segmen sejauh ini)
              </p>
              <button
                onClick={() => handleDelete()}
                disabled={deleting}
                className="ml-auto inline-flex items-center gap-1 text-xs text-brand-deep hover:text-red-600 px-2 py-1 rounded hover:bg-red-50"
              >
                <XCircle size={14} />
                Batalkan
              </button>
            </div>
            <TranscriptViewer transcript={job.transcript} filename={job.filename} isPartial />
          </div>
        ) : (
          <div className="card p-8 sm:p-10 text-center">
            <div className="flex flex-col items-center gap-4">
              <div className="flex items-end justify-center gap-1 h-10">
                {[0, 1, 2, 3, 4].map((i) => (
                  <span
                    key={i}
                    className="w-1.5 bg-brand rounded-full animate-pulse-ring"
                    style={{
                      animationDelay: `${i * 120}ms`,
                      height: `${18 + (i % 3) * 10}px`,
                    }}
                  />
                ))}
              </div>
              <div>
                <p className="text-sm text-ink font-medium">
                  {job.status === 'queued' ? 'Masuk antrian' : 'Rekapin lagi nulis transkrip'}
                </p>
                <p className="mt-1 text-xs text-ink-muted">
                  {job.status === 'queued'
                    ? 'Audio udah aman, sebentar lagi diproses.'
                    : 'Segmen transkrip bakal muncul otomatis...'}
                </p>
              </div>
            </div>
            <button
              onClick={() => handleDelete()}
              disabled={deleting}
              className="mt-6 inline-flex items-center gap-1.5 text-xs text-ink-muted hover:text-red-600 px-3 py-1.5 rounded-full hover:bg-red-50"
            >
              <XCircle size={14} />
              Batalkan
            </button>
          </div>
        )}
      </div>

      {audioPlaying && (
        <MiniPlayer
          audioRef={audioRef}
          playing={audioPlaying}
          currentTime={audioTime}
          duration={audioDuration}
          filename={job.filename}
          onClose={() => { audioRef.current?.pause() }}
        />
      )}

      <ConfirmModal
        open={confirmDelete}
        title="Hapus transkrip"
        message={job && (job.status === 'uploading' || job.status === 'queued' || job.status === 'transcribing' || job.status === 'pending')
          ? 'Batalkan proses transkrip ini? Job akan dihapus dari riwayat.'
          : 'Hapus transkrip ini dari riwayat? Aksi tidak bisa dibatalkan.'
        }
        danger
        confirmLabel="Hapus"
        onConfirm={() => { setConfirmDelete(false); handleDelete(true) }}
        onCancel={() => setConfirmDelete(false)}
      />

      {job && (
        <ShareModal
          open={shareOpen}
          onClose={() => setShareOpen(false)}
          jobId={job.id}
          filename={job.filename}
          initialInternal={job.shareToken}
          initialStakeholder={job.shareTokenMom}
          onTokensChange={handleTokensChange}
        />
      )}
    </div>
  )
}

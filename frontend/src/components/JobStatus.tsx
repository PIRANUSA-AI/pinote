import { motion } from 'framer-motion'
import { CheckCircle, WarningCircle } from '@phosphor-icons/react'
import type { JobDetail } from '../lib/api'
import type { UploadState } from '../hooks/useUpload'
import { WaveformBars } from './animations/WaveformBars'
import { MicTranscribing } from './animations/MicTranscribing'
import { SuccessCheck } from './animations/SuccessCheck'

interface Props {
  upload: UploadState
  job: JobDetail | null
  onReset: () => void
  onViewTranscript: () => void
}

type Phase = 'idle' | 'uploading' | 'transcribing' | 'completed' | 'failed'

function derivePhase(
  upload: UploadState,
  job: JobDetail | null
): { phase: Phase; progress: number; message: string; detail: string } {
  if (job?.status === 'completed') {
    const hasSummary = job.transcript?.summary && job.transcript.summary.length > 0
    if (!hasSummary) {
      return {
        phase: 'transcribing',
        progress: job?.progress ?? 65,
        message: 'Menyiapkan ringkasan...',
        detail: `${job.transcript?.segments.length ?? 0} segmen · ${job.transcript?.speakerCount ?? 1} pembicara`,
      }
    }
    return {
      phase: 'completed',
      progress: 100,
      message: 'Transkrip selesai',
      detail: `${job.transcript?.segments.length ?? 0} segmen · ${job.transcript?.speakerCount ?? 1} pembicara`,
    }
  }

  if (job?.status === 'failed' || job?.status === 'cancelled' || upload.stage === 'error') {
    return {
      phase: 'failed',
      progress: 0,
      message: job?.status === 'cancelled' ? 'Dibatalkan' : 'Gagal',
      detail:
        job?.status === 'cancelled'
          ? 'Transkrip dibatalkan dan kredit dikembalikan.'
          : job?.error ?? upload.error ?? 'Terjadi kesalahan',
    }
  }

  if (upload.stage === 'creating' || upload.stage === 'uploading') {
    return {
      phase: 'uploading',
      progress: upload.progress,
      message: 'Mengirim audio ke server',
      detail: `${upload.progress}% terkirim`,
    }
  }

  if (
    job?.status === 'queued' ||
    job?.status === 'transcribing' ||
    job?.status === 'uploading' ||
    upload.stage === 'queued'
  ) {
    const segments = job?.transcript?.segments?.length ?? 0
    return {
      phase: 'transcribing',
      progress: job?.progress ?? (job?.status === 'queued' ? 20 : 60),
      message: job?.status === 'queued' ? 'Masuk antrian' : 'Rekapin lagi nulis transkrip',
      detail:
        job?.status === 'queued'
          ? 'Audio udah aman, tinggal nunggu giliran diproses.'
          : segments > 0
            ? `${segments} segmen sejauh ini`
            : 'Mengidentifikasi pembicara dan nulis transkrip...',
    }
  }

  return { phase: 'idle', progress: 0, message: '', detail: '' }
}

export function JobStatus({ upload, job, onReset, onViewTranscript }: Props) {
  const { phase, progress, message, detail } = derivePhase(upload, job)

  if (phase === 'idle') return null

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 100, damping: 20 }}
      className="card p-5 sm:p-8 overflow-hidden shadow-sm"
    >
      <div className="flex flex-col sm:flex-row items-center gap-5 sm:gap-8">
        <div className="grid place-items-center flex-shrink-0">
          {phase === 'uploading' && (
            <motion.div
              key="uploading"
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="grid place-items-center w-24 h-24 rounded-full bg-brand-soft border border-brand/10"
            >
              <WaveformBars bars={7} className="w-20 h-12" color="#6366F1" />
            </motion.div>
          )}
          {phase === 'transcribing' && (
            <motion.div
              key="transcribing"
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
            >
              <MicTranscribing size={112} />
            </motion.div>
          )}
          {phase === 'completed' && (
            <motion.div
              key="completed"
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 200, damping: 16 }}
            >
              <SuccessCheck size={88} />
            </motion.div>
          )}
          {phase === 'failed' && (
            <div className="grid place-items-center w-20 h-20 rounded-full bg-red-50 border border-red-200">
              <WarningCircle weight="duotone" size={40} className="text-red-500" />
            </div>
          )}
        </div>

        <div className="text-center sm:text-left w-full min-w-0">
          <p className="eyebrow">
            {phase === 'uploading' && 'Langkah 1 dari 2'}
            {phase === 'transcribing' && (job?.status === 'queued' ? 'Antrian' : 'Langkah 2 dari 2')}
            {phase === 'completed' && 'Selesai'}
            {phase === 'failed' && 'Gagal'}
          </p>
          <h2 className="mt-1.5 text-xl sm:text-2xl tracking-tightest font-semibold leading-tight">
            {message}
          </h2>
          <p className="mt-1 text-sm text-ink-muted max-w-md mx-auto sm:mx-0 leading-relaxed">
            {detail}
          </p>

          {(phase === 'uploading' || phase === 'transcribing') && (
            <div className="mt-4 max-w-md mx-auto sm:mx-0 w-full">
              <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                <motion.div
                  className="h-full bg-brand rounded-full"
                  initial={{ width: 0 }}
                  animate={{ width: `${progress}%` }}
                  transition={{ type: 'spring', stiffness: 80, damping: 22 }}
                />
              </div>
              <div className="mt-1.5 flex justify-between text-xs text-ink-muted">
                <span>{phase === 'uploading' ? 'Mengirim' : job?.status === 'queued' ? 'Menunggu' : 'Memproses'}</span>
                <span className="tabular">{Math.round(progress)}%</span>
              </div>
            </div>
          )}

          <div className="mt-5 flex flex-wrap gap-3 justify-center sm:justify-start">
            {phase === 'completed' && (
              <>
                <button onClick={onViewTranscript} className="btn-primary">
                  <CheckCircle weight="bold" size={16} />
                  Lihat Transkrip
                </button>
                <button onClick={onReset} className="btn-ghost">
                  Transkrip lagi
                </button>
              </>
            )}
            {phase === 'failed' && (
              <button onClick={onReset} className="btn-primary">
                Coba lagi
              </button>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  )
}

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  ArrowRight,
  ClockCounterClockwise,
  CheckCircle,
  WarningCircle,
  CircleNotch,
  Trash,
} from '@phosphor-icons/react'
import { api, type JobSummary } from '../lib/api'
import { formatBytes, formatDuration, formatRelativeTime } from '../lib/format'
import { TitleScrambler } from './TitleScrambler'
import { useToast } from '../components/Toast'

interface Props {
  refreshKey?: number
  limit?: number
  emptyAction?: boolean
}

export function HistoryList({ refreshKey, limit, emptyAction = true }: Props) {
  const [jobs, setJobs] = useState<JobSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const { toast } = useToast()

  const load = async () => {
    try {
      const data = await api.get<{ jobs: JobSummary[] }>(limit ? `/jobs?limit=${limit}` : '/jobs')
      setJobs(limit ? data.jobs.slice(0, limit) : data.jobs)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memuat riwayat')
    }
  }

  useEffect(() => {
    void load()
  }, [refreshKey, limit])

  const handleDelete = async (e: React.MouseEvent, job: JobSummary) => {
    e.preventDefault()
    e.stopPropagation()
    const isRunning = job.status === 'uploading' || job.status === 'queued' || job.status === 'transcribing' || job.status === 'pending'
    const msg = isRunning
      ? `Batalkan proses "${job.filename}"?`
      : `Hapus transkrip "${job.filename}"?`
    if (!confirm(msg)) return
    setDeletingId(job.id)
    try {
      await api.delete(`/jobs/${job.id}`)
      setJobs((prev) => (prev ? prev.filter((j) => j.id !== job.id) : prev))
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Gagal menghapus', 'error')
    } finally {
      setDeletingId(null)
    }
  }

  if (error) {
    return <p className="text-sm text-red-600 px-1">Gagal memuat riwayat. {error}</p>
  }

  if (jobs === null) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="skeleton h-16 rounded-2xl" />
        ))}
      </div>
    )
  }

  if (jobs.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-300 px-6 py-12 text-center bg-surface">
        <ClockCounterClockwise weight="duotone" size={32} className="mx-auto text-brand" />
        <p className="mt-3 text-sm text-ink font-semibold">Belum ada transkrip.</p>
        {emptyAction && (
          <p className="text-xs text-ink-muted mt-1">Upload audio pertama untuk memulai.</p>
        )}
      </div>
    )
  }

  return (
    <ul className="divide-y divide-slate-200/80 border-t border-b border-slate-200/80">
      {jobs.map((job, i) => (
        <motion.li
          key={job.id}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: Math.min(i * 0.02, 0.3) }}
          className="group relative"
        >
          <Link
            to={`/job/${job.id}`}
            className="flex items-center gap-4 py-4 px-1 hover:bg-paper transition-colors -mx-1 rounded-lg"
          >
            <StatusBadge status={job.status} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate text-ink" title={job.filename}>
                <TitleScrambler
                  from={job.filename}
                  to={job.status === 'completed' ? job.title : null}
                  delay={Math.min(i * 90, 700)}
                />
              </p>
              <p className="text-xs text-ink-muted mt-0.5 truncate tabular">
                {[
                  formatRelativeTime(job.createdAt),
                  job.durationSec ? formatDuration(job.durationSec) : null,
                  job.sizeBytes ? formatBytes(job.sizeBytes) : null,
                  job.speakerCount && job.speakerCount > 0 ? `${job.speakerCount} pembicara` : null,
                  job.isOwner === false ? `Dibagikan oleh ${job.ownerName ?? 'anggota tim'}` : null,
                ]
                  .filter(Boolean)
                  .join(' | ')}
              </p>
            </div>
            {job.isOwner !== false && <button
              onClick={(e) => handleDelete(e, job)}
              disabled={deletingId === job.id}
              className="grid place-items-center w-9 h-9 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 disabled:opacity-40"
              title={
                job.status === 'transcribing' || job.status === 'queued' || job.status === 'uploading' || job.status === 'pending'
                  ? 'Batalkan'
                  : 'Hapus'
              }
            >
              <Trash size={16} />
            </button>}
            <ArrowRight size={16} className="text-slate-400 flex-shrink-0" />
          </Link>
        </motion.li>
      ))}
    </ul>
  )
}

function StatusBadge({ status }: { status: JobSummary['status'] }) {
  if (status === 'completed') {
    return (
      <span className="grid place-items-center w-9 h-9 rounded-xl bg-navy text-white flex-shrink-0">
        <CheckCircle weight="fill" size={18} />
      </span>
    )
  }
  if (status === 'failed') {
    return (
      <span className="grid place-items-center w-9 h-9 rounded-xl bg-red-50 border border-red-200 text-red-600 flex-shrink-0">
        <WarningCircle weight="fill" size={18} />
      </span>
    )
  }
  return (
    <span className="grid place-items-center w-9 h-9 rounded-xl bg-brand-soft border border-brand/20 text-brand-deep flex-shrink-0">
      <CircleNotch weight="bold" size={18} className="animate-spin" />
    </span>
  )
}

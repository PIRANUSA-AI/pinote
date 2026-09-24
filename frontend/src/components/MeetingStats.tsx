import { useEffect, useState } from 'react'
import { api } from '../lib/api'

interface MeetingStatsResponse {
  days: number
  meetings: number
  speakers: { name: string; seconds: number; share: number; meetings: number }[]
  owners: { name: string; open: number; done: number }[]
}

function talkLabel(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  if (minutes < 1) return `${seconds} dtk`
  if (minutes < 60) return `${minutes} mnt`
  return `${Math.floor(minutes / 60)} j ${minutes % 60} mnt`
}

export function MeetingStats() {
  const [data, setData] = useState<MeetingStatsResponse | null>(null)

  useEffect(() => {
    api.get<MeetingStatsResponse>('/auth/me/meeting-stats?days=30').then(setData).catch(() => {})
  }, [])

  if (!data || data.meetings === 0 || (data.speakers.length === 0 && data.owners.length === 0)) return null
  const maxTasks = Math.max(1, ...data.owners.map((owner) => owner.open + owner.done))

  return (
    <section className="card p-4 sm:p-5 mb-6" aria-labelledby="meetingStatsTitle">
      <div className="flex items-baseline justify-between gap-3 mb-4">
        <h2 id="meetingStatsTitle" className="font-semibold text-[15px] text-navy">Rapatmu {data.days} hari terakhir</h2>
        <span className="text-[12px] text-ink-muted tabular">{data.meetings} rapat</span>
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        {data.speakers.length > 0 && (
          <div>
            <h3 className="text-[12px] font-semibold text-ink-muted mb-2.5">Waktu bicara</h3>
            <ul className="space-y-2.5">
              {data.speakers.map((speaker) => (
                <li key={speaker.name}>
                  <div className="flex items-baseline justify-between gap-3 text-[13px]">
                    <span className="truncate text-ink font-medium">{speaker.name}</span>
                    <span className="flex-shrink-0 text-ink-muted tabular">{talkLabel(speaker.seconds)} · {speaker.share}%</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                    <div className="h-full rounded-full bg-brand" style={{ width: `${Math.max(2, speaker.share)}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
        {data.owners.length > 0 && (
          <div>
            <h3 className="text-[12px] font-semibold text-ink-muted mb-2.5">Tugas per orang</h3>
            <ul className="space-y-2.5">
              {data.owners.map((owner) => (
                <li key={owner.name}>
                  <div className="flex items-baseline justify-between gap-3 text-[13px]">
                    <span className="truncate text-ink font-medium">{owner.name}</span>
                    <span className="flex-shrink-0 text-ink-muted tabular">{owner.open} terbuka · {owner.done} selesai</span>
                  </div>
                  <div className="mt-1 flex h-1.5 rounded-full bg-slate-100 overflow-hidden">
                    <div className="h-full bg-emerald-500" style={{ width: `${(owner.done / maxTasks) * 100}%` }} />
                    <div className="h-full bg-amber-400" style={{ width: `${(owner.open / maxTasks) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  )
}

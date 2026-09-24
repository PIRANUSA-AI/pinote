import type { TranscriptSegment } from '../db/schema.js'

const PLACEHOLDER = /^(\d+|speaker\s*\d+|pembicara\s*\d+|peserta|rapat|saya|identitas belum tersedia|unknown|unassigned)$/i
const MAX_SEGMENT_SECONDS = 180

export interface StatsJob {
  segments: TranscriptSegment[]
  speakerNames: Record<string, string>
}

export interface StatsItem {
  owner: string
  done: boolean
}

function seconds(value: string): number {
  const parts = value.split(':').map(Number)
  if (parts.some((part) => !Number.isFinite(part))) return NaN
  return parts.reduce((total, part) => total * 60 + part, 0)
}

function realName(label: string, names: Record<string, string>): string | null {
  const name = (names[label] ?? label).trim()
  return name && !PLACEHOLDER.test(name) ? name : null
}

export function aggregateMeetingStats(jobs: StatsJob[], items: StatsItem[], limit = 8) {
  const talk = new Map<string, { name: string; seconds: number; meetings: Set<number> }>()
  jobs.forEach((job, jobIndex) => {
    for (const segment of job.segments) {
      const name = realName(segment.speaker, job.speakerNames)
      if (!name) continue
      const span = seconds(segment.end) - seconds(segment.start)
      if (!Number.isFinite(span) || span <= 0) continue
      const key = name.toLowerCase()
      const entry = talk.get(key) ?? { name, seconds: 0, meetings: new Set<number>() }
      entry.seconds += Math.min(span, MAX_SEGMENT_SECONDS)
      entry.meetings.add(jobIndex)
      talk.set(key, entry)
    }
  })
  const totalTalk = [...talk.values()].reduce((sum, entry) => sum + entry.seconds, 0)

  const owners = new Map<string, { name: string; open: number; done: number }>()
  for (const item of items) {
    const name = item.owner.trim()
    if (!name || PLACEHOLDER.test(name)) continue
    const key = name.toLowerCase()
    const entry = owners.get(key) ?? { name, open: 0, done: 0 }
    if (item.done) entry.done += 1
    else entry.open += 1
    owners.set(key, entry)
  }

  return {
    meetings: jobs.length,
    speakers: [...talk.values()]
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, limit)
      .map((entry) => ({
        name: entry.name,
        seconds: Math.round(entry.seconds),
        share: totalTalk > 0 ? Math.round((entry.seconds / totalTalk) * 100) : 0,
        meetings: entry.meetings.size,
      })),
    owners: [...owners.values()]
      .sort((a, b) => b.open + b.done - (a.open + a.done) || b.open - a.open)
      .slice(0, limit),
  }
}

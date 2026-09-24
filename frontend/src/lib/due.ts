const DAY_MS = 24 * 60 * 60 * 1000
const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000

export type DueTone = 'overdue' | 'soon' | 'normal' | 'done'

export interface DueStatus {
  label: string
  tone: DueTone
}

function jakartaToday(now: Date): number {
  const local = new Date(now.getTime() + JAKARTA_OFFSET_MS)
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate())
}

function parseDay(value: string): number | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!match) return null
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

export function dueStatus(dueOn: string | null | undefined, due: string | null | undefined, done: boolean, now = new Date()): DueStatus | null {
  const day = dueOn ? parseDay(dueOn) : null
  if (day === null) return due?.trim() ? { label: `Tenggat: ${due.trim()}`, tone: done ? 'done' : 'normal' } : null

  const date = new Date(day)
  const short = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(date)
  const named = new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(date)
  if (done) return { label: `Tenggat ${short}`, tone: 'done' }

  const diff = Math.round((day - jakartaToday(now)) / DAY_MS)
  if (diff < 0) return { label: diff === -1 ? 'Lewat sejak kemarin' : `Lewat ${-diff} hari`, tone: 'overdue' }
  if (diff === 0) return { label: 'Tenggat hari ini', tone: 'soon' }
  if (diff === 1) return { label: 'Tenggat besok', tone: 'soon' }
  if (diff < 7) return { label: `Tenggat ${named}`, tone: 'normal' }
  return { label: `Tenggat ${short}`, tone: 'normal' }
}

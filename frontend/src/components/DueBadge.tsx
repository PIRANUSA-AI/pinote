import { dueStatus, type DueTone } from '../lib/due'

const TONES: Record<DueTone, string> = {
  overdue: 'text-rose-700 bg-rose-50 px-1.5 py-0.5 rounded font-medium',
  soon: 'text-amber-800 bg-amber-50 px-1.5 py-0.5 rounded font-medium',
  normal: 'text-ink-muted',
  done: 'text-slate-400',
}

export function DueBadge({ due, dueOn, done }: { due: string | null | undefined; dueOn?: string | null; done: boolean }) {
  const status = dueStatus(dueOn, due, done)
  if (!status) return null
  return (
    <span className={`text-[11px] tabular ${TONES[status.tone]}`} title={due && dueOn ? `Disebut di rapat: ${due}` : undefined}>
      {status.label}
    </span>
  )
}

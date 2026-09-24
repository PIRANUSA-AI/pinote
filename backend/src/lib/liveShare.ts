export const LIVE_SHARE_MAX_LINES = 3000

export interface LiveShareLine {
  text: string
  speaker: string
  at: number
  chat?: boolean
}

export interface LiveShareState {
  userId: string
  title: string | null
  source: string
  startedAt: string
  updatedAt: string
  endedAt: string | null
  base: number
  lines: LiveShareLine[]
}

export function cleanLiveLine(raw: unknown): LiveShareLine | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (typeof value.text !== 'string' || !value.text.trim()) return null
  const speaker = typeof value.speaker === 'string' ? value.speaker.trim().slice(0, 120) : ''
  const at = typeof value.at === 'number' && Number.isFinite(value.at) ? value.at : Date.now()
  const line: LiveShareLine = { text: value.text.trim().slice(0, 4000), speaker, at }
  if (value.chat === true) line.chat = true
  return line
}

export function applyLiveLines(state: LiveShareState, from: number, incoming: LiveShareLine[], total: number): LiveShareState {
  const localFrom = Math.max(0, from - state.base)
  const skip = Math.max(0, state.base - from)
  const usable = incoming.slice(skip)
  const merged = state.lines.slice(0, localFrom).concat(usable, state.lines.slice(localFrom + usable.length))
  const expected = Math.max(0, total - state.base)
  const lines = merged.slice(0, expected)
  const overflow = Math.max(0, lines.length - LIVE_SHARE_MAX_LINES)
  return {
    ...state,
    base: state.base + overflow,
    lines: overflow > 0 ? lines.slice(overflow) : lines,
    updatedAt: new Date().toISOString(),
  }
}

export function publicLiveView(state: LiveShareState, since: number) {
  const localSince = Math.max(0, since - state.base)
  return {
    title: state.title,
    source: state.source,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    endedAt: state.endedAt,
    base: state.base,
    from: state.base + Math.min(localSince, state.lines.length),
    total: state.base + state.lines.length,
    lines: state.lines.slice(localSince),
  }
}

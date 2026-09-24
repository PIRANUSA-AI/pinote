import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowDown, ChatCircleDots } from '@phosphor-icons/react'
import { ApiError, api } from '../lib/api'
import { BrandMark } from '../components/Brand'
import { LoadingScreen } from '../components/LoadingScreen'

interface LiveLine {
  text: string
  speaker: string
  at: number
  chat?: boolean
}

interface LiveView {
  title: string | null
  source: string
  startedAt: string
  updatedAt: string
  endedAt: string | null
  base: number
  from: number
  total: number
  lines: LiveLine[]
}

const POLL_MS = 3000
const SOURCE_NAMES: Record<string, string> = { meet: 'Google Meet', zoom: 'Zoom', teams: 'Microsoft Teams' }

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, '0')
  const seconds = String(total % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`
}

export default function LiveTranscript() {
  const { token } = useParams<{ token: string }>()
  const [view, setView] = useState<Omit<LiveView, 'lines' | 'from'> | null>(null)
  const [lines, setLines] = useState<LiveLine[]>([])
  const [error, setError] = useState<string | null>(null)
  const [following, setFollowing] = useState(true)
  const linesRef = useRef<LiveLine[]>([])
  const baseRef = useRef(0)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!token) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const poll = async () => {
      try {
        const since = Math.max(0, baseRef.current + linesRef.current.length - 3)
        const next = await api.get<LiveView>(`/live-shares/public/${encodeURIComponent(token)}?since=${since}`)
        if (stopped) return
        const kept = next.base === baseRef.current ? linesRef.current.slice(0, next.from - next.base) : []
        const merged = kept.concat(next.lines).slice(0, next.total - next.base)
        baseRef.current = next.base
        linesRef.current = merged
        setLines(merged)
        setView({ title: next.title, source: next.source, startedAt: next.startedAt, updatedAt: next.updatedAt, endedAt: next.endedAt, base: next.base, total: next.total })
        setError(null)
        if (!next.endedAt) timer = setTimeout(poll, document.hidden ? POLL_MS * 3 : POLL_MS)
      } catch (err) {
        if (stopped) return
        if (err instanceof ApiError && err.status === 404) {
          setError('Transkrip langsung ini tidak ditemukan atau sudah ditutup oleh pemiliknya.')
          return
        }
        timer = setTimeout(poll, POLL_MS * 2)
      }
    }

    void poll()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [token])

  useEffect(() => {
    const onScroll = () => {
      const distance = document.documentElement.scrollHeight - window.scrollY - window.innerHeight
      setFollowing(distance < 120)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    if (following) endRef.current?.scrollIntoView({ block: 'end' })
  }, [lines, following])

  if (error) {
    return (
      <div className="min-h-[100dvh] grid place-items-center bg-paper px-6 text-center">
        <div>
          <BrandMark size={36} />
          <p className="mt-4 text-[15px] font-semibold text-navy">Tautan tidak aktif</p>
          <p className="mt-1.5 text-sm text-ink-muted max-w-sm">{error}</p>
        </div>
      </div>
    )
  }

  if (!view) return <LoadingScreen />

  const startedAt = Date.parse(view.startedAt)
  const ended = Boolean(view.endedAt)
  const platform = SOURCE_NAMES[view.source]

  return (
    <div className="min-h-[100dvh] bg-paper">
      <header className="sticky top-0 z-10 border-b border-slate-200/70 bg-paper/90 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-2xl items-center gap-3 px-4">
          <Link to="/welcome" aria-label="Rekapin">
            <BrandMark size={26} />
          </Link>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] font-semibold text-navy">{view.title || 'Transkrip rapat'}</p>
            <p className="text-[11px] text-ink-muted">{platform ? `${platform} · ` : ''}{ended ? 'Rapat selesai' : 'Sedang berlangsung'}</p>
          </div>
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${ended ? 'bg-slate-100 text-ink-muted' : 'bg-rose-50 text-rose-700'}`}>
            {!ended && <span className="h-1.5 w-1.5 rounded-full bg-rose-600 animate-pulse" aria-hidden="true" />}
            {ended ? 'Selesai' : 'Langsung'}
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-4 pb-24 pt-4" aria-live="polite">
        {lines.length === 0 ? (
          <p className="py-20 text-center text-sm text-ink-muted">{ended ? 'Tidak ada yang tercatat di rapat ini.' : 'Menunggu ada yang bicara...'}</p>
        ) : (
          <ol className="divide-y divide-slate-200/80">
            {lines.map((line, index) => {
              const previous = lines[index - 1]
              const continued = previous && previous.speaker === line.speaker && Boolean(previous.chat) === Boolean(line.chat)
              return (
                <li key={view.base + index} className={continued ? '!border-t-0 pb-2' : 'pt-3 pb-2'}>
                  {!continued && (
                    <div className="mb-1 flex items-baseline justify-between gap-3">
                      <span className="inline-flex items-center gap-1.5 text-[12px] font-bold text-brand">
                        {line.speaker || 'Rapat'}
                        {line.chat && <ChatCircleDots size={13} weight="fill" aria-label="Dari chat" />}
                      </span>
                      {Number.isFinite(startedAt) && <span className="text-[11px] tabular text-slate-400">{clock(line.at - startedAt)}</span>}
                    </div>
                  )}
                  <p className="text-[15px] leading-relaxed text-ink">{line.text}</p>
                </li>
              )
            })}
          </ol>
        )}
        <div ref={endRef} />
      </main>

      {!following && lines.length > 0 && (
        <button
          type="button"
          onClick={() => { setFollowing(true); endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }) }}
          className="fixed bottom-6 left-1/2 -translate-x-1/2 inline-flex items-center gap-1.5 rounded-full bg-navy px-4 py-2 text-[12px] font-semibold text-white shadow-lg"
        >
          <ArrowDown size={13} weight="bold" />
          Ke terbaru
        </button>
      )}
    </div>
  )
}

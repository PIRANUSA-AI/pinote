import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Copy, DownloadSimple, MagnifyingGlass, Check } from '@phosphor-icons/react'
import type { ActionItem, TranscriptPayload } from '../lib/api'
import { speakerColor, parseTimestamp } from '../lib/format'
import { ActionItemsPanel } from './ActionItemsPanel'
import { MARK_LABELS, segmentMarks, type MarkKind } from '../lib/highlights'

const MARK_TONES: Record<MarkKind, string> = {
  decision: 'bg-emerald-50 text-emerald-800',
  question: 'bg-amber-50 text-amber-800',
}

interface Props {
  transcript: TranscriptPayload
  filename: string
  isPartial?: boolean
  jobId?: string
  actionItems?: ActionItem[]
  speakerNames?: Record<string, string>
  readOnly?: boolean
  onActionItemsChange?: (next: ActionItem[]) => void
  onSpeakerRename?: (speaker: string, name: string) => void
  audioCurrentTime?: number
}

export function TranscriptViewer({
  transcript,
  filename,
  isPartial,
  jobId,
  actionItems,
  speakerNames,
  readOnly,
  onActionItemsChange,
  onSpeakerRename,
  audioCurrentTime,
}: Props) {
  const [query, setQuery] = useState('')
  const [copied, setCopied] = useState<'all' | 'segment' | null>(null)
  const [showRaw, setShowRaw] = useState(false)
  const [searchIdx, setSearchIdx] = useState(0)

  const segRefs = useRef<(HTMLDivElement | null)[]>([])
  const [activeIdx, setActiveIdx] = useState(-1)

  const hasRaw = Boolean(transcript.rawSegments && transcript.rawSegments.length > 0)
  const activeSegments = showRaw && hasRaw ? transcript.rawSegments! : transcript.segments

  const marks = useMemo(() => activeSegments.map((s) => segmentMarks(s.text)), [activeSegments])
  const markCounts = useMemo(() => {
    const counts: Record<MarkKind, number> = { decision: 0, question: 0 }
    for (const set of marks) for (const kind of set) counts[kind] += 1
    return counts
  }, [marks])
  const [markFilter, setMarkFilter] = useState<MarkKind | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return activeSegments
      .map((seg, index) => ({ seg, index }))
      .filter(({ seg, index }) => !markFilter || marks[index]?.has(markFilter))
      .filter(({ seg }) => !q || seg.text.toLowerCase().includes(q) || seg.speaker.toLowerCase().includes(q))
  }, [activeSegments, query, markFilter, marks])

  useEffect(() => { setSearchIdx(0) }, [query, markFilter])

  useEffect(() => {
    if (audioCurrentTime === undefined || audioCurrentTime <= 0 || filtered.length === 0) {
      setActiveIdx(-1)
      return
    }
    const idx = activeSegments.findIndex((s) => {
      const t = parseTimestamp(s.start)
      const tEnd = parseTimestamp(s.end)
      return audioCurrentTime >= t && audioCurrentTime < (tEnd || t + 10)
    })
    setActiveIdx(idx)
    if (idx >= 0 && segRefs.current[idx]) {
      segRefs.current[idx]!.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [audioCurrentTime, activeSegments, query])

  const copyAll = async () => {
    const text = activeSegments
      .map((s) => `[${s.start}] ${s.speaker}: ${s.text}`)
      .join('\n\n')
    await navigator.clipboard.writeText(text)
    setCopied('all')
    setTimeout(() => setCopied(null), 1500)
  }

  const copySegment = async (text: string) => {
    await navigator.clipboard.writeText(text)
    setCopied('segment')
    setTimeout(() => setCopied(null), 1000)
  }

  const downloadTxt = () => {
    const text = activeSegments
      .map((s) => `[${s.start}] ${s.speaker}: ${s.text}`)
      .join('\n\n')
    triggerDownload(text, `${stripExt(filename)}.txt`, 'text/plain')
  }

  const downloadSrt = () => {
    const lines = activeSegments.map((s, i) => {
      const start = toSrtTime(s.start)
      const end = toSrtTime(s.end)
      return `${i + 1}\n${start} --> ${end}\n${s.speaker}: ${s.text}`
    })
    triggerDownload(lines.join('\n\n'), `${stripExt(filename)}.srt`, 'text/plain')
  }

  const summaryLines = String(Array.isArray(transcript.summary) ? transcript.summary.join('\n') : (transcript.summary ?? ''))
    .split('\n')
    .map((l) => l.replace(/^[-*•]\s*/, '').trim())
    .filter(Boolean)

  const resolveName = (speaker: string) => speakerNames?.[speaker] ?? speaker

  return (
    <div className="space-y-6 pb-28 sm:pb-0">
      {actionItems && actionItems.length > 0 && jobId && (
        <ActionItemsPanel
          jobId={jobId}
          actionItems={actionItems}
          speakerNames={speakerNames ?? {}}
          readOnly={readOnly}
          onChange={onActionItemsChange}
          onSpeakerRename={onSpeakerRename}
        />
      )}

      {summaryLines.length > 0 && (
        <div className="card p-5 sm:p-7">
          <h3 className="eyebrow mb-3">Ringkasan</h3>
          <ul className="space-y-2.5">
            {summaryLines.map((line, i) => (
              <motion.li
                key={i}
                initial={{ opacity: 0, x: -4 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.05 }}
                className="flex gap-3 text-[15px] text-navy leading-relaxed"
              >
                <span className="text-slate-300 select-none mt-2 w-1 h-1 rounded-full bg-slate-400 flex-shrink-0" />
                <span>{line}</span>
              </motion.li>
            ))}
          </ul>
        </div>
      )}

      <div className="sticky top-14 z-20 -mx-4 sm:mx-0 px-4 sm:px-0 py-3 bg-white/95 backdrop-blur border-b border-slate-200/80 sm:rounded-xl sm:border sm:bg-white sm:py-2 sm:px-3 sm:shadow-sm">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Cari di transkrip…"
              className="w-full rounded-lg border border-slate-200 sm:border-0 bg-white pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-4 focus:ring-brand/15"
            />
          </div>
          {hasRaw && (
            <button
              onClick={() => setShowRaw((v) => !v)}
              className={`px-3 h-9 rounded-lg text-xs font-medium flex items-center gap-1.5 flex-shrink-0 ${
                showRaw
                  ? 'bg-slate-200 text-ink'
                  : 'bg-navy text-white'
              }`}
              title={showRaw ? 'Lihat transkrip yang sudah diperbaiki' : 'Lihat transkrip mentah'}
            >
              {showRaw ? 'Mentah' : 'Dipoles'}
            </button>
          )}
          {query.trim() && filtered.length > 0 && (
            <div className="hidden sm:flex items-center gap-1 text-xs text-ink-muted tabular">
              <button
                onClick={() => {
                  const next = (searchIdx - 1 + filtered.length) % filtered.length
                  setSearchIdx(next)
                  segRefs.current[next]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                }}
                className="grid place-items-center w-7 h-7 rounded hover:bg-slate-100"
                aria-label="Sebelumnya"
              >
                ▲
              </button>
              <span className="min-w-[4rem] text-center">{searchIdx + 1} / {filtered.length}</span>
              <button
                onClick={() => {
                  const next = (searchIdx + 1) % filtered.length
                  setSearchIdx(next)
                  segRefs.current[next]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                }}
                className="grid place-items-center w-7 h-7 rounded hover:bg-slate-100"
                aria-label="Berikutnya"
              >
                ▼
              </button>
            </div>
          )}

          <div className="hidden sm:flex items-center gap-1">
            <button
              onClick={copyAll}
              className="grid place-items-center w-9 h-9 rounded-lg hover:bg-slate-100 text-ink"
              title="Salin semua"
            >
              {copied === 'all' ? <Check size={16} weight="bold" /> : <Copy size={16} />}
            </button>
            <button
              onClick={downloadTxt}
              className="px-3 h-9 rounded-lg hover:bg-slate-100 text-sm font-medium text-navy flex items-center gap-1.5"
              title="Download TXT"
            >
              <DownloadSimple size={16} />
              TXT
            </button>
            <button
              onClick={downloadSrt}
              className="px-3 h-9 rounded-lg hover:bg-slate-100 text-sm font-medium text-navy flex items-center gap-1.5"
              title="Download SRT"
            >
              SRT
            </button>
          </div>
        </div>
        {(markCounts.decision > 0 || markCounts.question > 0) && (
          <div className="flex items-center gap-1.5 mt-2 flex-wrap" role="group" aria-label="Tampilkan bagian tertentu">
            {(['decision', 'question'] as const).filter((kind) => markCounts[kind] > 0).map((kind) => (
              <button
                key={kind}
                type="button"
                aria-pressed={markFilter === kind}
                onClick={() => setMarkFilter((current) => (current === kind ? null : kind))}
                className={`text-[12px] font-medium rounded-full px-2.5 py-1 border transition-colors tabular ${
                  markFilter === kind ? 'bg-navy text-white border-navy' : 'bg-white text-ink-muted border-slate-200 hover:border-slate-300 hover:text-navy'
                }`}
              >
                {MARK_LABELS[kind]} {markCounts[kind]}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-3">
        {filtered.length === 0 ? (
          <p className="text-center text-sm text-ink-muted py-12">
            Tidak ada hasil untuk "{query}"
          </p>
        ) : (
          filtered.map(({ seg, index }, i) => (
            <motion.div
              key={index}
              id={!(showRaw && hasRaw) ? `seg-${index}` : undefined}
              ref={(el) => { segRefs.current[i] = el }}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(i * 0.02, 0.3) }}
              className={`group rounded-2xl border transition-all overflow-hidden ${
                index === activeIdx ? 'border-brand bg-brand-soft/50 shadow-sm ring-1 ring-brand/20' : 'border-slate-200 bg-white hover:border-slate-300'
              }`}
            >
              <div className="grid sm:grid-cols-[auto_1fr] gap-3 sm:gap-5 p-4 sm:p-5">
                <div className="flex sm:flex-col items-center sm:items-start gap-3 sm:gap-2 flex-shrink-0 sm:w-32">
                  <span
                    className={`inline-flex items-center px-2.5 py-0.5 rounded-full border text-[11px] font-medium ${speakerColor(seg.speaker)}`}
                  >
                    {resolveName(seg.speaker)}
                  </span>
                  <span className="text-[11px] text-slate-400 tabular">
                    {seg.start}
                    <span className="hidden sm:inline"> → {seg.end}</span>
                  </span>
                  {[...(marks[index] ?? [])].map((kind) => (
                    <span key={kind} className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${MARK_TONES[kind]}`}>
                      {MARK_LABELS[kind]}
                    </span>
                  ))}
                </div>
                <p className="text-[15px] leading-relaxed text-ink">{highlight(seg.text, query)}</p>
              </div>
              <button
                onClick={() => copySegment(seg.text)}
                className="px-4 py-2 w-full text-left text-xs text-slate-400 hover:text-navy hover:bg-paper border-t border-slate-100 transition-colors opacity-0 group-hover:opacity-100 sm:flex items-center justify-end gap-1 hidden"
              >
                <Copy size={12} />
                Salin segmen
              </button>
            </motion.div>
          ))
        )}
      </div>

      <div className="sm:hidden fixed inset-x-0 z-[45] px-4 pt-3 bg-gradient-to-t from-white via-white to-white/0"
        style={{ bottom: 'calc(6.5rem + env(safe-area-inset-bottom))' }}>
        <div className="flex gap-2 rounded-2xl bg-navy p-2 shadow-xl">
          <button
            onClick={copyAll}
            className="flex-1 py-2.5 rounded-xl text-sm text-white font-medium flex items-center justify-center gap-1.5 hover:bg-navy-soft"
          >
            {copied === 'all' ? <Check size={16} weight="bold" /> : <Copy size={16} />}
            Salin
          </button>
          <button
            onClick={downloadTxt}
            className="flex-1 py-2.5 rounded-xl text-sm text-white font-medium flex items-center justify-center gap-1.5 hover:bg-navy-soft"
          >
            <DownloadSimple size={16} />
            TXT
          </button>
          <button
            onClick={downloadSrt}
            className="flex-1 py-2.5 rounded-xl text-sm text-white font-medium flex items-center justify-center gap-1.5 hover:bg-navy-soft"
          >
            SRT
          </button>
        </div>
      </div>
    </div>
  )
}

function highlight(text: string, query: string) {
  if (!query.trim()) return text
  const q = query.trim()
  const lower = text.toLowerCase()
  const ql = q.toLowerCase()
  const parts: React.ReactNode[] = []
  let i = 0
  let idx = lower.indexOf(ql)
  while (idx >= 0) {
    if (idx > i) parts.push(text.slice(i, idx))
    parts.push(
      <mark key={i + '-' + idx} className="bg-navy text-white rounded-sm px-0.5">
        {text.slice(idx, idx + q.length)}
      </mark>
    )
    i = idx + q.length
    idx = lower.indexOf(ql, i)
  }
  if (i < text.length) parts.push(text.slice(i))
  return parts
}

function stripExt(name: string) {
  const idx = name.lastIndexOf('.')
  return idx > 0 ? name.slice(0, idx) : name
}

function triggerDownload(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function toSrtTime(ts: string): string {
  const sec = parseTimestamp(ts)
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  return `${pad(h)}:${pad(m)}:${pad(s)},000`
}

function pad(n: number) {
  return n.toString().padStart(2, '0')
}

import { useRef, useState, type FormEvent } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowUp, ChatCircleText, Quotes } from '@phosphor-icons/react'
import { ApiError, api } from '../lib/api'
import { parseTimestamp } from '../lib/format'

interface Citation {
  index: number
  start: string
  speaker: string
  text: string
}

interface Answer {
  question: string
  answer: string
  found: boolean
  citations: Citation[]
}

const EXAMPLES = ['Apa saja keputusan rapat ini?', 'Siapa yang pegang tugas paling banyak?', 'Ada yang belum disepakati?']

export function AskMeeting({ jobId, onJump }: { jobId: string; onJump: (index: number, seconds: number) => void }) {
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [answers, setAnswers] = useState<Answer[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  const ask = async (text: string) => {
    const trimmed = text.trim()
    if (trimmed.length < 3 || asking) return
    setAsking(true)
    setError(null)
    try {
      const result = await api.post<Omit<Answer, 'question'>>(`/jobs/${jobId}/ask`, { question: trimmed })
      setAnswers((previous) => [{ question: trimmed, ...result }, ...previous].slice(0, 5))
      setQuestion('')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Belum bisa menjawab sekarang. Coba lagi sebentar lagi.')
    } finally {
      setAsking(false)
      inputRef.current?.focus()
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void ask(question)
  }

  return (
    <section className="card p-4 sm:p-5" aria-labelledby="askTitle">
      <div className="flex items-center gap-2 mb-3">
        <ChatCircleText size={18} weight="duotone" className="text-brand" />
        <h2 id="askTitle" className="font-semibold text-[15px] text-navy">Tanya rapat ini</h2>
      </div>

      <form onSubmit={submit} className="relative">
        <input
          ref={inputRef}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          maxLength={500}
          placeholder="Misalnya: Budi setuju soal anggaran?"
          aria-label="Pertanyaan tentang rapat ini"
          className="w-full h-11 pl-3.5 pr-12 rounded-xl border border-slate-200 bg-white text-sm text-ink placeholder:text-slate-400 focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/15"
        />
        <button
          type="submit"
          disabled={asking || question.trim().length < 3}
          aria-label="Kirim pertanyaan"
          className="absolute right-1.5 top-1.5 grid place-items-center w-8 h-8 rounded-lg bg-navy text-white disabled:bg-slate-200 disabled:text-slate-400 transition-colors"
        >
          {asking ? <span className="w-3.5 h-3.5 border-2 border-white/60 border-t-transparent rounded-full animate-spin" /> : <ArrowUp size={15} weight="bold" />}
        </button>
      </form>

      {answers.length === 0 && !asking && !error && (
        <div className="flex flex-wrap gap-1.5 mt-3">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => void ask(example)}
              className="text-[12px] text-ink-muted bg-slate-50 hover:bg-brand-soft hover:text-navy border border-slate-200 rounded-full px-2.5 py-1 transition-colors"
            >
              {example}
            </button>
          ))}
        </div>
      )}

      {error && <p className="mt-3 text-[13px] text-rose-700" role="alert">{error}</p>}

      <div className="mt-2" aria-live="polite">
        <AnimatePresence initial={false}>
          {answers.map((item) => (
            <motion.article
              key={item.question + item.answer.slice(0, 20)}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className="pt-4 mt-4 border-t border-slate-100 first:border-t-0 first:mt-2"
            >
              <p className="text-[12px] font-medium text-ink-muted">{item.question}</p>
              <p className="mt-1.5 text-[14px] leading-relaxed text-ink whitespace-pre-line">{item.answer}</p>
              {item.citations.length > 0 && (
                <ul className="mt-3 space-y-1.5">
                  {item.citations.map((citation) => (
                    <li key={citation.index}>
                      <button
                        type="button"
                        onClick={() => onJump(citation.index, parseTimestamp(citation.start))}
                        className="w-full text-left flex gap-2 rounded-lg px-2 py-1.5 hover:bg-brand-soft/60 transition-colors group"
                      >
                        <Quotes size={13} weight="fill" className="text-slate-300 group-hover:text-brand mt-0.5 flex-shrink-0" />
                        <span className="min-w-0">
                          <span className="text-[11px] font-semibold text-navy tabular">{citation.start} · {citation.speaker}</span>
                          <span className="block text-[12px] text-ink-muted line-clamp-2">{citation.text}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </motion.article>
          ))}
        </AnimatePresence>
      </div>
    </section>
  )
}

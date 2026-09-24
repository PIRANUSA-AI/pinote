import { z } from 'zod'
import type { TranscriptSegment } from '../db/schema.js'

const MAX_CONTEXT_CHARS = 24000
const NEIGHBORS = 2
const MAX_CITATIONS = 6

const STOPWORDS = new Set([
  'yang', 'dan', 'di', 'ke', 'dari', 'itu', 'ini', 'apa', 'siapa', 'kapan', 'gimana', 'bagaimana', 'untuk', 'dengan', 'soal',
  'tentang', 'ada', 'tidak', 'nggak', 'gak', 'enggak', 'sudah', 'udah', 'akan', 'bisa', 'kita', 'kami', 'saya', 'aku', 'dia',
  'mereka', 'kah', 'dong', 'sih', 'aja', 'saja', 'juga', 'atau', 'kalau', 'kalo', 'pada', 'dalam', 'oleh', 'mana', 'berapa',
  'kenapa', 'mengapa', 'rapat', 'meeting', 'tadi', 'yg', 'nya', 'the', 'and', 'what', 'who', 'when', 'how', 'why', 'did', 'does',
  'was', 'were', 'is', 'are', 'about', 'for', 'with', 'that', 'this',
])

export interface AskCitation {
  index: number
  start: string
  speaker: string
  text: string
}

export interface AskResult {
  answer: string
  found: boolean
  citations: AskCitation[]
}

type Complete = (messages: { role: 'system' | 'user'; content: string }[]) => Promise<unknown>

function words(text: string): string[] {
  return text.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((word) => word.length > 2 && !STOPWORDS.has(word))
}

function speakerLabel(segment: TranscriptSegment, names: Record<string, string>): string {
  return names[segment.speaker]?.trim() || segment.speaker
}

export function selectContext(segments: TranscriptSegment[], question: string, names: Record<string, string> = {}, maxChars = MAX_CONTEXT_CHARS): number[] {
  const sizes = segments.map((segment) => segment.text.length + speakerLabel(segment, names).length + 16)
  const total = sizes.reduce((sum, size) => sum + size, 0)
  if (total <= maxChars) return segments.map((_, index) => index)

  const wanted = new Set(words(question))
  const scored = segments
    .map((segment, index) => {
      const haystack = new Set(words(`${speakerLabel(segment, names)} ${segment.text}`))
      let score = 0
      for (const word of wanted) if (haystack.has(word)) score += 1
      for (const word of wanted) if (word.length >= 5 && [...haystack].some((other) => other.startsWith(word.slice(0, 5)))) score += 0.3
      return { index, score }
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)

  const picked = new Set<number>()
  let used = 0
  const add = (index: number) => {
    if (index < 0 || index >= segments.length || picked.has(index)) return true
    if (used + sizes[index]! > maxChars) return false
    picked.add(index)
    used += sizes[index]!
    return true
  }
  for (const { index } of scored) {
    if (!add(index)) break
    for (let offset = 1; offset <= NEIGHBORS; offset++) {
      add(index - offset)
      add(index + offset)
    }
  }
  for (let index = 0; index < segments.length && used < maxChars * 0.15; index++) add(index)
  return [...picked].sort((a, b) => a - b)
}

const answerSchema = z.object({
  answer: z.string().max(4000),
  found: z.boolean().optional(),
  citations: z.array(z.union([z.number(), z.string()])).max(20).optional(),
})

const SYSTEM = `Kamu asisten yang menjawab pertanyaan tentang SATU rapat, hanya berdasarkan transkrip yang diberikan.
ATURAN:
1. Jawab dalam Bahasa Indonesia yang santai dan jelas, maksimal 5 kalimat. Pakai daftar singkat kalau jawabannya berupa beberapa poin.
2. Hanya pakai informasi dari transkrip. Jangan menebak atau menambah fakta.
3. Kalau transkrip tidak memuat jawabannya, katakan terus terang bahwa hal itu tidak dibahas di rapat, dan isi "found": false.
4. Sebut nomor segmen yang kamu pakai di "citations" (maksimal ${MAX_CITATIONS}), urut dari yang paling relevan.
5. Jangan menulis nomor segmen di dalam teks jawaban.
OUTPUT JSON: {"answer": "...", "found": true, "citations": [12, 15]}`

export async function askMeeting(input: {
  segments: TranscriptSegment[]
  question: string
  speakerNames?: Record<string, string>
  title?: string | null
  summary?: string | null
  complete: Complete
}): Promise<AskResult> {
  const names = input.speakerNames ?? {}
  const indices = selectContext(input.segments, input.question, names)
  const allowed = new Set(indices)
  const transcript = indices
    .map((index) => {
      const segment = input.segments[index]!
      return `[${index}] ${segment.start} ${speakerLabel(segment, names)}: ${segment.text}`
    })
    .join('\n')
  const context = [
    input.title ? `Judul rapat: ${input.title}` : '',
    input.summary ? `Ringkasan rapat:\n${input.summary.slice(0, 3000)}` : '',
    indices.length < input.segments.length ? 'Catatan: hanya bagian transkrip yang relevan yang disertakan.' : '',
    `Transkrip (format: [nomor] jam pembicara: ucapan):\n${transcript}`,
  ].filter(Boolean).join('\n\n')

  const raw = await input.complete([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `${context}\n\nPertanyaan: ${input.question}` },
  ])
  const parsed = answerSchema.safeParse(raw)
  if (!parsed.success || !parsed.data.answer.trim()) throw new Error('Jawaban AI tidak valid')

  const seen = new Set<number>()
  const citations: AskCitation[] = []
  for (const value of parsed.data.citations ?? []) {
    const index = typeof value === 'number' ? value : Number(String(value).replace(/[^\d]/g, ''))
    if (!Number.isInteger(index) || !allowed.has(index) || seen.has(index)) continue
    seen.add(index)
    const segment = input.segments[index]!
    citations.push({ index, start: segment.start, speaker: speakerLabel(segment, names), text: segment.text.slice(0, 240) })
    if (citations.length >= MAX_CITATIONS) break
  }

  const answer = parsed.data.answer.replace(/\s*\[\d+\]/g, '').trim()
  return { answer, found: parsed.data.found !== false && citations.length > 0, citations }
}

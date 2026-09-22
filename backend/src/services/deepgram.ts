import type { TranscriptSegment } from '../db/schema.js'

type Language = 'id' | 'en' | 'auto'

const DEEPGRAM_BASE_URL = (process.env.DEEPGRAM_BASE_URL ?? 'https://api.deepgram.com/v1').replace(/\/+$/, '')
const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL ?? 'nova-3'
const DEEPGRAM_MAX_RETRIES = Number(process.env.DEEPGRAM_MAX_RETRIES ?? 3)
const DEEPGRAM_TIMEOUT_MS = Number(process.env.DEEPGRAM_TIMEOUT_MS ?? 30 * 60 * 1000)
const SEGMENT_GAP_SEC = 2

interface DeepgramUtterance {
  start?: number
  end?: number
  transcript?: string
  speaker?: number
}

interface DeepgramResponse {
  metadata?: { duration?: number }
  results?: {
    channels?: Array<{
      detected_language?: string
      alternatives?: Array<{ transcript?: string }>
    }>
    utterances?: DeepgramUtterance[]
  }
}

function deepgramKey(): string {
  const key = process.env.DEEPGRAM_API_KEY
  if (!key) throw new Error('DEEPGRAM_API_KEY is required')
  return key
}

export function hasDeepgramKey(): boolean {
  return Boolean(process.env.DEEPGRAM_API_KEY)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599)
}

function formatTimestamp(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function languageParam(language: Language): string {
  if (language === 'id') return 'id'
  if (language === 'en') return 'en'
  return process.env.DEEPGRAM_AUTO_LANGUAGE ?? 'multi'
}

function buildUrl(language: Language): string {
  const params = new URLSearchParams({
    model: DEEPGRAM_MODEL,
    language: languageParam(language),
    diarize: 'true',
    punctuate: 'true',
    smart_format: 'true',
    utterances: 'true',
  })
  return `${DEEPGRAM_BASE_URL}/listen?${params.toString()}`
}

export function utterancesToSegments(utterances: DeepgramUtterance[]): TranscriptSegment[] {
  const usable = utterances
    .map((u) => ({
      start: u.start ?? 0,
      end: u.end ?? u.start ?? 0,
      speaker: u.speaker ?? 0,
      text: (u.transcript ?? '').trim(),
    }))
    .filter((u) => u.text.length > 0)
    .sort((a, b) => a.start - b.start)

  if (usable.length === 0) return []

  const segments: TranscriptSegment[] = []
  let current = { ...usable[0], parts: [usable[0].text] }

  const flush = () => {
    segments.push({
      start: formatTimestamp(current.start),
      end: formatTimestamp(current.end),
      speaker: `Speaker ${current.speaker + 1}`,
      text: current.parts.join(' ').trim(),
    })
  }

  for (let i = 1; i < usable.length; i++) {
    const next = usable[i]
    if (next.speaker === current.speaker && next.start - current.end <= SEGMENT_GAP_SEC) {
      current.end = Math.max(current.end, next.end)
      current.parts.push(next.text)
      continue
    }
    flush()
    current = { ...next, parts: [next.text] }
  }

  flush()
  return segments.filter((s) => s.text.length > 0)
}

async function requestTranscript(audioUrl: string, language: Language): Promise<DeepgramResponse> {
  let lastErr: unknown = null

  for (let attempt = 0; attempt <= DEEPGRAM_MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(Math.min(2000 * 2 ** (attempt - 1), 20000))

    let res: Response
    try {
      res = await fetch(buildUrl(language), {
        method: 'POST',
        headers: {
          Authorization: `Token ${deepgramKey()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: audioUrl }),
        signal: AbortSignal.timeout(DEEPGRAM_TIMEOUT_MS),
      })
    } catch (err) {
      lastErr = err
      continue
    }

    const text = await res.text()
    let parsed: DeepgramResponse
    try {
      parsed = JSON.parse(text) as DeepgramResponse
    } catch {
      lastErr = new Error(`Deepgram returned non JSON (${res.status}): ${text.slice(0, 300)}`)
      if (!isTransientStatus(res.status)) throw lastErr
      continue
    }

    if (res.ok) return parsed

    lastErr = new Error(`Deepgram failed (${res.status}): ${text.slice(0, 300)}`)
    if (!isTransientStatus(res.status)) throw lastErr
  }

  throw lastErr instanceof Error ? lastErr : new Error('Deepgram failed after retries')
}

export async function transcribeFromUrl(args: {
  audioUrl: string
  language: Language
  onProgress?: (step: string) => void
}): Promise<{ segments: TranscriptSegment[]; detectedLanguage: string | undefined; durationSec: number }> {
  args.onProgress?.('Transcribing audio...')

  const result = await requestTranscript(args.audioUrl, args.language)
  args.onProgress?.('Processing speaker labels...')

  const utterances = result.results?.utterances ?? []
  const segments = utterancesToSegments(utterances)

  if (segments.length === 0) throw new Error('Deepgram returned empty transcript')

  const lastEnd = utterances.reduce((max, u) => Math.max(max, u.end ?? 0), 0)
  const durationSec = Math.ceil(result.metadata?.duration && result.metadata.duration > 0 ? result.metadata.duration : lastEnd)
  const detectedLanguage = result.results?.channels?.[0]?.detected_language

  console.log(
    `Deepgram returned ${utterances.length} utterance(s) across ${new Set(utterances.map((u) => u.speaker ?? 0)).size} speaker(s)`
  )

  return { segments, detectedLanguage, durationSec }
}

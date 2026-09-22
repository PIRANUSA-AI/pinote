import type { TranscriptPayload, TranscriptSegment } from '../db/schema.js'

type Language = 'id' | 'en' | 'auto'

const QWEN_ASR_BASE_URL = (process.env.QWEN_ASR_BASE_URL ?? 'https://dashscope-intl.aliyuncs.com/api/v1').replace(/\/+$/, '')
const QWEN_ASR_MODEL = process.env.QWEN_ASR_MODEL ?? 'qwen-audio-3.0-asr-flash-filetrans'
const QWEN_MAX_RETRIES = Number(process.env.QWEN_MAX_RETRIES ?? 3)
const POLL_INTERVAL_MS = Number(process.env.QWEN_POLL_INTERVAL_MS ?? 5000)
const POLL_TIMEOUT_MS = Number(process.env.QWEN_POLL_TIMEOUT_MS ?? 3 * 60 * 60 * 1000)
const SEGMENT_GAP_SEC = 2

interface QwenWord {
  begin_time?: number
  end_time?: number
  text?: string
  punctuation?: string
}

interface QwenSentence {
  begin_time?: number
  end_time?: number
  text?: string
  speaker_id?: number
  language?: string
  words?: QwenWord[]
}

interface QwenTranscriptionResult {
  properties?: {
    original_duration_in_milliseconds?: number
  }
  transcripts?: Array<{
    channel_id?: number
    text?: string
    language?: string
    sentences?: QwenSentence[]
  }>
}

interface QwenTaskResponse {
  code?: string
  message?: string
  output?: {
    task_id?: string
    task_status?: string
    code?: string
    message?: string
    results?: Array<{
      transcription_url?: string
      subtask_status?: string
      code?: string
      message?: string
    }>
  }
}

function qwenKey(): string {
  const key = process.env.QWEN_API_KEY
  if (!key) throw new Error('QWEN_API_KEY is required')
  return key
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

export function normalizeDetectedLanguage(language: string | undefined): TranscriptPayload['language'] {
  if (!language) return 'mixed'
  const lower = language.toLowerCase()
  if (lower.startsWith('id')) return 'id'
  if (lower.startsWith('en')) return 'en'
  return 'mixed'
}

function languageHints(language: Language): string[] | undefined {
  if (language === 'id') return ['id']
  if (language === 'en') return ['en']
  return undefined
}

function sentenceText(sentence: QwenSentence): string {
  const direct = (sentence.text ?? '').trim()
  if (direct) return direct
  const words = sentence.words ?? []
  return words
    .map((w) => `${w.text ?? ''}${w.punctuation ?? ''}`)
    .join('')
    .trim()
}

export function sentencesToSegments(sentences: QwenSentence[]): TranscriptSegment[] {
  const usable = sentences
    .map((s) => ({
      start: (s.begin_time ?? 0) / 1000,
      end: (s.end_time ?? s.begin_time ?? 0) / 1000,
      speaker: s.speaker_id ?? 0,
      text: sentenceText(s),
    }))
    .filter((s) => s.text.length > 0)
    .sort((a, b) => a.start - b.start)

  if (usable.length === 0) return []

  const segments: TranscriptSegment[] = []
  let current = { ...usable[0], parts: [usable[0].text] }

  for (let i = 1; i < usable.length; i++) {
    const next = usable[i]
    const sameSpeaker = next.speaker === current.speaker
    const gap = next.start - current.end

    if (sameSpeaker && gap <= SEGMENT_GAP_SEC) {
      current.end = Math.max(current.end, next.end)
      current.parts.push(next.text)
      continue
    }

    segments.push({
      start: formatTimestamp(current.start),
      end: formatTimestamp(current.end),
      speaker: `Speaker ${current.speaker + 1}`,
      text: current.parts.join(' ').trim(),
    })
    current = { ...next, parts: [next.text] }
  }

  segments.push({
    start: formatTimestamp(current.start),
    end: formatTimestamp(current.end),
    speaker: `Speaker ${current.speaker + 1}`,
    text: current.parts.join(' ').trim(),
  })

  return segments.filter((s) => s.text.length > 0)
}

async function submitTask(audioUrl: string, language: Language): Promise<string> {
  const hints = languageHints(language)
  const body = {
    model: QWEN_ASR_MODEL,
    input: { file_urls: [audioUrl] },
    parameters: {
      diarization_enabled: true,
      enable_words: true,
      ...(hints ? { language_hints: hints } : {}),
    },
  }

  let lastErr: unknown = null

  for (let attempt = 0; attempt <= QWEN_MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(Math.min(2000 * 2 ** (attempt - 1), 20000))

    let res: Response
    try {
      res = await fetch(`${QWEN_ASR_BASE_URL}/services/audio/asr/transcription`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${qwenKey()}`,
          'Content-Type': 'application/json',
          'X-DashScope-Async': 'enable',
        },
        body: JSON.stringify(body),
      })
    } catch (err) {
      lastErr = err
      continue
    }

    const text = await res.text()
    let parsed: QwenTaskResponse
    try {
      parsed = JSON.parse(text) as QwenTaskResponse
    } catch {
      lastErr = new Error(`Qwen submit returned non JSON (${res.status}): ${text.slice(0, 300)}`)
      if (!isTransientStatus(res.status)) throw lastErr
      continue
    }

    const taskId = parsed.output?.task_id
    if (res.ok && taskId) return taskId

    lastErr = new Error(`Qwen submit failed (${res.status}): ${parsed.code ?? ''} ${parsed.message ?? text.slice(0, 300)}`)
    if (!isTransientStatus(res.status)) throw lastErr
  }

  throw lastErr instanceof Error ? lastErr : new Error('Qwen submit failed after retries')
}

async function waitForTask(taskId: string, onProgress?: (step: string) => void): Promise<string> {
  const startedAt = Date.now()
  let lastStatus = ''

  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS)

    let res: Response
    try {
      res = await fetch(`${QWEN_ASR_BASE_URL}/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${qwenKey()}` },
      })
    } catch {
      continue
    }

    if (!res.ok) {
      if (isTransientStatus(res.status)) continue
      throw new Error(`Qwen task poll failed (${res.status})`)
    }

    const parsed = (await res.json()) as QwenTaskResponse
    const status = parsed.output?.task_status ?? ''

    if (status !== lastStatus) {
      lastStatus = status
      if (status === 'RUNNING') onProgress?.('Transcribing audio...')
    }

    if (status === 'SUCCEEDED') {
      const result = parsed.output?.results?.find((r) => r.transcription_url)
      if (!result?.transcription_url) {
        const failure = parsed.output?.results?.find((r) => r.subtask_status === 'FAILED')
        throw new Error(`Qwen task succeeded without transcript: ${failure?.message ?? 'no transcription url'}`)
      }
      return result.transcription_url
    }

    if (status === 'FAILED' || status === 'CANCELED') {
      const detail = parsed.output?.message ?? parsed.output?.results?.[0]?.message ?? 'unknown error'
      throw new Error(`Qwen transcription failed: ${parsed.output?.code ?? status}: ${detail}`)
    }
  }

  throw new Error(`Qwen transcription timed out after ${Math.round(POLL_TIMEOUT_MS / 60000)} minutes`)
}

async function fetchTranscript(transcriptionUrl: string): Promise<QwenTranscriptionResult> {
  const res = await fetch(transcriptionUrl)
  if (!res.ok) throw new Error(`Failed to download Qwen transcript (${res.status})`)
  return (await res.json()) as QwenTranscriptionResult
}

export async function transcribeFromUrl(args: {
  audioUrl: string
  language: Language
  onProgress?: (step: string) => void
}): Promise<{ segments: TranscriptSegment[]; detectedLanguage: string | undefined; durationSec: number }> {
  args.onProgress?.('Transcribing audio...')

  const taskId = await submitTask(args.audioUrl, args.language)
  console.log(`Qwen task ${taskId} submitted with model ${QWEN_ASR_MODEL}`)

  const transcriptionUrl = await waitForTask(taskId, args.onProgress)
  args.onProgress?.('Processing speaker labels...')

  const result = await fetchTranscript(transcriptionUrl)
  const transcript = result.transcripts?.[0]
  const sentences = transcript?.sentences ?? []
  const segments = sentencesToSegments(sentences)

  if (segments.length === 0) throw new Error('Qwen returned empty transcript')

  const durationMs = result.properties?.original_duration_in_milliseconds
  const lastEndMs = sentences.reduce((max, s) => Math.max(max, s.end_time ?? 0), 0)
  const durationSec = Math.ceil((durationMs && durationMs > 0 ? durationMs : lastEndMs) / 1000)

  const detectedLanguage = transcript?.language ?? sentences.find((s) => s.language)?.language

  console.log(`Qwen returned ${sentences.length} sentences across ${new Set(sentences.map((s) => s.speaker_id ?? 0)).size} speaker(s)`)

  return { segments, detectedLanguage, durationSec }
}

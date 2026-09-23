import WebSocket from 'ws'
import type { LiveTranscriptionHandlers } from './openaiRealtime.js'

const DEEPGRAM_LIVE_URL = process.env.DEEPGRAM_LIVE_URL ?? 'wss://api.deepgram.com/v1/listen'
const DEEPGRAM_LIVE_MODEL = process.env.DEEPGRAM_LIVE_MODEL ?? 'nova-3'
const KEEPALIVE_MS = Number(process.env.DEEPGRAM_KEEPALIVE_MS ?? 5000)
const ENDPOINTING_MS = Number(process.env.DEEPGRAM_ENDPOINTING_MS ?? 300)
const UTTERANCE_END_MS = Number(process.env.DEEPGRAM_UTTERANCE_END_MS ?? 1000)
const MAX_PENDING = 400

const FOREIGN_SCRIPT = /[Ѐ-ӿ؀-ۿ฀-๿぀-ヿ一-鿿가-힯]/g

function mostlyForeign(text: string): boolean {
  const foreign = text.match(FOREIGN_SCRIPT)
  if (!foreign) return false
  const letters = text.replace(/[\s\d.,!?;:'"()[\]{}]/g, '')
  if (letters.length === 0) return true
  return foreign.length / letters.length > 0.3
}

interface DeepgramEvent {
  type?: string
  is_final?: boolean
  speech_final?: boolean
  from_finalize?: boolean
  start?: number
  duration?: number
  channel?: { alternatives?: Array<{ transcript?: string }> }
  err_msg?: string
  description?: string
  message?: string
}

interface TagSpan {
  tag: string | null
  from: number
}

export class DeepgramLiveSession {
  private socket: WebSocket | null = null
  private ready = false
  private closed = false
  private pending: Buffer[] = []
  private keepAlive: NodeJS.Timeout | null = null
  private bytesSent = 0
  private spans: TagSpan[] = [{ tag: null, from: 0 }]
  private utterance: { tag: string | null; parts: string[] } = { tag: null, parts: [] }

  constructor(
    private readonly language: 'id' | 'en' | 'auto',
    private readonly handlers: LiveTranscriptionHandlers,
    private readonly sampleRate: number
  ) {}

  connect(): void {
    const key = process.env.DEEPGRAM_API_KEY
    if (!key) {
      this.handlers.onError('DEEPGRAM_API_KEY is required')
      return
    }

    const params = new URLSearchParams({
      model: DEEPGRAM_LIVE_MODEL,
      language: this.language === 'auto' ? 'multi' : this.language,
      encoding: 'linear16',
      sample_rate: String(this.sampleRate),
      channels: '1',
      interim_results: 'true',
      punctuate: 'true',
      smart_format: 'true',
      endpointing: String(ENDPOINTING_MS),
      utterance_end_ms: String(UTTERANCE_END_MS),
    })

    const socket = new WebSocket(`${DEEPGRAM_LIVE_URL}?${params.toString()}`, {
      headers: { Authorization: `Token ${key}` },
    })
    this.socket = socket

    socket.on('open', () => {
      this.ready = true
      for (const chunk of this.pending) this.writeAudio(chunk)
      this.pending = []
      this.keepAlive = setInterval(() => this.sendControl('KeepAlive'), KEEPALIVE_MS)
      this.handlers.onReady()
    })

    socket.on('unexpected-response', (_request, response) => {
      this.handlers.onError(`Deepgram menolak koneksi (${response.statusCode ?? 0})`)
    })

    socket.on('message', (raw, isBinary) => {
      if (!isBinary) this.handleMessage(raw.toString())
    })

    socket.on('error', (err) => {
      this.handlers.onError(err instanceof Error ? err.message : String(err))
    })

    socket.on('close', () => {
      if (this.socket !== socket) return
      this.emitUtterance()
      this.stopKeepAlive()
      this.closed = true
      this.handlers.onClose()
    })
  }

  private audioSeconds(): number {
    return this.bytesSent / (this.sampleRate * 2)
  }

  private tagAt(seconds: number): string | null {
    let tag = this.spans[0]?.tag ?? null
    for (const span of this.spans) {
      if (span.from > seconds) break
      tag = span.tag
    }
    return tag
  }

  private emitUtterance(): void {
    const text = this.utterance.parts.join(' ').replace(/\s+/g, ' ').trim()
    const tag = this.utterance.tag
    this.utterance = { tag: null, parts: [] }
    if (!text) return
    if (this.language !== 'auto' && mostlyForeign(text)) {
      console.warn(`Live transcript dibuang karena bukan bahasa ${this.language}: ${text.slice(0, 60)}`)
      return
    }
    this.handlers.onFinal(text, tag)
  }

  private handleMessage(payload: string): void {
    let event: DeepgramEvent
    try {
      event = JSON.parse(payload)
    } catch {
      return
    }

    if (event.type === 'UtteranceEnd') {
      this.emitUtterance()
      return
    }

    if (event.type === 'Error') {
      this.handlers.onError(event.description ?? event.err_msg ?? event.message ?? 'Deepgram live error')
      return
    }

    if (event.type !== 'Results') return

    const transcript = (event.channel?.alternatives?.[0]?.transcript ?? '').trim()
    const start = event.start ?? this.audioSeconds()
    const tag = this.tagAt(start + (event.duration ?? 0) / 2)

    if (!event.is_final) {
      if (!transcript) return
      const preview = [...(this.utterance.tag === tag ? this.utterance.parts : []), transcript].join(' ')
      if (this.language === 'auto' || !mostlyForeign(preview)) this.handlers.onPartial(preview, tag)
      return
    }

    if (transcript) {
      if (this.utterance.parts.length > 0 && this.utterance.tag !== tag) this.emitUtterance()
      this.utterance.tag = tag
      this.utterance.parts.push(transcript)
    }

    if (event.speech_final || event.from_finalize) this.emitUtterance()
  }

  private sendControl(type: 'KeepAlive' | 'Finalize' | 'CloseStream'): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type }))
  }

  private writeAudio(chunk: Buffer): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return
    this.socket.send(chunk)
    this.bytesSent += chunk.length
  }

  private stopKeepAlive(): void {
    if (this.keepAlive) clearInterval(this.keepAlive)
    this.keepAlive = null
  }

  sendAudio(chunk: Buffer): void {
    if (this.closed) return
    if (!this.ready) {
      if (this.pending.length < MAX_PENDING) this.pending.push(chunk)
      return
    }
    this.writeAudio(chunk)
  }

  flush(): void {
    this.sendControl('Finalize')
  }

  setTag(tag: string | null): void {
    const last = this.spans[this.spans.length - 1]
    if (last && last.tag === tag) return
    const pendingSeconds = this.pending.reduce((sum, chunk) => sum + chunk.length, 0) / (this.sampleRate * 2)
    this.sendControl('Finalize')
    this.spans.push({ tag, from: this.audioSeconds() + pendingSeconds })
    if (this.spans.length > 500) this.spans.splice(1, this.spans.length - 500)
  }

  finish(): void {
    this.sendControl('Finalize')
  }

  close(): void {
    this.stopKeepAlive()
    this.emitUtterance()
    this.sendControl('CloseStream')
    this.closed = true
    this.pending = []
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) this.socket.close()
    this.socket = null
  }
}

import WebSocket from 'ws'

const OPENAI_REALTIME_URL = process.env.OPENAI_REALTIME_URL ?? 'wss://api.openai.com/v1/realtime?intent=transcription'
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL ?? 'gpt-live-transcribe'
const SILENCE_MS = Number(process.env.OPENAI_REALTIME_SILENCE_MS ?? 900)

export const LIVE_SAMPLE_RATE = Number(process.env.OPENAI_REALTIME_SAMPLE_RATE ?? 24000)

export interface LiveTranscriptionHandlers {
  onReady: () => void
  onPartial: (text: string) => void
  onFinal: (text: string) => void
  onError: (message: string) => void
  onClose: () => void
}

interface RealtimeEvent {
  type?: string
  delta?: string
  transcript?: string
  item_id?: string
  error?: { message?: string }
  message?: string
}

export class OpenAiRealtimeSession {
  private socket: WebSocket | null = null
  private ready = false
  private pending: string[] = []
  private closed = false
  private retriedWithBeta = false
  private partials = new Map<string, string>()

  constructor(
    private readonly language: 'id' | 'en' | 'auto',
    private readonly handlers: LiveTranscriptionHandlers,
    private readonly sampleRate: number = LIVE_SAMPLE_RATE
  ) {}

  connect(): void {
    const key = process.env.OPENAI_API_KEY
    if (!key) {
      this.handlers.onError('OPENAI_API_KEY is required')
      return
    }
    this.open(key, this.retriedWithBeta)
  }

  private open(key: string, withBeta: boolean): void {
    const headers: Record<string, string> = { Authorization: `Bearer ${key}` }
    if (withBeta) headers['OpenAI-Beta'] = 'realtime=v1'

    const socket = new WebSocket(OPENAI_REALTIME_URL, { headers })
    this.socket = socket

    socket.on('unexpected-response', (_request, response) => {
      if (!this.retriedWithBeta && !this.closed) {
        this.retriedWithBeta = true
        socket.removeAllListeners()
        socket.terminate()
        this.open(key, true)
        return
      }
      this.handlers.onError(`OpenAI realtime menolak koneksi (${response.statusCode ?? 0})`)
    })

    socket.on('open', () => {
      this.sendSessionUpdate()
    })

    socket.on('message', (raw) => {
      this.handleUpstreamMessage(raw.toString())
    })

    socket.on('error', (err) => {
      if (this.retriedWithBeta || this.closed) {
        this.handlers.onError(err instanceof Error ? err.message : String(err))
      }
    })

    socket.on('close', () => {
      if (this.socket !== socket) return
      this.closed = true
      this.handlers.onClose()
    })
  }

  private sendSessionUpdate(): void {
    const transcription: Record<string, unknown> = { model: OPENAI_REALTIME_MODEL }
    if (this.language !== 'auto') transcription.languages = [this.language]

    this.rawSend(
      JSON.stringify({
        type: 'session.update',
        session: {
          type: 'transcription',
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: this.sampleRate },
              transcription,
              turn_detection: { type: 'server_vad', silence_duration_ms: SILENCE_MS },
            },
          },
        },
      })
    )
  }

  private handleUpstreamMessage(payload: string): void {
    let event: RealtimeEvent
    try {
      event = JSON.parse(payload)
    } catch {
      return
    }

    switch (event.type) {
      case 'session.created':
      case 'transcription_session.created':
      case 'session.updated':
      case 'transcription_session.updated':
        this.markReady()
        return
      case 'conversation.item.input_audio_transcription.delta': {
        const key = event.item_id ?? 'current'
        const text = `${this.partials.get(key) ?? ''}${event.delta ?? ''}`
        this.partials.set(key, text)
        if (text.trim()) this.handlers.onPartial(text.trim())
        return
      }
      case 'conversation.item.input_audio_transcription.completed': {
        this.partials.delete(event.item_id ?? 'current')
        const text = (event.transcript ?? '').trim()
        if (text) this.handlers.onFinal(text)
        return
      }
      case 'error':
        this.handlers.onError(event.error?.message ?? event.message ?? 'OpenAI realtime error')
        return
      default:
        return
    }
  }

  private markReady(): void {
    if (this.ready) return
    this.ready = true
    this.flushPending()
    this.handlers.onReady()
  }

  private rawSend(payload: string): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) this.socket.send(payload)
  }

  private flushPending(): void {
    for (const payload of this.pending) this.rawSend(payload)
    this.pending = []
  }

  sendAudio(chunk: Buffer): void {
    if (this.closed) return
    const payload = JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: chunk.toString('base64'),
    })
    if (!this.ready) {
      if (this.pending.length < 200) this.pending.push(payload)
      return
    }
    this.rawSend(payload)
  }

  finish(): void {
    if (this.closed || !this.ready) return
    this.rawSend(JSON.stringify({ type: 'input_audio_buffer.commit' }))
  }

  close(): void {
    this.closed = true
    this.pending = []
    this.partials.clear()
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) this.socket.close()
    this.socket = null
  }
}

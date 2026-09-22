import WebSocket from 'ws'

const QWEN_REALTIME_URL = process.env.QWEN_REALTIME_URL ?? 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime'
const QWEN_REALTIME_MODEL = process.env.QWEN_REALTIME_MODEL ?? 'qwen3-asr-flash-realtime'
const SAMPLE_RATE = 16000
const SILENCE_MS = Number(process.env.QWEN_REALTIME_SILENCE_MS ?? 400)

export interface QwenRealtimeHandlers {
  onReady: () => void
  onPartial: (text: string) => void
  onFinal: (text: string) => void
  onError: (message: string) => void
  onClose: () => void
}

export class QwenRealtimeSession {
  private socket: WebSocket | null = null
  private ready = false
  private pending: string[] = []
  private closed = false

  constructor(
    private readonly language: 'id' | 'en' | 'auto',
    private readonly handlers: QwenRealtimeHandlers
  ) {}

  connect(): void {
    const key = process.env.QWEN_API_KEY
    if (!key) {
      this.handlers.onError('QWEN_API_KEY is required')
      return
    }

    const url = `${QWEN_REALTIME_URL}?model=${encodeURIComponent(QWEN_REALTIME_MODEL)}`
    this.socket = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${key}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    })

    this.socket.on('open', () => {})

    this.socket.on('message', (raw) => {
      this.handleUpstreamMessage(raw.toString())
    })

    this.socket.on('error', (err) => {
      this.handlers.onError(err instanceof Error ? err.message : String(err))
    })

    this.socket.on('close', () => {
      this.closed = true
      this.handlers.onClose()
    })
  }

  private sendSessionUpdate(): void {
    const session: Record<string, unknown> = {
      modalities: ['text'],
      input_audio_format: 'pcm',
      sample_rate: SAMPLE_RATE,
      turn_detection: { type: 'server_vad', silence_duration_ms: SILENCE_MS },
    }
    if (this.language !== 'auto') {
      session.input_audio_transcription = { model: QWEN_REALTIME_MODEL, language: this.language }
    }
    this.rawSend(JSON.stringify({ type: 'session.update', session }))
  }

  private handleUpstreamMessage(payload: string): void {
    let event: { type?: string; text?: string; transcript?: string; error?: { message?: string }; message?: string }
    try {
      event = JSON.parse(payload)
    } catch {
      return
    }

    switch (event.type) {
      case 'session.created':
        this.sendSessionUpdate()
        this.markReady()
        return
      case 'session.updated':
        this.markReady()
        return
      case 'conversation.item.input_audio_transcription.text': {
        const text = (event.text ?? '').trim()
        if (text) this.handlers.onPartial(text)
        return
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const text = (event.transcript ?? '').trim()
        if (text) this.handlers.onFinal(text)
        return
      }
      case 'error':
        this.handlers.onError(event.error?.message ?? event.message ?? 'Qwen realtime error')
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
    if (this.closed) return
    this.rawSend(JSON.stringify({ type: 'session.finish' }))
  }

  close(): void {
    this.closed = true
    this.pending = []
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) this.socket.close()
    this.socket = null
  }
}

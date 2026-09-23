import WebSocket from 'ws'
import type { LiveTranscriptionHandlers } from './openaiRealtime.js'

const QWEN_REALTIME_URL = process.env.QWEN_REALTIME_URL ?? 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime'
const QWEN_REALTIME_MODEL = process.env.QWEN_REALTIME_MODEL ?? 'qwen3-asr-flash-realtime'
const QWEN_SAMPLE_RATE = 16000
const SILENCE_MS = Number(process.env.QWEN_REALTIME_SILENCE_MS ?? 400)
const MAX_PENDING = 400

export function resampleLinear16(chunk: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) return chunk
  const input = new Int16Array(chunk.buffer, chunk.byteOffset, Math.floor(chunk.length / 2))
  const length = Math.floor(input.length * toRate / fromRate)
  const output = new Int16Array(length)
  const step = fromRate / toRate
  for (let i = 0; i < length; i++) {
    const position = i * step
    const index = Math.floor(position)
    const next = Math.min(index + 1, input.length - 1)
    const fraction = position - index
    output[i] = Math.round((input[index] ?? 0) * (1 - fraction) + (input[next] ?? 0) * fraction)
  }
  return Buffer.from(output.buffer, output.byteOffset, output.byteLength)
}

interface QwenEvent {
  type?: string
  text?: string
  stash?: string
  transcript?: string
  error?: { message?: string }
  message?: string
}

export class QwenRealtimeSession {
  private socket: WebSocket | null = null
  private ready = false
  private pending: string[] = []
  private closed = false
  private currentTag: string | null = null
  private turnTag: string | null = null

  constructor(
    private readonly language: string,
    private readonly handlers: LiveTranscriptionHandlers,
    private readonly sampleRate: number = QWEN_SAMPLE_RATE
  ) {}

  connect(): void {
    const key = process.env.QWEN_API_KEY
    if (!key) {
      this.handlers.onError('QWEN_API_KEY is required')
      return
    }

    const url = `${QWEN_REALTIME_URL}?model=${encodeURIComponent(QWEN_REALTIME_MODEL)}`
    const socket = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${key}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    })
    this.socket = socket

    socket.on('message', (raw) => this.handleUpstreamMessage(raw.toString()))
    socket.on('unexpected-response', (_request, response) => {
      this.handlers.onError(`Qwen menolak koneksi (${response.statusCode ?? 0})`)
    })
    socket.on('error', (err) => this.handlers.onError(err instanceof Error ? err.message : String(err)))
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.closed = true
      this.handlers.onClose()
    })
  }

  private sendSessionUpdate(): void {
    const transcription: Record<string, unknown> = { model: QWEN_REALTIME_MODEL }
    const primary = this.language.split('-')[0]?.toLowerCase()
    if (this.language !== 'auto' && primary) transcription.language = primary
    const session: Record<string, unknown> = {
      modalities: ['text'],
      input_audio_format: 'pcm',
      sample_rate: QWEN_SAMPLE_RATE,
      input_audio_transcription: transcription,
      turn_detection: { type: 'server_vad', silence_duration_ms: SILENCE_MS },
    }
    this.rawSend(JSON.stringify({ type: 'session.update', session }))
  }

  private handleUpstreamMessage(payload: string): void {
    let event: QwenEvent
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
      case 'input_audio_buffer.speech_started':
        this.turnTag = this.currentTag
        return
      case 'conversation.item.input_audio_transcription.text': {
        const text = `${event.text ?? ''}${event.stash ?? ''}`.trim()
        if (!text) return
        this.turnTag ??= this.currentTag
        this.handlers.onPartial(text, this.turnTag)
        return
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const text = (event.transcript ?? '').trim()
        const tag = this.turnTag ?? this.currentTag
        this.turnTag = null
        if (text) this.handlers.onFinal(text, tag)
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
    for (const payload of this.pending) this.rawSend(payload)
    this.pending = []
    this.handlers.onReady()
  }

  private rawSend(payload: string): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) this.socket.send(payload)
  }

  sendAudio(chunk: Buffer): void {
    if (this.closed) return
    const audio = resampleLinear16(chunk, this.sampleRate, QWEN_SAMPLE_RATE)
    const payload = JSON.stringify({ type: 'input_audio_buffer.append', audio: audio.toString('base64') })
    if (!this.ready) {
      if (this.pending.length < MAX_PENDING) this.pending.push(payload)
      return
    }
    this.rawSend(payload)
  }

  flush(): void {
    return
  }

  setTag(tag: string | null): void {
    if (tag === this.currentTag) return
    this.currentTag = tag
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

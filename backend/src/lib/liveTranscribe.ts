import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type { User } from '../db/schema.js'
import { findSession } from '../services/auth.js'
import { DeepgramLiveSession } from '../services/deepgramLive.js'
import { LIVE_SAMPLE_RATE, OpenAiRealtimeSession, type LiveTranscriptionHandlers } from '../services/openaiRealtime.js'

type LiveSession = OpenAiRealtimeSession | DeepgramLiveSession

function liveProvider(): 'deepgram' | 'openai' {
  const chosen = (process.env.LIVE_PROVIDER ?? '').trim().toLowerCase()
  if (chosen === 'deepgram' || chosen === 'openai') return chosen
  return process.env.DEEPGRAM_API_KEY ? 'deepgram' : 'openai'
}

function createLiveSession(language: 'id' | 'en' | 'auto', handlers: LiveTranscriptionHandlers, sampleRate: number): LiveSession {
  return liveProvider() === 'deepgram'
    ? new DeepgramLiveSession(language, handlers, sampleRate)
    : new OpenAiRealtimeSession(language, handlers, sampleRate)
}

const LIVE_PATH = '/live'
const BYTES_PER_SECOND = LIVE_SAMPLE_RATE * 2
const MAX_SESSION_BYTES = BYTES_PER_SECOND * 60 * 60 * 4
const MAX_SESSIONS_PER_USER = Number(process.env.LIVE_MAX_SESSIONS_PER_USER ?? 10)
const MAX_TAG_LENGTH = 600

const activeSessions = new Map<string, number>()

function allowedOrigins(): string[] {
  return (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    if (part.slice(0, index).trim() !== name) continue
    return decodeURIComponent(part.slice(index + 1).trim())
  }
  return null
}

function reject(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

function acquireSlot(userId: string): boolean {
  const current = activeSessions.get(userId) ?? 0
  if (current >= MAX_SESSIONS_PER_USER) return false
  activeSessions.set(userId, current + 1)
  return true
}

function releaseSlot(userId: string): void {
  const current = activeSessions.get(userId) ?? 0
  if (current <= 1) activeSessions.delete(userId)
  else activeSessions.set(userId, current - 1)
}

function handleConnection(ws: WebSocket, user: User): void {
  let session: LiveSession | null = null
  let streamedBytes = 0
  let settled = false

  const send = (payload: Record<string, unknown>) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload))
  }

  const settle = () => {
    if (settled) return
    settled = true
    session?.close()
    session = null
    releaseSlot(user.id)
    console.log(`Live session for ${user.id} ended after ${Math.ceil(streamedBytes / BYTES_PER_SECOND)}s of audio`)
  }

  const start = (language: 'id' | 'en' | 'auto', sampleRate: number) => {
    if (session) return
    session = createLiveSession(language, {
      onReady: () => send({ type: 'ready' }),
      onPartial: (text, tag) => send({ type: 'partial', text, tag }),
      onFinal: (text, tag) => send({ type: 'final', text, tag }),
      onError: (message) => send({ type: 'error', message }),
      onClose: () => send({ type: 'upstreamClosed' }),
    }, sampleRate)
    session.connect()
  }

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (!session) return
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
      streamedBytes += chunk.length
      if (streamedBytes > MAX_SESSION_BYTES) {
        send({ type: 'error', message: 'Batas durasi sesi realtime tercapai' })
        ws.close()
        return
      }
      session.sendAudio(chunk)
      return
    }

    let message: { type?: string; language?: string; sampleRate?: number; tag?: unknown }
    try {
      message = JSON.parse(data.toString())
    } catch {
      return
    }

    if (message.type === 'start') {
      const language = message.language === 'id' || message.language === 'en' ? message.language : 'auto'
      const requested = Number(message.sampleRate)
      const sampleRate = Number.isFinite(requested) && requested >= 8000 && requested <= 48000
        ? Math.round(requested)
        : LIVE_SAMPLE_RATE
      start(language, sampleRate)
      return
    }

    if (message.type === 'flush') {
      session?.flush()
      return
    }

    if (message.type === 'owner') {
      const tag = typeof message.tag === 'string' && message.tag.length > 0 && message.tag.length <= MAX_TAG_LENGTH ? message.tag : null
      session?.setTag(tag)
      return
    }

    if (message.type === 'stop') {
      session?.finish()
      return
    }
  })

  ws.on('close', settle)
  ws.on('error', settle)
}

export function attachLiveTranscribe(server: Server): void {
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const host = req.headers.host ?? 'localhost'
    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', `http://${host}`).pathname
    } catch {
      return reject(socket, 400, 'Bad Request')
    }

    if (pathname !== LIVE_PATH) return

    const origin = req.headers.origin
    if (origin && !allowedOrigins().includes(origin)) {
      console.warn('Live transcribe rejected origin', origin)
      return reject(socket, 403, 'Forbidden')
    }

    const token = readCookie(req.headers.cookie, 'session')
    if (!token) return reject(socket, 401, 'Unauthorized')

    findSession(token)
      .then((result) => {
        if (!result) return reject(socket, 401, 'Unauthorized')

        wss.handleUpgrade(req, socket, head, (ws) => {
          if (!acquireSlot(result.user.id)) {
            ws.send(JSON.stringify({
              type: 'error',
              message: `Maksimal ${MAX_SESSIONS_PER_USER} transkrip langsung berjalan bersamaan. Hentikan sesi lain dulu.`,
            }))
            ws.close(1008, 'Terlalu banyak sesi')
            return
          }
          handleConnection(ws, result.user)
        })
      })
      .catch((err) => {
        console.error('Live transcribe upgrade failed:', err)
        reject(socket, 500, 'Internal Server Error')
      })
  })
}

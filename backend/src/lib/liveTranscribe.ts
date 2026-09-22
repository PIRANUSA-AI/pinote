import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { eq, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { users, type User } from '../db/schema.js'
import { findSession } from '../services/auth.js'
import { QwenRealtimeSession } from '../services/qwenRealtime.js'

const LIVE_PATH = '/live'
const BYTES_PER_SECOND = 16000 * 2
const MAX_SESSION_BYTES = BYTES_PER_SECOND * 60 * 60 * 4

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

async function deductCredits(userId: string, seconds: number): Promise<void> {
  if (seconds <= 0) return
  await db
    .update(users)
    .set({ creditSeconds: sql`GREATEST(${users.creditSeconds} - ${seconds}, 0)` })
    .where(eq(users.id, userId))
    .catch((err) => console.warn('Live credit deduction failed:', err))
}

function handleConnection(ws: WebSocket, user: User): void {
  let session: QwenRealtimeSession | null = null
  let streamedBytes = 0
  let settled = false

  const send = (payload: Record<string, unknown>) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload))
  }

  const settle = async () => {
    if (settled) return
    settled = true
    session?.close()
    session = null
    await deductCredits(user.id, Math.ceil(streamedBytes / BYTES_PER_SECOND))
  }

  const start = (language: 'id' | 'en' | 'auto') => {
    if (session) return
    session = new QwenRealtimeSession(language, {
      onReady: () => send({ type: 'ready' }),
      onPartial: (text) => send({ type: 'partial', text }),
      onFinal: (text) => send({ type: 'final', text }),
      onError: (message) => send({ type: 'error', message }),
      onClose: () => send({ type: 'upstreamClosed' }),
    })
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

    let message: { type?: string; language?: string }
    try {
      message = JSON.parse(data.toString())
    } catch {
      return
    }

    if (message.type === 'start') {
      const language = message.language === 'id' || message.language === 'en' ? message.language : 'auto'
      start(language)
      return
    }

    if (message.type === 'stop') {
      session?.finish()
      return
    }
  })

  ws.on('close', () => {
    void settle()
  })

  ws.on('error', () => {
    void settle()
  })
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
        if (result.user.creditSeconds <= 0) return reject(socket, 402, 'Payment Required')

        wss.handleUpgrade(req, socket, head, (ws) => {
          handleConnection(ws, result.user)
        })
      })
      .catch((err) => {
        console.error('Live transcribe upgrade failed:', err)
        reject(socket, 500, 'Internal Server Error')
      })
  })
}

import { Hono } from 'hono'
import { Readable } from 'node:stream'
import { extname } from 'node:path'
import { verifyMediaSignature } from '../lib/mediaSignature.js'
import { createReadStreamForKey, statObject } from '../services/storage.js'

export const mediaRouter = new Hono()

const MIME_BY_EXTENSION: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
}

function mimeForKey(key: string): string {
  return MIME_BY_EXTENSION[extname(key).toLowerCase()] ?? 'application/octet-stream'
}

function parseRange(header: string | undefined, sizeBytes: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return 'invalid'

  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return 'invalid'

  let start: number
  let end: number
  if (rawStart === '') {
    const suffixLength = Number(rawEnd)
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return 'invalid'
    start = Math.max(0, sizeBytes - suffixLength)
    end = sizeBytes - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? sizeBytes - 1 : Number(rawEnd)
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid'
  if (start > end || start >= sizeBytes) return 'invalid'
  return { start, end: Math.min(end, sizeBytes - 1) }
}

mediaRouter.on(['GET', 'HEAD'], '/', async (c) => {
  const key = c.req.query('key')
  if (!verifyMediaSignature(key, c.req.query('exp'), c.req.query('sig'))) {
    return c.json({ error: 'Tautan media tidak valid atau sudah kedaluwarsa' }, 403)
  }

  const storageKey = key as string
  const info = await statObject(storageKey)
  if (!info) return c.json({ error: 'Media tidak ditemukan' }, 404)

  const contentType = mimeForKey(storageKey)
  const range = parseRange(c.req.header('range'), info.sizeBytes)

  if (range === 'invalid') {
    return new Response(null, {
      status: 416,
      headers: {
        'Content-Range': `bytes */${info.sizeBytes}`,
        'Accept-Ranges': 'bytes',
      },
    })
  }

  const isHead = c.req.method === 'HEAD'

  if (range) {
    const length = range.end - range.start + 1
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Content-Length': String(length),
      'Content-Range': `bytes ${range.start}-${range.end}/${info.sizeBytes}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
    }
    if (isHead) return new Response(null, { status: 206, headers })
    const stream = Readable.toWeb(createReadStreamForKey(storageKey, range)) as ReadableStream
    return new Response(stream, { status: 206, headers })
  }

  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Content-Length': String(info.sizeBytes),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
  }
  if (isHead) return new Response(null, { status: 200, headers })
  const stream = Readable.toWeb(createReadStreamForKey(storageKey)) as ReadableStream
  return new Response(stream, { status: 200, headers })
})

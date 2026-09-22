import { createHmac, timingSafeEqual } from 'node:crypto'

const DEFAULT_TTL_SEC = 30 * 60

function secret(): string {
  const value = process.env.MEDIA_URL_SECRET
  if (!value) throw new Error('MEDIA_URL_SECRET is required')
  return value
}

function sign(storageKey: string, expiresAtSec: number): string {
  return createHmac('sha256', secret()).update(`${storageKey}\n${expiresAtSec}`).digest('hex')
}

export function publicBaseUrl(): string {
  const configured = process.env.PUBLIC_BASE_URL?.trim()
  if (configured) return configured.replace(/\/+$/, '')
  return `http://localhost:${process.env.PORT ?? 3000}`
}

export function buildSignedMediaUrl(storageKey: string, ttlSec?: number): string {
  const ttl = ttlSec ?? Number(process.env.MEDIA_URL_TTL_SEC ?? DEFAULT_TTL_SEC)
  const expiresAtSec = Math.floor(Date.now() / 1000) + (Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TTL_SEC)
  const params = new URLSearchParams({
    key: storageKey,
    exp: String(expiresAtSec),
    sig: sign(storageKey, expiresAtSec),
  })
  return `${publicBaseUrl()}/media?${params.toString()}`
}

export function verifyMediaSignature(
  storageKey: string | undefined,
  exp: string | undefined,
  sig: string | undefined
): boolean {
  if (!storageKey || !exp || !sig) return false
  const expiresAtSec = Number(exp)
  if (!Number.isFinite(expiresAtSec)) return false
  if (expiresAtSec * 1000 < Date.now()) return false

  const expected = Buffer.from(sign(storageKey, expiresAtSec), 'utf8')
  const provided = Buffer.from(sig, 'utf8')
  if (expected.length !== provided.length) return false
  return timingSafeEqual(expected, provided)
}

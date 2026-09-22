export const ALLOWED_AUDIO_MIMES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/aac',
  'audio/vnd.dlna.adts',
  'audio/x-m4a',
  'audio/mp4',
  'audio/ogg',
  'audio/flac',
  'audio/x-flac',
  'audio/webm',
  'audio/opus',
])

const DEFAULT_MAX_UPLOAD_MB = 100
const configuredMaxUploadMb = Number(process.env.MAX_UPLOAD_MB ?? DEFAULT_MAX_UPLOAD_MB)

export const MAX_FILE_BYTES =
  Math.max(1, Number.isFinite(configuredMaxUploadMb) ? configuredMaxUploadMb : DEFAULT_MAX_UPLOAD_MB) *
  1024 *
  1024

export function isAllowedMime(mime: string): boolean {
  return ALLOWED_AUDIO_MIMES.has(mime.toLowerCase())
}

export function normalizeMime(mime: string): string {
  const m = mime.toLowerCase()
  if (m === 'audio/mpeg') return 'audio/mp3'
  if (m === 'audio/x-wav' || m === 'audio/wave') return 'audio/wav'
  if (m === 'audio/x-m4a' || m === 'audio/mp4' || m === 'audio/vnd.dlna.adts') return 'audio/aac'
  if (m === 'audio/x-flac') return 'audio/flac'
  return m
}

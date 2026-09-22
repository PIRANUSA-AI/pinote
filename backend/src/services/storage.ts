import { createReadStream, createWriteStream } from 'node:fs'
import { access, mkdir, readFile, stat, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, normalize, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { buildSignedMediaUrl } from '../lib/mediaSignature.js'

const DEFAULT_MEDIA_ROOT = 'mediaStore'

export function mediaRoot(): string {
  return resolve(process.env.MEDIA_ROOT ?? DEFAULT_MEDIA_ROOT)
}

export function resolveStoragePath(key: string): string {
  const root = mediaRoot()
  const cleaned = normalize(key).replace(/^([/\\]|\.\.([/\\]|$))+/, '')
  if (!cleaned) throw new Error('Invalid storage key')
  const full = resolve(root, cleaned)
  if (full !== root && !full.startsWith(root + sep)) throw new Error('Invalid storage key')
  return full
}

export async function writeObjectStream(args: {
  key: string
  mimeType: string
  sizeBytes: number
  body: Readable | Uint8Array
}): Promise<void> {
  const target = resolveStoragePath(args.key)
  await mkdir(dirname(target), { recursive: true })
  const source = args.body instanceof Readable ? args.body : Readable.from(args.body)
  await pipeline(source, createWriteStream(target))
}

export async function readObject(key: string): Promise<Buffer> {
  return readFile(resolveStoragePath(key))
}

export function createReadStreamForKey(key: string, range?: { start: number; end: number }): Readable {
  return createReadStream(resolveStoragePath(key), range)
}

export async function statObject(key: string): Promise<{ sizeBytes: number } | null> {
  try {
    const info = await stat(resolveStoragePath(key))
    if (!info.isFile()) return null
    return { sizeBytes: info.size }
  } catch {
    return null
  }
}

export async function objectExists(key: string): Promise<boolean> {
  return (await statObject(key)) !== null
}

export async function deleteObject(key: string): Promise<void> {
  try {
    await unlink(resolveStoragePath(key))
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code !== 'ENOENT') throw err
  }
}

export async function createDownloadUrl(key: string, ttlSec?: number): Promise<string> {
  return buildSignedMediaUrl(key, ttlSec)
}

export async function checkStorage(): Promise<boolean> {
  const root = mediaRoot()
  await mkdir(root, { recursive: true })
  await access(root, constants.W_OK)
  return true
}

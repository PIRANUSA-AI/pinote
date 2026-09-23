import { z } from 'zod'
import type { NativeTranscriptLine, TranscriptSegment } from '../db/schema.js'

export const nativeTranscriptSchema = z.array(z.object({
  participantId: z.string().min(1).max(512),
  name: z.string().trim().min(1).max(120).nullable(),
  text: z.string().trim().min(1).max(10000),
  start: z.number().finite().min(0).max(86400),
  end: z.number().finite().min(0).max(86400),
  eventId: z.string().regex(/^\d{1,20}$/),
  version: z.string().regex(/^\d{1,20}$/),
}).refine((line) => line.end >= line.start, 'Waktu akhir transkrip tidak valid')).max(20000)

function timestamp(seconds: number): string {
  const s = Math.floor(seconds)
  const h = Math.floor(s / 3600)
  return `${h ? `${h}:` : ''}${h ? String(Math.floor(s / 60) % 60).padStart(2, '0') : Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const JOIN_GAP_SEC = 10
const WORD_LIMIT = 75
const CHAT_PREFIX = 'Chat: '

const wordCount = (text: string) => text.split(' ').length

function canJoinText(blockText: string, nextText: string): boolean {
  if (!blockText.endsWith('.')) return true
  if (nextText.endsWith('.')) return wordCount(`${blockText} ${nextText}`) < WORD_LIMIT
  return wordCount(blockText) < WORD_LIMIT / 2
}

type Block = { line: NativeTranscriptLine, lastStart: number }

function combine(lines: NativeTranscriptLine[]): NativeTranscriptLine[] {
  const blocks: Block[] = []
  for (const line of lines) {
    const block = blocks.at(-1)
    const chat = line.text.startsWith(CHAT_PREFIX)
    if (block && !chat && !block.line.text.startsWith(CHAT_PREFIX)
      && block.line.participantId === line.participantId
      && line.start - block.lastStart < JOIN_GAP_SEC
      && canJoinText(block.line.text, line.text)) {
      block.line = { ...block.line, text: `${block.line.text} ${line.text}`, end: Math.max(block.line.end, line.end) }
      block.lastStart = line.start
      continue
    }
    blocks.push({ line: { ...line }, lastStart: line.start })
  }
  return blocks.map((block) => block.line)
}

export function nativeSegments(lines: NativeTranscriptLine[]): TranscriptSegment[] {
  const identities = new Map<string, string>()
  for (const line of lines) if (line.name) identities.set(line.participantId, line.name)
  const duplicateNames = new Map<string, string[]>()
  for (const [id, name] of identities) duplicateNames.set(name, [...(duplicateNames.get(name) ?? []), id])
  const unknown = new Map<string, number>()
  const latest = new Map<string, NativeTranscriptLine>()
  for (const line of lines) {
    const key = JSON.stringify([line.participantId, line.eventId])
    const prior = latest.get(key)
    if (!prior || BigInt(line.version) >= BigInt(prior.version)) latest.set(key, line)
  }
  return combine([...latest.values()].sort((a, b) => a.start - b.start)).map((line) => {
    const name = identities.get(line.participantId)
    if (!name && !unknown.has(line.participantId)) unknown.set(line.participantId, unknown.size + 1)
    const duplicates = name ? duplicateNames.get(name)! : []
    return {
      start: timestamp(line.start), end: timestamp(line.end),
      speaker: name ? `${name}${duplicates.length > 1 ? ` (${duplicates.indexOf(line.participantId) + 1})` : ''}` : `Identitas belum tersedia ${unknown.get(line.participantId)}`,
      participantId: line.participantId, provenance: 'meet-native', text: line.text,
    }
  })
}

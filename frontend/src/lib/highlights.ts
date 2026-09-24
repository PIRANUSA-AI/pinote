export type MarkKind = 'decision' | 'question'

const DECISION = [
  /\b(kita|kami|tim)\s+(putuskan|memutuskan|sepakat|sepakati|setuju|pilih|pakai|ambil|jalan(kan)?|lanjut(kan)?|finalkan)\b/i,
  /\b(sudah|udah|jadi)\s+(diputuskan|disepakati|sepakat|deal|fix|final|oke|approved?)\b/i,
  /\b(keputusan(nya)?|kesepakatan(nya)?|disepakati|diputuskan)\b/i,
  /\b(oke|ok|baik|siap),?\s+(kita|jadi)\s+(pakai|pilih|ambil|jalan|lanjut|mulai)\b/i,
  /\b(deal|fix)\s+(ya|ya\.|kalau gitu|kalo gitu)\b/i,
  /\b(we decided|we('| a)re going with|let'?s go with|agreed on|decision is|final decision)\b/i,
]

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

export function segmentMarks(text: string): Set<MarkKind> {
  const marks = new Set<MarkKind>()
  if (!text) return marks
  if (DECISION.some((pattern) => pattern.test(text))) marks.add('decision')
  const question = text.split(/(?<=[.!?])\s+/).some((sentence) => sentence.trim().endsWith('?') && wordCount(sentence) >= 4)
  if (question) marks.add('question')
  return marks
}

export const MARK_LABELS: Record<MarkKind, string> = {
  decision: 'Keputusan',
  question: 'Pertanyaan',
}

const TRIGGERS = [
  /\b(tolong|mohon|jangan lupa|pastikan|pastiin)\b/i,
  /\b(saya|aku|gue|gua|gw|kami|kita)\s+(akan|bakal|mau|harus|perlu|coba|yang)\s+\S+/i,
  /\b(kamu|lu|lo|elu|anda|kalian|mas|mbak|pak|bu)\s+(\S+\s+)?(harus|perlu|tolong|bisa|coba|yang)\s+\S+/i,
  /\bnanti\s+(saya|aku|gue|gua|gw|kami|kita|kamu|lu|lo|dia)\s+\S+/i,
  /\b(deadline|tenggat|paling lambat|maksimal|sebelum)\b/i,
  /\b(action items?|follow ?up|to ?do|pr nya|pr kita)\b/i,
  /\b(i'll|i will|we'll|we will|we need to|you need to|can you|could you|please|let's make sure|make sure)\b/i,
]

const TASK_WORDS = /\b(kirim|kirimin|buat|bikin|cek|ngecek|siapkan|siapin|update|kabari|kabarin|hubungi|telepon|telpon|selesaikan|beresin|kerjakan|kerjain|review|revisi|jadwalkan|susun|rapikan|rapiin|tambahin|tambahkan|ganti|perbaiki|benerin|upload|unggah|submit|share|bagikan|presentasi|hitung|laporan|dokumen|proposal|invoice|send|prepare|finish|check|call|email|fix|deploy|draft|schedule|write|build|test|follow)\w*/i

const DEADLINE = /\b(besok|lusa|nanti sore|nanti malam|minggu depan|bulan depan|hari ini|senin|selasa|rabu|kamis|jumat|jum'at|sabtu|tanggal \d{1,2}|jam \d{1,2}|pekan depan|tomorrow|tonight|next week|monday|tuesday|wednesday|thursday|friday|eod|end of day|end of week)\b/i

const MAX_SENTENCE = 240

function isAction(sentence) {
  const words = sentence.split(/\s+/).filter(Boolean).length
  if (words < 4 || words > 60) return false
  const triggered = TRIGGERS.some((pattern) => pattern.test(sentence))
  const task = TASK_WORDS.test(sentence)
  const deadline = DEADLINE.test(sentence)
  return (triggered && (task || deadline)) || (task && deadline)
}

const CACHE_LIMIT = 40000
const cache = new Map()

export function actionSentences(text) {
  if (typeof text !== 'string' || !text.trim()) return []
  const known = cache.get(text)
  if (known) return known
  if (cache.size >= CACHE_LIMIT) cache.clear()
  const found = detectSentences(text)
  cache.set(text, found)
  return found
}

function detectSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(isAction)
    .map((sentence) => (sentence.length > MAX_SENTENCE ? `${sentence.slice(0, MAX_SENTENCE - 1).trimEnd()}…` : sentence))
}

export function findActions(entries, limit = 30) {
  const found = []
  for (const [index, entry] of (entries ?? []).entries()) {
    if (!entry) continue
    for (const text of actionSentences(entry.text)) found.push({ index, speaker: entry.speaker ?? '', at: entry.at ?? null, text })
  }
  return found.slice(-limit)
}

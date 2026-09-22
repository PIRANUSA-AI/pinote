import OpenAI from 'openai'
import { z } from 'zod'
import { db } from '../db/client.js'
import { users } from '../db/schema.js'
import type { ExtractedActionItem, TranscriptSegment } from '../db/schema.js'

const GLM_BASE_URL = process.env.GLM_BASE_URL ?? 'https://api.z.ai/api/paas/v4'
const GLM_MODEL = process.env.GLM_MODEL ?? 'glm-4.5-flash'

const CHUNK_CHAR_TARGET = 22000
const CARRY_MAX_CHARS = 1800
const CONFIDENCE_MIN = 0.15

function glmClient(): OpenAI {
  const k = process.env.GLM_API_KEY
  if (!k) throw new Error('GLM_API_KEY is required')
  return new OpenAI({ apiKey: k, baseURL: GLM_BASE_URL })
}

async function callGlmJson(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]): Promise<unknown> {
  const glm = glmClient()
  const response = (await glm.chat.completions.create({
    model: GLM_MODEL,
    response_format: { type: 'json_object' },
    thinking: { type: 'disabled' },
    temperature: 0.2,
    messages,
  } as never)) as OpenAI.Chat.Completions.ChatCompletion
  const raw = response.choices[0]?.message?.content ?? '{}'
  return JSON.parse(raw)
}

const polishResponseSchema = z.object({
  segments: z.array(
    z.object({
      speaker: z.string(),
      text: z.string(),
    })
  ),
})

const POLISH_SYSTEM = `Kamu penyunting transkrip rapat Bahasa Indonesia. Tugasmu HANYA memperbaiki transkrip speech-to-text yang salah dengar.`

const POLISH_RULES = `
BOLEH diperbaiki:
- Salah ejaan typo jelas (mis. "ake" -> "aku", "bgaimana" -> "bagaimana", "bgt" -> "banget" jika konteks formal).
- Nama orang/produk/perusahaan/tempat yang misspelled bila konteks sangat jelas (mis. "Solopu" -> "Salopu", "postgress" -> "PostgreSQL"). Jika ragu, BIARKAN apa adanya.
- Istilah teknis/brand yang ejaannya jelas (mis. "githup" -> "GitHub", "slak" -> "Slack").
- Tanda baca yang hilang atau salah.

DILARANG KERAS:
- Mengubah urutan kata, memecah, atau menggabungkan kalimat.
- Menambah atau menghapus kata selain untuk koreksi typo jelas.
- Mengubah makna atau niat pembicara.
- Menerjemahkan atau mengganti kata gaul/formal (pertahankan register asli: "gue", "aku", "saya" tetap).
- Mengubah label speaker.

OUTPUT: JSON { "segments": [{ "speaker": "<PERSIS dari input>", "text": "<diperbaiki>" }] }
Jumlah elemen dan urutan WAJIB sama dengan input. Field speaker TIDAK BOLEH diubah sama sekali.`.trim()

function chunkSegmentsForPolish(segments: TranscriptSegment[]): TranscriptSegment[][] {
  const chunks: TranscriptSegment[][] = []
  let cur: TranscriptSegment[] = []
  let curLen = 0
  for (const seg of segments) {
    const lineLen = `${seg.speaker}: ${seg.text}`.length + 1
    if (curLen + lineLen > CHUNK_CHAR_TARGET && cur.length > 0) {
      chunks.push(cur)
      cur = []
      curLen = 0
    }
    cur.push(seg)
    curLen += lineLen
  }
  if (cur.length > 0) chunks.push(cur)
  return chunks
}

async function polishChunk(chunk: TranscriptSegment[]): Promise<TranscriptSegment[] | null> {
  if (chunk.length === 0) return null
  const inputLines = chunk.map((s) => ({ speaker: s.speaker, text: s.text }))

  let parsed: unknown
  try {
    parsed = await callGlmJson([
      { role: 'system', content: `${POLISH_SYSTEM}\n\n${POLISH_RULES}` },
      {
        role: 'user',
        content: `Berikut adalah ${chunk.length} segmen transkrip mentah. Perbaiki dan kembalikan dalam format JSON yang diminta, dengan JUMLAH DAN URUTAN SAMA:\n\n${JSON.stringify(inputLines)}`,
      },
    ])
  } catch (err) {
    console.warn('polishChunk: GLM call failed:', err)
    return null
  }

  const result = polishResponseSchema.safeParse(parsed)
  if (!result.success) {
    console.warn('polishChunk: malformed response, keeping raw')
    return null
  }

  const out = result.data.segments
  if (out.length !== chunk.length) {
    console.warn(`polishChunk: count mismatch (in=${chunk.length}, out=${out.length}), keeping raw`)
    return null
  }

  return chunk.map((seg, i) => {
    const fixed = out[i]
    return {
      start: seg.start,
      end: seg.end,
      speaker: seg.speaker,
      text: (fixed.text ?? '').trim() || seg.text,
    }
  })
}

export async function polishTranscript(segments: TranscriptSegment[]): Promise<{
  polished: TranscriptSegment[]
  raw: TranscriptSegment[]
}> {
  const raw = segments.map((s) => ({ ...s }))
  const chunks = chunkSegmentsForPolish(raw)
  const out: TranscriptSegment[] = []

  for (const chunk of chunks) {
    const fixed = await polishChunk(chunk)
    out.push(...(fixed ?? chunk))
  }

  return { polished: out, raw }
}

const actionItemSchema = z.object({
  owner: z.string().min(1).max(80),
  task: z.string().min(2).max(400),
  due: z.string().max(80).nullable().optional(),
  confidence: z.number().min(0).max(1).optional(),
})

const chunkResponseSchema = z.object({
  summary: z.union([z.string(), z.array(z.string())]).optional(),
  actionItems: z.array(actionItemSchema).optional(),
  carryContext: z.string().max(4000).optional(),
})

const mergedResponseSchema = z.object({
  summary: z.union([z.string(), z.array(z.string())]).optional(),
  actionItems: z.array(actionItemSchema).optional(),
  title: z.string().max(120).optional(),
})

function flattenSummary(s: z.infer<typeof chunkResponseSchema>['summary']): string {
  if (!s) return ''
  return Array.isArray(s) ? s.join('\n') : String(s)
}

function normalizeActionItem(raw: z.infer<typeof actionItemSchema>): ExtractedActionItem | null {
  const owner = raw.owner.trim()
  const task = raw.task.trim()
  if (!owner || !task) return null
  const confidence = raw.confidence ?? 0.7
  if (confidence < CONFIDENCE_MIN) return null
  return {
    owner,
    task: task.replace(/^[-*•]\s*/, ''),
    due: raw.due ? raw.due.trim() : null,
    confidence,
  }
}

function displayCase(s: string): string {
  const t = s.trim()
  if (!t) return t
  const isAllLower = t === t.toLowerCase()
  const isAllUpper = t.length > 1 && t === t.toUpperCase()
  if (isAllLower) return t.charAt(0).toUpperCase() + t.slice(1)
  if (isAllUpper) return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()
  return t
}

async function canonicalizeOwners(items: ExtractedActionItem[]): Promise<ExtractedActionItem[]> {
  if (items.length === 0) return items
  let rows: { displayName: string | null; username: string; nameAliases: string[] | null }[] = []
  try {
    rows = await db
      .select({ displayName: users.displayName, username: users.username, nameAliases: users.nameAliases })
      .from(users)
  } catch {
    return items
  }
  const canonical = new Map<string, string>()
  for (const u of rows) {
    const canon = u.displayName ?? u.username
    const names = [u.displayName, u.username, ...(u.nameAliases ?? [])]
      .filter((n): n is string => !!n && n.trim().length > 0)
    for (const n of names) canonical.set(n.trim().toLowerCase(), canon)
  }
  return items.map((it) => {
    const canon = canonical.get(it.owner.trim().toLowerCase())
    return canon ? { ...it, owner: canon } : { ...it, owner: displayCase(it.owner) }
  })
}

function dedupeOwners(items: ExtractedActionItem[]): ExtractedActionItem[] {
  const seen = new Map<string, ExtractedActionItem>()
  for (const it of items) {
    const key = `${it.owner.toLowerCase()}|${it.task.trim().toLowerCase()}`
    const prev = seen.get(key)
    if (!prev || it.confidence > prev.confidence) seen.set(key, it)
  }
  return [...seen.values()]
}

async function buildUserContext(): Promise<string> {
  try {
    const rows = await db
      .select({
        username: users.username,
        displayName: users.displayName,
        nameAliases: users.nameAliases,
      })
      .from(users)
      .orderBy(users.username)

    if (rows.length === 0) return ''

    const lines = rows.map((u) => {
      const name = u.displayName ?? u.username
      const aliases = (u.nameAliases ?? []).filter(Boolean)
      const aliasStr = aliases.length > 0 ? ` (alias: ${aliases.join(', ')})` : ''
      return `- ${name} (username: ${u.username})${aliasStr}`
    })

    return `DAFTAR ANGGOTA TIM TERDAFTAR:\n${lines.join('\n')}\n\n`
  } catch {
    return ''
  }
}

function buildSystemBase(userContext: string): string {
  return `Kamu asisten analisis rapat Bahasa Indonesia yang sangat disiplin. Label pembicara berupa ANGKA ("0:", "1:", dst.) dari sistem diarisasi — itu BUKAN nama orang. Nama asli peserta hanya muncul di dalam isi ucapan.

${userContext}ATURAN UTAMA EKSTRAKSI TUGAS:
- Keluarkan SEMUA tugas dari transkrip tanpa batas jumlah. Over-estimate.
- Setiap ORANG bisa punya BANYAK tugas. JANGAN gabungin tugas yang beda.
- Lihat setiap kalimat: imperatif, komitmen, rencana, follow-up, delegasi, pengingat = calon item.

ATURAN MENENTUKAN OWNER (SANGAT PENTING):
- Cocokkan nama yang disebut ke daftar ANGGOTA TIM HANYA bila jelas orang yang sama, yaitu salah satu dari:
  • cocok tepat (boleh beda huruf besar/kecil), atau
  • merupakan alias terdaftar, atau
  • salah ejaan / julukan fonetik yang nyata dari anggota itu. Contoh: "DYNA"/"DAYNA" → DINA; "Noel"/"Yul" → Yoel; "Saloppu" → Salopu.
- Saat sudah cocok, WAJIB pakai ejaan RESMI anggota tim dari daftar.
- DILARANG memaksa cocok ke anggota terdekat kalau nama itu jelas orang lain. "Joan" BUKAN "Yoel". Nama yang mirip bunyinya belum tentu orang yang sama — pakai konteks (siapa yang ditunjuk / sedang bicara).
- Jika TIDAK ada kecocokan dengan anggota tim: tulis nama PERSIS seperti yang disebut di rapat, dengan kapitalisasi yang masuk akal (mis. "Joan"). JANGAN gunakan "Unassigned" maupun placeholder seperti "test"/"user".`
}

const ACTION_RULES = `
Output JSON: {"title": "...", "summary": "...", "actionItems": [{owner, task, due, confidence}]}.

OWNER: nama anggota tim (ejaan resmi dari daftar) bila jelas cocok; jika tidak ada, tulis nama apa adanya yang disebut. Dilarang "Unassigned".
TASK: deskripsi Bahasa Indonesia yang spesifik dan detail.
CONFIDENCE: >=0.8 sangat eksplisit; 0.5-0.8 indikasi kuat; 0.15-0.5 samar.
DUE: hanya jika disebut eksplisit, null jika tidak ada.
INGAT: LEBIH BAIK 20 tugas dengan 5 false positive daripada 5 kelewat 15.`.trim()

function buildLines(segments: TranscriptSegment[]): string[] {
  return segments.map((s) => `${s.speaker}: ${s.text}`)
}

function chunkLines(lines: string[]): string[][] {
  if (lines.length === 0) return []
  const chunks: string[][] = []
  let cur: string[] = []
  let curLen = 0
  for (const line of lines) {
    const lineLen = line.length + 1
    if (curLen + lineLen > CHUNK_CHAR_TARGET && cur.length > 0) {
      chunks.push(cur)
      cur = []
      curLen = 0
    }
    cur.push(line)
    curLen += lineLen
  }
  if (cur.length > 0) chunks.push(cur)
  return chunks
}

interface ChunkResult {
  actionItems: ExtractedActionItem[]
  chunkSummary: string
  carryContext: string
}

async function extractChunk(args: {
  text: string
  carryContext: string
  chunkIndex: number
  chunkCount: number
  userContext: string
}): Promise<ChunkResult> {
  const isFirst = args.chunkIndex === 0
  const isLast = args.chunkIndex === args.chunkCount - 1
  const contextBlock = args.carryContext
    ? `\n\n--- KONTEKS DARI BAGIAN SEBELUMNYA ---\n${args.carryContext}`
    : ''

  const system = `${buildSystemBase(args.userContext)}

Kamu menganalisis BAGIAN ${args.chunkIndex + 1} dari ${args.chunkCount} transkrip rapat panjang.${isFirst ? '' : ' Ini BUKAN bagian pertama; gunakan konteks sebelumnya.'}${isLast ? ' Ini bagian terakhir.' : ''}

Tugas:
1. "actionItems": daftar tugas dari BAGIAN INI saja.
2. "summary": 1-3 poin ringkasan bagian ini, masing-masing diawali "- ".
3. "carryContext": essence untuk bagian berikutnya (owner sudah teridentifikasi, keputusan, tugas sudah diambil). Maksimal ~${CARRY_MAX_CHARS} karakter.

${ACTION_RULES}`

  try {
    const parsed = chunkResponseSchema.safeParse(await callGlmJson([
      { role: 'system', content: system },
      { role: 'user', content: args.text + contextBlock },
    ]))
    if (!parsed.success) {
      console.warn(`Chunk ${args.chunkIndex + 1}/${args.chunkCount} parse failed:`, parsed.error.issues[0]?.message)
      return { actionItems: [], chunkSummary: '', carryContext: args.carryContext }
    }
    const actionItems = (parsed.data.actionItems ?? [])
      .map(normalizeActionItem)
      .filter((x): x is ExtractedActionItem => x !== null)
    return {
      actionItems,
      chunkSummary: flattenSummary(parsed.data.summary),
      carryContext: (parsed.data.carryContext ?? args.carryContext).slice(0, CARRY_MAX_CHARS * 2),
    }
  } catch (err) {
    console.warn(`Chunk ${args.chunkIndex + 1}/${args.chunkCount} extraction failed:`, err)
    return { actionItems: [], chunkSummary: '', carryContext: args.carryContext }
  }
}

interface MergeInput {
  chunkSummaries: string[]
  rawItems: ExtractedActionItem[]
}

async function mergeInsights(
  input: MergeInput & { userContext: string }
): Promise<{ summary: string; actionItems: ExtractedActionItem[]; title: string }> {
  const itemsBlock = input.rawItems.length
    ? input.rawItems.map((it, i) => `${i + 1}. [${it.owner}] ${it.task}${it.due ? ` (due: ${it.due})` : ''} (conf: ${it.confidence.toFixed(2)})`).join('\n')
    : '(tidak ada)'
  const summariesBlock = input.chunkSummaries.filter(Boolean).map((s, i) => `Bagian ${i + 1}:\n${s}`).join('\n\n')

  const system = `${buildSystemBase(input.userContext)}

Beberapa bagian transkrip rapat sudah dianalisis terpisah. Tugas kamu:
1. "title": judul SANGAT SINGKAT (3-7 kata).
2. "summary": sintesis 3-5 poin koheren untuk SELURUH rapat.
3. "actionItems": gabungan final dari daftar item mentah di bawah.
   - HAPUS duplikat identik (tugas + owner sama). Ambil confidence TERTINGGI.
   - JANGAN gabung tugas beda meski owner sama.
   - JANGAN tambah item baru.
   - Urutkan per owner, lalu urutan kemunculan.

${ACTION_RULES}`

  try {
    const parsed = mergedResponseSchema.safeParse(await callGlmJson([
      { role: 'system', content: system },
      { role: 'user', content: `Ringkasan per-bagian:\n${summariesBlock}\n\n--- Daftar action item mentah ---\n${itemsBlock}` },
    ]))
    if (!parsed.success) {
      return { title: '', summary: input.chunkSummaries.filter(Boolean).join('\n'), actionItems: input.rawItems }
    }
    const merged = (parsed.data.actionItems ?? input.rawItems)
      .map(normalizeActionItem)
      .filter((x): x is ExtractedActionItem => x !== null)
    const actionItems = merged.length >= input.rawItems.length || input.rawItems.length === 0 ? merged : input.rawItems
    return {
      title: (parsed.data.title ?? '').trim().replace(/^["']|["']$/g, '').slice(0, 120),
      summary: flattenSummary(parsed.data.summary),
      actionItems,
    }
  } catch (err) {
    console.warn('Merge pass failed:', err)
    return { title: '', summary: input.chunkSummaries.filter(Boolean).join('\n'), actionItems: input.rawItems }
  }
}

async function extractSingle(
  text: string,
  userContext: string
): Promise<{ summary: string; actionItems: ExtractedActionItem[]; title: string }> {
  const system = `${buildSystemBase(userContext)}

Tugas:
1. "title": judul SANGAT SINGKAT (3-7 kata) dalam Bahasa Indonesia yang mencerminkan inti/topik utama rapat.
2. "summary": 3-5 poin ringkasan rapat dalam Bahasa Indonesia, masing-masing diawali "- ".
3. "actionItems": SEMUA tugas/action items dari transkrip.

${ACTION_RULES}`
  try {
    const parsed = mergedResponseSchema.safeParse(await callGlmJson([
      { role: 'system', content: system },
      { role: 'user', content: text },
    ]))
    if (!parsed.success) {
      console.warn('Single extraction parse failed:', parsed.error.issues[0]?.message)
      return { title: '', summary: '', actionItems: [] }
    }
    return {
      title: (parsed.data.title ?? '').trim().replace(/^["']|["']$/g, '').slice(0, 120),
      summary: flattenSummary(parsed.data.summary),
      actionItems: (parsed.data.actionItems ?? []).map(normalizeActionItem).filter((x): x is ExtractedActionItem => x !== null),
    }
  } catch (err) {
    console.warn('Single extraction failed:', err)
    return { title: '', summary: '', actionItems: [] }
  }
}

async function extractLargeInsights(
  lines: string[],
  totalLen: number,
  userContext: string
): Promise<{ title: string; summary: string; actionItems: ExtractedActionItem[] }> {
  const chunks = chunkLines(lines)
  console.log(`Transcript large (${totalLen} chars); splitting into ${chunks.length} chunks`)

  let carryContext = ''
  const chunkSummaries: string[] = []
  const rawItems: ExtractedActionItem[] = []

  for (let i = 0; i < chunks.length; i++) {
    const res = await extractChunk({
      text: chunks[i].join('\n'),
      carryContext,
      chunkIndex: i,
      chunkCount: chunks.length,
      userContext,
    })
    rawItems.push(...res.actionItems)
    chunkSummaries.push(res.chunkSummary)
    carryContext = res.carryContext
  }

  return mergeInsights({ chunkSummaries, rawItems, userContext })
}

export async function generateInsights(
  segments: TranscriptSegment[]
): Promise<{ title: string; summary: string; actionItems: ExtractedActionItem[] }> {
  const lines = buildLines(segments)
  const totalLen = lines.reduce((n, l) => n + l.length + 1, 0)
  const userContext = await buildUserContext()

  const result = totalLen <= CHUNK_CHAR_TARGET
    ? await extractSingle(lines.join('\n').slice(0, 60000), userContext)
    : await extractLargeInsights(lines, totalLen, userContext)

  const actionItems = dedupeOwners(await canonicalizeOwners(result.actionItems))
  return { title: result.title, summary: result.summary, actionItems }
}

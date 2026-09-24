import { Hono } from 'hono'
import { z } from 'zod'
import { eq, and, or, sql, asc, desc } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import OpenAI from 'openai'
import { db } from '../db/client.js'
import { actionItems, users } from '../db/schema.js'
import { parseDue } from '../lib/dueDate.js'
import { requireAdmin, type AppEnv } from '../middleware/auth.js'

const GLM_BASE_URL = process.env.GLM_BASE_URL ?? 'https://api.z.ai/api/paas/v4'
const GLM_MODEL = process.env.GLM_MODEL ?? 'glm-5.2'

function glmClient(): OpenAI {
  const k = process.env.GLM_API_KEY
  if (!k) throw new Error('GLM_API_KEY is required')
  return new OpenAI({ apiKey: k, baseURL: GLM_BASE_URL })
}

const GENERATE_SYSTEM = `Kamu asisten yang mengubah deskripsi tugas Bahasa Indonesia menjadi data terstruktur.

Format output HARUS JSON array:
[{ "owner": "nama orang", "task": "deskripsi tugas", "due": "tenggat atau null" }]

Aturan:
- Owner diambil dari teks yang diawali @, contoh: "@Eca" → owner: "Eca"
- Jika tidak ada @, owner default "Unassigned"
- Due date diambil dari kata kunci seperti: besok, lusa, Jumat, 3 hari lagi, next week
- Due date dikonversi ke format relative Bahasa Indonesia (contoh: "besok", "Jumat", "3 hari lagi")
- Jika tidak ada due date, due = null
- Task harus deskriptif dan spesifik
- Keluarkan HANYA array JSON, tanpa markdown, tanpa penjelasan`

const createSchema = z.object({
  owner: z.string().min(1).max(80),
  task: z.string().min(2).max(400),
  due: z.string().max(80).nullable().optional(),
  assigneeId: z.string().nullable().optional(),
})

const updateSchema = z.object({
  owner: z.string().min(1).max(80).optional(),
  task: z.string().min(2).max(400).optional(),
  due: z.string().max(80).nullable().optional(),
  done: z.boolean().optional(),
})

export const playgroundRouter = new Hono<AppEnv>()

const CHUNK_MAX_CHARS = 1500

function chunkPrompt(prompt: string): string[] {
  if (prompt.length <= CHUNK_MAX_CHARS) return [prompt]
  const sentences = prompt.split(/(?<=[.!?\n])\s*/)
  const chunks: string[] = []
  let current = ''
  for (const sentence of sentences) {
    const next = current ? current + ' ' + sentence : sentence
    if (next.length > CHUNK_MAX_CHARS && current.length > 0) {
      chunks.push(current.trim())
      current = sentence
    } else {
      current = next
    }
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks
}

const generateSchema = z.object({
  prompt: z.string().min(3).max(10000),
})

playgroundRouter.post('/generate', requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = generateSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Input tidak valid' }, 400)
  }

  const prompt = parsed.data.prompt
  const chunks = chunkPrompt(prompt)
  let tasks: Array<{ owner: string; task: string; due: string | null }> = []

  try {
    const client = glmClient()
    for (const chunk of chunks) {
      const res = await client.chat.completions.create({
        model: GLM_MODEL,
        messages: [
          { role: 'system', content: GENERATE_SYSTEM },
          { role: 'user', content: chunk },
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      })

      const raw = res.choices?.[0]?.message?.content
      if (!raw) throw new Error('AI tidak memberikan respons')

      const parsedJson = JSON.parse(raw)
      const chunkTasks = Array.isArray(parsedJson) ? parsedJson : parsedJson.tasks ?? []
      if (Array.isArray(chunkTasks)) tasks.push(...chunkTasks)
    }
  } catch (err) {
    console.error('AI generate failed:', err)
    return c.json({ error: 'Gagal memproses dengan AI. Coba lagi.' }, 502)
  }

  if (tasks.length === 0) {
    return c.json({ error: 'AI tidak dapat mengekstrak tugas dari deskripsi tersebut' }, 400)
  }

  const created = []
  for (const t of tasks.slice(0, 50)) {
    const id = nanoid()
    await db.insert(actionItems).values({
      id,
      jobId: null,
      owner: t.owner || 'Unassigned',
      task: t.task,
      due: t.due ?? null,
      dueOn: parseDue(t.due, new Date()),
      assigneeId: null,
      confidence: 0.9,
      done: false,
      order: created.length,
    })
    created.push({ id, owner: t.owner || 'Unassigned', task: t.task, due: t.due ?? null })
  }

  return c.json({ tasks: created, count: created.length }, 201)
})

playgroundRouter.get('/tasks', async (c) => {
  const owner = c.req.query('owner')
  const conditions = [sql`${actionItems.jobId} IS NULL`]
  if (owner) conditions.push(eq(actionItems.owner, owner))

  const rows = await db
    .select({
      id: actionItems.id,
      jobId: actionItems.jobId,
      owner: actionItems.owner,
      assigneeId: actionItems.assigneeId,
      task: actionItems.task,
      due: actionItems.due,
      dueOn: actionItems.dueOn,
      confidence: actionItems.confidence,
      done: actionItems.done,
      order: actionItems.order,
      createdAt: actionItems.createdAt,
    })
    .from(actionItems)
    .where(and(...conditions))
    .orderBy(asc(actionItems.createdAt))

  return c.json({ tasks: rows })
})

playgroundRouter.get('/users', async (c) => {
  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
    })
    .from(users)
    .orderBy(asc(users.username))

  return c.json({ users: rows })
})

playgroundRouter.use('*', requireAdmin)

playgroundRouter.post('/tasks', async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Input tidak valid' }, 400)
  }

  const id = nanoid()
  await db.insert(actionItems).values({
    id,
    jobId: null,
    owner: parsed.data.owner.trim(),
    task: parsed.data.task.trim(),
    due: parsed.data.due ?? null,
    dueOn: parseDue(parsed.data.due, new Date()),
    assigneeId: parsed.data.assigneeId ?? null,
    confidence: 1,
    done: false,
    order: 0,
  })

  const [created] = await db
    .select()
    .from(actionItems)
    .where(eq(actionItems.id, id))
    .limit(1)

  return c.json(created, 201)
})

playgroundRouter.patch('/tasks/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => null)
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Input tidak valid' }, 400)
  }

  const [existing] = await db
    .select({ id: actionItems.id, jobId: actionItems.jobId })
    .from(actionItems)
    .where(eq(actionItems.id, id))
    .limit(1)

  if (!existing) return c.json({ error: 'Tugas tidak ditemukan' }, 404)
  if (existing.jobId) return c.json({ error: 'Tugas dari transkrip tidak bisa diedit di sini' }, 403)

  const patch: Record<string, unknown> = {}
  if (parsed.data.owner !== undefined) patch.owner = parsed.data.owner.trim()
  if (parsed.data.task !== undefined) patch.task = parsed.data.task.trim()
  if (parsed.data.due !== undefined) {
    patch.due = parsed.data.due
    patch.dueOn = parseDue(parsed.data.due, new Date())
  }
  if (parsed.data.done !== undefined) patch.done = parsed.data.done

  await db.update(actionItems).set(patch).where(eq(actionItems.id, id))

  const [updated] = await db
    .select()
    .from(actionItems)
    .where(eq(actionItems.id, id))
    .limit(1)

  return c.json(updated)
})

playgroundRouter.delete('/tasks/:id', async (c) => {
  const id = c.req.param('id')

  const [existing] = await db
    .select({ id: actionItems.id, jobId: actionItems.jobId })
    .from(actionItems)
    .where(eq(actionItems.id, id))
    .limit(1)

  if (!existing) return c.json({ error: 'Tugas tidak ditemukan' }, 404)
  if (existing.jobId) return c.json({ error: 'Tugas dari transkrip tidak bisa dihapus di sini' }, 403)

  await db.delete(actionItems).where(eq(actionItems.id, id))
  return c.json({ ok: true })
})

import { Hono } from 'hono'
import { and, asc, desc, eq, inArray, lt, ne, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { db } from '../db/client.js'
import { actionItems, jobs, users, type ActionItemRow, type JobStatus } from '../db/schema.js'
import { requireAuth, type AppEnv } from '../middleware/auth.js'
import { isAllowedMime, normalizeMime, MAX_FILE_BYTES } from '../lib/validate.js'
import { cacheJobStatus, getCachedJobStatus } from '../services/cache.js'
import { createDownloadUrl, objectExists } from '../services/storage.js'

function safeFilename(name: string): string {
  const base = name.replace(/[/\\]+/g, '_').replace(/^\.+/, '').trim()
  return base.length > 0 ? base.slice(0, 200) : 'audio'
}

const createSchema = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().positive().max(MAX_FILE_BYTES),
  durationSec: z.number().int().positive(),
  language: z.enum(['id', 'en', 'auto']).optional(),
})

export const jobsRouter = new Hono<AppEnv>()

jobsRouter.use('*', requireAuth)

jobsRouter.get('/shared/:token', async (c) => {
  const token = c.req.param('token')
  const [job] = await db.select().from(jobs).where(eq(jobs.shareToken, token)).limit(1)

  if (!job) return c.json({ error: 'Link bagikan tidak ditemukan' }, 404)

  const items = job.status === 'completed' ? await loadActionItems(job.id) : []
  return c.json(toJobDetail(job, false, undefined, items))
})

jobsRouter.post('/', async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }, 400)
  }
  const mime = normalizeMime(parsed.data.mimeType)
  if (!isAllowedMime(mime)) {
    return c.json({ error: `Format audio tidak didukung: ${parsed.data.mimeType}` }, 415)
  }

  const user = c.get('user')

  const jobId = nanoid()
  const storageKey = `uploads/${user.id}/${jobId}/${safeFilename(parsed.data.filename)}`

  const [created] = await db
    .insert(jobs)
    .values({
      id: jobId,
      userId: user.id,
      filename: parsed.data.filename,
      mimeType: mime,
      sizeBytes: parsed.data.sizeBytes,
      durationSec: parsed.data.durationSec,
      language: parsed.data.language ?? 'auto',
      storageKey,
      status: 'pending' satisfies JobStatus,
    })
    .returning()

  await cacheJobStatus(jobId, { status: 'pending', progress: 0 })

  return c.json({
    jobId: created.id,
    uploadMethod: 'api',
    uploadUrl: `/upload/${created.id}/storage`,
  })
})

jobsRouter.get('/', async (c) => {
  const user = c.get('user')
  const cursor = c.req.query('cursor')
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 100), 1), 200)

  const conditions = [eq(jobs.userId, user.id), ne(jobs.status, 'cancelled')]
  if (cursor) {
    conditions.push(lt(jobs.createdAt, new Date(cursor)))
  }

  const rows = await db
    .select({
      id: jobs.id,
      filename: jobs.filename,
      title: jobs.title,
      durationSec: jobs.durationSec,
      sizeBytes: jobs.sizeBytes,
      language: jobs.language,
      status: jobs.status,
      createdAt: jobs.createdAt,
      completedAt: jobs.completedAt,
      speakerCount: sql<number | null>`(${jobs.transcript}->>'speakerCount')::int`,
    })
    .from(jobs)
    .where(and(...conditions))
    .orderBy(desc(jobs.createdAt))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows
  const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].createdAt.toISOString() : null

  return c.json({
    jobs: items.map((r) => ({
      ...r,
      speakerCount:
        r.status === 'completed' && r.speakerCount
          ? r.speakerCount
          : null,
    })),
    hasMore,
    nextCursor,
  })
})

jobsRouter.get('/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')

  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, id), eq(jobs.userId, user.id)))
    .limit(1)

  if (!job) return c.json({ error: 'Job tidak ditemukan' }, 404)

  // Get progress from cache (Phase 2 background processing sends progress updates)
  let progress: number | undefined
  if (job.status !== 'failed' && job.status !== 'cancelled') {
    const cached = await getCachedJobStatus(id)
    if (cached && typeof cached === 'object' && 'progress' in cached) {
      progress = (cached as { progress?: number }).progress
    }
  }

  const items = job.status === 'completed' ? await loadActionItems(id) : []
  return c.json(toJobDetail(job, true, progress, items))
})

jobsRouter.get('/:id/audio', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')

  const [job] = await db
    .select({ storageKey: jobs.storageKey, userId: jobs.userId, mimeType: jobs.mimeType })
    .from(jobs)
    .where(eq(jobs.id, id))
    .limit(1)

  if (!job) return c.json({ error: 'Job tidak ditemukan' }, 404)
  if (job.userId !== user.id && !user.isAdmin) return c.json({ error: 'Forbidden' }, 403)
  if (!job.storageKey) return c.json({ error: 'Audio tidak tersedia' }, 404)
  if (!(await objectExists(job.storageKey))) {
    return c.json({ error: 'Rekaman audio sudah tidak ada di server' }, 404)
  }

  const url = await createDownloadUrl(job.storageKey)
  return c.json({ url, mimeType: job.mimeType ?? 'audio/mpeg' })
})

jobsRouter.post('/:id/retry', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')

  const [job] = await db
    .select({ userId: jobs.userId, status: jobs.status, storageKey: jobs.storageKey })
    .from(jobs)
    .where(eq(jobs.id, id))
    .limit(1)

  if (!job) return c.json({ error: 'Job tidak ditemukan' }, 404)
  if (job.userId !== user.id && !user.isAdmin) return c.json({ error: 'Forbidden' }, 403)
  if (job.status !== 'failed' && job.status !== 'cancelled') {
    return c.json({ error: 'Hanya job gagal/dibatalkan yang bisa di-retry' }, 400)
  }
  if (!job.storageKey) return c.json({ error: 'Audio asli tidak tersedia untuk di-retry' }, 400)
  if (!(await objectExists(job.storageKey))) {
    return c.json({ error: 'Rekaman audio sudah tidak ada di server, tidak bisa di-retry' }, 400)
  }

  await db.delete(actionItems).where(eq(actionItems.jobId, id))

  await db
    .update(jobs)
    .set({
      status: 'queued',
      errorMessage: null,
      transcript: null,
      title: null,
      durationSec: null,
      completedAt: null,
    })
    .where(eq(jobs.id, id))

  await cacheJobStatus(id, { status: 'queued', progress: 0 })
  return c.json({ ok: true })
})

jobsRouter.post('/:id/share', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({} as { kind?: string }))
  const kind: 'internal' | 'stakeholder' = body?.kind === 'stakeholder' ? 'stakeholder' : 'internal'

  const [job] = await db
    .select({
      id: jobs.id,
      shareToken: jobs.shareToken,
      shareTokenMom: jobs.shareTokenMom,
    })
    .from(jobs)
    .where(and(eq(jobs.id, id), eq(jobs.userId, user.id)))
    .limit(1)

  if (!job) return c.json({ error: 'Job tidak ditemukan' }, 404)

  if (kind === 'internal') {
    if (job.shareToken) {
      return c.json({ kind, shareToken: job.shareToken, sharePath: `/share/${job.shareToken}` })
    }
    const shareToken = nanoid(32)
    const [updated] = await db
      .update(jobs)
      .set({ shareToken })
      .where(and(eq(jobs.id, id), eq(jobs.userId, user.id)))
      .returning({ shareToken: jobs.shareToken })
    return c.json({ kind, shareToken: updated.shareToken, sharePath: `/share/${updated.shareToken}` })
  }

  // stakeholder (MoM-only) link
  if (job.shareTokenMom) {
    return c.json({ kind, shareToken: job.shareTokenMom, sharePath: `/share/mom/${job.shareTokenMom}` })
  }
  const momToken = nanoid(32)
  const [updatedMom] = await db
    .update(jobs)
    .set({ shareTokenMom: momToken })
    .where(and(eq(jobs.id, id), eq(jobs.userId, user.id)))
    .returning({ shareTokenMom: jobs.shareTokenMom })
  return c.json({ kind, shareToken: updatedMom.shareTokenMom, sharePath: `/share/mom/${updatedMom.shareTokenMom}` })
})

// Revoke a share link. Query: ?kind=internal|stakeholder (default internal).
jobsRouter.delete('/:id/share', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const kind: 'internal' | 'stakeholder' = c.req.query('kind') === 'stakeholder' ? 'stakeholder' : 'internal'

  const [job] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.id, id), eq(jobs.userId, user.id)))
    .limit(1)

  if (!job) return c.json({ error: 'Job tidak ditemukan' }, 404)

  const clear = kind === 'stakeholder' ? { shareTokenMom: null } : { shareToken: null }
  await db.update(jobs).set(clear).where(and(eq(jobs.id, id), eq(jobs.userId, user.id)))

  return c.json({ ok: true, kind })
})

// --- Action items: bulk edit (upsert / update / delete) ---------------------
// Body: array of changes. Each item either has an existing `id` (update) or no
// `id` (insert). Items can be marked `_delete: true` to remove. Touched items
// are re-ordered by their position in the resulting array.
const actionItemEditSchema = z.object({
  id: z.string().optional(),
  owner: z.string().min(1).max(80).optional(),
  task: z.string().min(1).max(400).optional(),
  due: z.string().max(80).nullable().optional(),
  done: z.boolean().optional(),
  confidence: z.number().min(0).max(1).optional(),
  _delete: z.boolean().optional(),
})

const actionItemPatchSchema = z.array(actionItemEditSchema).max(200)

jobsRouter.patch('/:id/action-items', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => null)
  const parsed = actionItemPatchSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Input tidak valid' }, 400)
  }

  const [job] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.id, id), eq(jobs.userId, user.id)))
    .limit(1)
  if (!job) return c.json({ error: 'Job tidak ditemukan' }, 404)

  const changes = parsed.data
  const toInsert = changes.filter((c2) => !c2.id && !c2._delete && c2.task && c2.owner)
  const toDelete = changes.filter((c2) => c2.id && c2._delete)
  const toUpdate = changes.filter((c2) => c2.id && !c2._delete)

  if (toDelete.length > 0) {
    await db
      .delete(actionItems)
      .where(and(eq(actionItems.jobId, id), inArray(actionItems.id, toDelete.map((d) => d.id!))))
  }

  for (const u of toUpdate) {
    const patch: Record<string, unknown> = {}
    if (u.owner !== undefined) patch.owner = u.owner
    if (u.task !== undefined) patch.task = u.task
    if (u.due !== undefined) patch.due = u.due
    if (u.done !== undefined) patch.done = u.done
    if (u.confidence !== undefined) patch.confidence = u.confidence
    if (Object.keys(patch).length > 0) {
      await db.update(actionItems).set(patch).where(and(eq(actionItems.id, u.id!), eq(actionItems.jobId, id)))
    }
  }

  if (toInsert.length > 0) {
    await db.insert(actionItems).values(
      toInsert.map((ins, i) => ({
        id: nanoid(),
        jobId: id,
        owner: ins.owner!,
        task: ins.task!,
        due: ins.due ?? null,
        confidence: ins.confidence ?? 1,
        done: ins.done ?? false,
        order: 1000 + i,
      }))
    )
  }

  const refreshed = await loadActionItems(id)
  return c.json({ actionItems: refreshed })
})

// Rename a speaker label for a job (e.g. "Speaker 2" -> "Salopu"). Stored as a
// map on jobs.speakerNames; the canonical action_items.owner value is untouched
// and resolved by the frontend at render time (so renaming stays reversible).
const speakerRenameSchema = z.object({
  speaker: z.string().min(1).max(80),
  name: z.string().min(1).max(80),
})

jobsRouter.post('/:id/speakers', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => null)
  const parsed = speakerRenameSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Input tidak valid' }, 400)
  }

  const [job] = await db
    .select({ id: jobs.id, speakerNames: jobs.speakerNames })
    .from(jobs)
    .where(and(eq(jobs.id, id), eq(jobs.userId, user.id)))
    .limit(1)
  if (!job) return c.json({ error: 'Job tidak ditemukan' }, 404)

  const next = { ...(job.speakerNames ?? {}), [parsed.data.speaker]: parsed.data.name }
  await db.update(jobs).set({ speakerNames: next }).where(eq(jobs.id, id))

  return c.json({ speakerNames: next })
})

jobsRouter.delete('/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')

  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, id), eq(jobs.userId, user.id)))
    .limit(1)

  if (!job) return c.json({ error: 'Job tidak ditemukan' }, 404)

  const isRunning = job.status === 'pending' || job.status === 'uploading' || job.status === 'queued' || job.status === 'transcribing'
  if (isRunning) {
    await db
      .update(jobs)
      .set({ status: 'cancelled' satisfies JobStatus, cancelledAt: new Date() })
      .where(and(eq(jobs.id, id), eq(jobs.userId, user.id)))

    await cacheJobStatus(id, { status: 'cancelled', progress: 0 })
    return c.json({ ok: true, cancelled: true })
  }

  if (job.storageKey) {
    const { deleteObject } = await import('../services/storage.js')
    await deleteObject(job.storageKey).catch((err) => console.warn(`Failed to delete stored audio for ${id}:`, err))
  }

  await db.delete(jobs).where(eq(jobs.id, id))
  return c.json({ ok: true })
})

function toJobDetail(
  job: typeof jobs.$inferSelect,
  includeShareToken: boolean,
  progress?: number,
  items: ActionItemRow[] = []
) {
  return {
    id: job.id,
    filename: job.filename,
    title: job.title ?? null,
    mimeType: job.mimeType,
    sizeBytes: job.sizeBytes,
    durationSec: job.durationSec,
    language: job.language,
    status: job.status,
    progress,
    transcript: job.transcript,
    speakerNames: job.speakerNames ?? {},
    actionItems: items
      .map((it) => ({
        id: it.id,
        owner: it.owner,
        task: it.task,
        due: it.due,
        confidence: it.confidence,
        done: it.done,
        order: it.order,
      }))
      .sort((a, b) => a.order - b.order),
    error: job.errorMessage,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    cancelledAt: job.cancelledAt,
    shareToken: includeShareToken ? job.shareToken : undefined,
    shareTokenMom: includeShareToken ? job.shareTokenMom : undefined,
    storageKey: job.storageKey,
  }
}

async function loadActionItems(jobId: string): Promise<ActionItemRow[]> {
  return db
    .select()
    .from(actionItems)
    .where(eq(actionItems.jobId, jobId))
    .orderBy(asc(actionItems.order), asc(actionItems.createdAt))
}

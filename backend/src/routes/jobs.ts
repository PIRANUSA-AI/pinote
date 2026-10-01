import { Hono } from 'hono'
import { and, asc, desc, eq, inArray, lt, ne, or, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { db } from '../db/client.js'
import { actionItemMembers, actionItems, jobMembers, jobs, users, type ActionItemRow, type JobStatus } from '../db/schema.js'
import { fallbackMeetingTitle, sendTaskDigest } from '../services/email.js'
import { requireAuth, type AppEnv } from '../middleware/auth.js'
import { isAllowedMime, normalizeMime, MAX_FILE_BYTES } from '../lib/validate.js'
import { cacheIncrWithTtl, cacheJobStatus, getCachedJobStatus } from '../services/cache.js'
import { askMeeting } from '../services/meetingQa.js'
import { callGlmJson } from '../services/insights.js'
import { createDownloadUrl, objectExists } from '../services/storage.js'
import { nativeTranscriptSchema } from '../lib/nativeTranscript.js'
import { parseDue } from '../lib/dueDate.js'
import { cleanTitleHint } from '../lib/titleHint.js'

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
  source: z.enum(['upload', 'meet', 'zoom', 'teams', 'whatsapp']).optional(),
  skipInsights: z.boolean().optional(),
  titleHint: z.string().max(300).optional(),
  nativeTranscript: nativeTranscriptSchema.optional(),
  attendance: z.array(z.string().min(1).max(120)).max(50).transform((names) => names.filter((n) => !n.includes('@'))).optional(),
  speakerTimeline: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        start: z.number().nonnegative(),
        end: z.number().nonnegative(),
      })
    )
    .max(2000)
    .optional(),
}).refine((value) => value.nativeTranscript === undefined || value.source === 'meet', 'Transkrip native hanya tersedia untuk Google Meet')

export const jobsRouter = new Hono<AppEnv>()

jobsRouter.use('*', requireAuth)

jobsRouter.get('/shared/:token', async (c) => {
  const token = c.req.param('token')
  const [job] = await db.select().from(jobs).where(eq(jobs.shareToken, token)).limit(1)

  if (!job) return c.json({ error: 'Link bagikan tidak ditemukan' }, 404)

  const items = job.status === 'completed' ? await loadActionItems(job.id) : []
  return c.json(toJobDetail(job, false, undefined, items))
})

type JobAccess = 'owner' | 'member'

async function jobAccess(jobId: string, userId: string): Promise<JobAccess | null> {
  const [row] = await db
    .select({ userId: jobs.userId, isPrivate: jobs.isPrivate })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1)
  if (!row) return null
  if (row.userId === userId) return 'owner'
  if (row.isPrivate) return null
  const [member] = await db
    .select({ userId: jobMembers.userId })
    .from(jobMembers)
    .where(and(eq(jobMembers.jobId, jobId), eq(jobMembers.userId, userId)))
    .limit(1)
  return member ? 'member' : null
}

async function knownUserIds(ids: string[], exclude: string): Promise<string[]> {
  const unique = [...new Set(ids)].filter((id) => id !== exclude)
  if (unique.length === 0) return []
  const rows = await db.select({ id: users.id }).from(users).where(inArray(users.id, unique))
  return rows.map((r) => r.id)
}

const memberIdsSchema = z.object({ userIds: z.array(z.string().min(1).max(64)).max(1000) })

jobsRouter.get('/people', async (c) => {
  const user = c.get('user')
  const rows = await db
    .select({ id: users.id, username: users.username, displayName: users.displayName })
    .from(users)
    .where(ne(users.id, user.id))
    .orderBy(asc(sql`LOWER(COALESCE(${users.displayName}, ${users.username}))`))
  return c.json({ people: rows })
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
      title: cleanTitleHint(parsed.data.titleHint),
      mimeType: mime,
      sizeBytes: parsed.data.sizeBytes,
      durationSec: parsed.data.durationSec,
      language: parsed.data.language ?? 'auto',
      storageKey,
      status: 'pending' satisfies JobStatus,
      source: parsed.data.source ?? 'upload',
      isPrivate: parsed.data.source === 'whatsapp',
      skipInsights: parsed.data.skipInsights ?? false,
      attendance: parsed.data.attendance ?? [],
      speakerTimeline: parsed.data.speakerTimeline ?? [],
      nativeTranscript: parsed.data.nativeTranscript ?? null,
    })
    .returning()

  await cacheJobStatus(jobId, { status: 'pending', progress: 0 })

  return c.json({
    jobId: created.id,
    uploadMethod: 'api',
    uploadUrl: `/upload/${created.id}/storage`,
    transcriptSource: created.nativeTranscript !== null ? 'meet-native' : 'audio',
  })
})

jobsRouter.get('/', async (c) => {
  const user = c.get('user')
  const cursor = c.req.query('cursor')
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 100), 1), 200)

  const conditions = [
    or(
      eq(jobs.userId, user.id),
      and(
        eq(jobs.isPrivate, false),
        sql`EXISTS (SELECT 1 FROM job_members m WHERE m.job_id = ${jobs.id} AND m.user_id = ${user.id})`
      )
    )!,
    ne(jobs.status, 'cancelled'),
  ]
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
      source: jobs.source,
      isPrivate: jobs.isPrivate,
      speakerCount: sql<number | null>`(${jobs.transcript}->>'speakerCount')::int`,
      isOwner: sql<boolean>`${jobs.userId} = ${user.id}`,
      ownerName: sql<string | null>`COALESCE(${users.displayName}, ${users.username})`,
    })
    .from(jobs)
    .leftJoin(users, eq(users.id, jobs.userId))
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

  const access = await jobAccess(id, user.id)
  if (!access) return c.json({ error: 'Job tidak ditemukan' }, 404)
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1)
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
  const isOwner = access === 'owner'
  const [owner] = await db
    .select({ name: sql<string>`COALESCE(${users.displayName}, ${users.username})` })
    .from(users)
    .where(eq(users.id, job.userId))
    .limit(1)
  const members = isOwner
    ? await db.select({ userId: jobMembers.userId }).from(jobMembers).where(eq(jobMembers.jobId, id))
    : []
  return c.json({
    ...toJobDetail(job, isOwner, progress, items, await loadItemMembers(items)),
    isOwner,
    ownerName: owner?.name ?? null,
    memberIds: members.map((m) => m.userId),
  })
})

jobsRouter.put('/:id/members', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const parsed = memberIdsSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Daftar anggota tidak valid' }, 400)

  const [job] = await db
    .select({ id: jobs.id, isPrivate: jobs.isPrivate })
    .from(jobs)
    .where(and(eq(jobs.id, id), eq(jobs.userId, user.id)))
    .limit(1)
  if (!job) return c.json({ error: 'Job tidak ditemukan' }, 404)
  if (job.isPrivate) return c.json({ error: 'Rekaman privat seperti panggilan WhatsApp tidak bisa dibagikan.' }, 403)

  const next = await knownUserIds(parsed.data.userIds, user.id)
  await db.transaction(async (tx) => {
    await tx.delete(jobMembers).where(eq(jobMembers.jobId, id))
    if (next.length > 0) {
      await tx.insert(jobMembers).values(next.map((userId) => ({ jobId: id, userId, addedBy: user.id }))).onConflictDoNothing()
    }
  })
  return c.json({ memberIds: next })
})

jobsRouter.put('/:id/action-items/:itemId/members', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const itemId = c.req.param('itemId')
  const parsed = memberIdsSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Daftar penerima tidak valid' }, 400)

  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, id), eq(jobs.userId, user.id)))
    .limit(1)
  if (!job) return c.json({ error: 'Job tidak ditemukan' }, 404)
  if (job.isPrivate) return c.json({ error: 'Tugas dari rekaman privat tidak bisa dibagikan.' }, 403)

  const [item] = await db
    .select()
    .from(actionItems)
    .where(and(eq(actionItems.id, itemId), eq(actionItems.jobId, id)))
    .limit(1)
  if (!item) return c.json({ error: 'Tugas tidak ditemukan' }, 404)

  const next = await knownUserIds(parsed.data.userIds, '')
  const before = await db
    .select({ userId: actionItemMembers.userId })
    .from(actionItemMembers)
    .where(eq(actionItemMembers.itemId, itemId))
  const had = new Set(before.map((m) => m.userId))

  await db.transaction(async (tx) => {
    await tx.delete(actionItemMembers).where(eq(actionItemMembers.itemId, itemId))
    if (next.length > 0) {
      await tx.insert(actionItemMembers).values(next.map((userId) => ({ itemId, userId, addedBy: user.id }))).onConflictDoNothing()
    }
  })

  const added = next.filter((userId) => !had.has(userId) && userId !== user.id)
  if (added.length > 0) {
    const recipients = await db
      .select({ email: users.email, displayName: users.displayName, username: users.username })
      .from(users)
      .where(inArray(users.id, added))
    const meetingAt = new Date(new Date(job.createdAt).getTime() - (job.durationSec ?? 0) * 1000)
    for (const person of recipients) {
      if (!person.email) continue
      sendTaskDigest({
        to: person.email,
        tasks: [{ taskTitle: item.task, due: item.due ?? null }],
        meetingTitle: job.title || fallbackMeetingTitle(meetingAt),
        meetingAt,
        jobId: job.id,
        assigneeName: person.displayName ?? person.username,
      }).catch((err) => console.warn(`[${job.id}] Task share email failed:`, err instanceof Error ? err.message : err))
    }
  }

  return c.json({ itemId, sharedWith: next })
})

jobsRouter.get('/:id/audio', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')

  const [job] = await db
    .select({ storageKey: jobs.storageKey, userId: jobs.userId, mimeType: jobs.mimeType, isPrivate: jobs.isPrivate })
    .from(jobs)
    .where(eq(jobs.id, id))
    .limit(1)

  if (!job) return c.json({ error: 'Job tidak ditemukan' }, 404)
  const access = await jobAccess(id, user.id)
  if (!access && (!user.isAdmin || job.isPrivate)) return c.json({ error: 'Forbidden' }, 403)
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
      isPrivate: jobs.isPrivate,
    })
    .from(jobs)
    .where(and(eq(jobs.id, id), eq(jobs.userId, user.id)))
    .limit(1)

  if (!job) return c.json({ error: 'Job tidak ditemukan' }, 404)
  if (job.isPrivate) {
    return c.json({ error: 'Rekaman privat seperti panggilan WhatsApp tidak bisa dibagikan.' }, 403)
  }

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
    if (u.due !== undefined) {
      patch.due = u.due
      patch.dueOn = parseDue(u.due, new Date())
    }
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
        dueOn: parseDue(ins.due, new Date()),
        confidence: ins.confidence ?? 1,
        done: ins.done ?? false,
        order: 1000 + i,
      }))
    )
  }

  const refreshed = await loadActionItems(id)
  const members = await loadItemMembers(refreshed)
  return c.json({ actionItems: refreshed.map((it) => ({ ...it, sharedWith: members.get(it.id) ?? [] })) })
})

const askSchema = z.object({ question: z.string().trim().min(3).max(500) })
const ASK_PER_HOUR = 30

jobsRouter.post('/:id/ask', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const parsed = askSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Tulis pertanyaan minimal 3 huruf.' }, 400)

  if (!(await jobAccess(id, user.id))) return c.json({ error: 'Job tidak ditemukan' }, 404)
  const [job] = await db
    .select({ status: jobs.status, transcript: jobs.transcript, speakerNames: jobs.speakerNames, title: jobs.title })
    .from(jobs)
    .where(eq(jobs.id, id))
    .limit(1)
  if (!job) return c.json({ error: 'Job tidak ditemukan' }, 404)
  const segments = job.transcript?.segments ?? []
  if (job.status !== 'completed' || segments.length === 0) return c.json({ error: 'Transkrip rapat ini belum siap.' }, 409)

  const used = await cacheIncrWithTtl(`ask:${user.id}`, 3600)
  if (used > ASK_PER_HOUR) return c.json({ error: `Maksimal ${ASK_PER_HOUR} pertanyaan per jam. Coba lagi nanti.` }, 429)

  try {
    const result = await askMeeting({
      segments,
      question: parsed.data.question,
      speakerNames: job.speakerNames ?? {},
      title: job.title,
      summary: job.transcript?.summary,
      complete: (messages) => callGlmJson(messages),
    })
    return c.json(result)
  } catch (err) {
    console.warn(`[${id}] Ask failed:`, err instanceof Error ? err.message : err)
    return c.json({ error: 'Belum bisa menjawab sekarang. Coba lagi sebentar lagi.' }, 502)
  }
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
  items: ActionItemRow[] = [],
  itemMembers: Map<string, string[]> = new Map()
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
        dueOn: it.dueOn,
        confidence: it.confidence,
        done: it.done,
        order: it.order,
        sharedWith: itemMembers.get(it.id) ?? [],
      }))
      .sort((a, b) => a.order - b.order),
    error: job.errorMessage,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    cancelledAt: job.cancelledAt,
    shareToken: includeShareToken ? job.shareToken : undefined,
    shareTokenMom: includeShareToken ? job.shareTokenMom : undefined,
    storageKey: job.storageKey,
    source: job.source,
    isPrivate: job.isPrivate,
  }
}

async function loadItemMembers(items: ActionItemRow[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>()
  if (items.length === 0) return map
  const rows = await db
    .select({ itemId: actionItemMembers.itemId, userId: actionItemMembers.userId })
    .from(actionItemMembers)
    .where(inArray(actionItemMembers.itemId, items.map((it) => it.id)))
  for (const row of rows) map.set(row.itemId, [...(map.get(row.itemId) ?? []), row.userId])
  return map
}

async function loadActionItems(jobId: string): Promise<ActionItemRow[]> {
  return db
    .select()
    .from(actionItems)
    .where(eq(actionItems.jobId, jobId))
    .orderBy(asc(actionItems.order), asc(actionItems.createdAt))
}

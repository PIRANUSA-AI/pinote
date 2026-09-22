import { Hono } from 'hono'
import { and, asc, desc, eq, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/client.js'
import { actionItems, jobs, users } from '../db/schema.js'
import type { AppEnv } from '../middleware/auth.js'

export const tasksRouter = new Hono<AppEnv>()

async function findUserByToken(token: string) {
  const [row] = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
    })
    .from(users)
    .where(eq(users.taskShareToken, token))
    .limit(1)
  if (!row) return null
  return { ...row, matchName: (row.displayName ?? row.username).trim().toLowerCase() }
}

tasksRouter.get('/:token', async (c) => {
  const token = c.req.param('token')
  const user = await findUserByToken(token)
  if (!user) return c.json({ error: 'Link tugas tidak ditemukan' }, 404)

  const matchName = user.matchName

  const rows = await db
    .select({
      id: actionItems.id,
      jobId: actionItems.jobId,
      owner: actionItems.owner,
      task: actionItems.task,
      due: actionItems.due,
      confidence: actionItems.confidence,
      done: actionItems.done,
      order: actionItems.order,
      createdAt: actionItems.createdAt,
      jobTitle: jobs.title,
      jobFilename: jobs.filename,
      jobCreatedAt: jobs.createdAt,
      jobCompletedAt: jobs.completedAt,
    })
    .from(actionItems)
    .leftJoin(jobs, eq(jobs.id, actionItems.jobId))
    .where(
      and(
        or(sql`${actionItems.jobId} IS NULL`, eq(jobs.status, 'completed')),
        or(sql`${actionItems.jobId} IS NULL`, eq(jobs.isPrivate, false)),
        or(
          eq(actionItems.assigneeId, user.id),
          sql`LOWER(${actionItems.owner}) = ${matchName}`
        )
      )
    )
    .orderBy(desc(sql`COALESCE(${jobs.createdAt}, ${actionItems.createdAt})`), asc(actionItems.order), asc(actionItems.createdAt))

  // Group by job (meeting) or playground. First-appearance order.
  const playgroundId = '__playground'
  const byJob = new Map<
    string,
    {
      jobId: string
      title: string | null
      filename: string
      createdAt: Date
      completedAt: Date | null
      items: typeof rows
    }
  >()

  for (const r of rows) {
    const key = r.jobId ?? playgroundId
    const existing = byJob.get(key)
    if (existing) {
      existing.items.push(r)
    } else {
      byJob.set(key, {
        jobId: key,
        title: r.jobTitle,
        filename: r.jobFilename ?? '',
        createdAt: r.jobCreatedAt ?? r.createdAt,
        completedAt: r.jobCompletedAt,
        items: [r],
      })
    }
  }

  const openCount = rows.filter((r) => !r.done).length

  return c.json({
    user: { username: user.username, displayName: user.displayName ?? user.username },
    openCount,
    totalCount: rows.length,
    groups: [...byJob.values()],
  })
})

const itemPatchSchema = z.object({
  done: z.boolean().optional(),
  task: z.string().min(1).max(400).optional(),
  due: z.string().max(80).nullable().optional(),
})

tasksRouter.patch('/:token/item/:itemId', async (c) => {
  const token = c.req.param('token')
  const itemId = c.req.param('itemId')
  const user = await findUserByToken(token)
  if (!user) return c.json({ error: 'Link tugas tidak ditemukan' }, 404)

  const body = await c.req.json().catch(() => null)
  const parsed = itemPatchSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Input tidak valid' }, 400)
  }

  const matchName = user.matchName

  // Make sure this item actually belongs to the token holder before mutating.
  const [item] = await db
    .select({ id: actionItems.id, assigneeId: actionItems.assigneeId, owner: actionItems.owner })
    .from(actionItems)
    .where(eq(actionItems.id, itemId))
    .limit(1)
  if (!item) return c.json({ error: 'Tugas tidak ditemukan' }, 404)

  const owned =
    item.assigneeId === user.id || (item.owner ?? '').trim().toLowerCase() === matchName
  if (!owned) return c.json({ error: 'Tugas ini bukan milik kamu' }, 403)

  const patch: Record<string, unknown> = {}
  if (parsed.data.done !== undefined) patch.done = parsed.data.done
  if (parsed.data.task !== undefined) patch.task = parsed.data.task
  if (parsed.data.due !== undefined) patch.due = parsed.data.due
  if (Object.keys(patch).length === 0) return c.json({ ok: true, unchanged: true })

  // Pin assigneeId the first time the holder interacts with a name-matched item,
  // so future renames don't break ownership.
  if (item.assigneeId === null) patch.assigneeId = user.id

  await db.update(actionItems).set(patch).where(eq(actionItems.id, itemId))
  return c.json({ ok: true })
})

tasksRouter.post('/:token/item/:itemId/claim', async (c) => {
  const token = c.req.param('token')
  const itemId = c.req.param('itemId')
  const user = await findUserByToken(token)
  if (!user) return c.json({ error: 'Link tugas tidak ditemukan' }, 404)

  await db.update(actionItems).set({ assigneeId: user.id }).where(eq(actionItems.id, itemId))
  return c.json({ ok: true })
})

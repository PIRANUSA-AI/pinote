import { Hono } from 'hono'
import { eq, and, sql, count, sum, desc } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { db } from '../db/client.js'
import { users, sessions, jobs, actionItems } from '../db/schema.js'
import { createUser, findUserByUsername, hashPassword } from '../services/auth.js'
import { requireAdmin, type AppEnv } from '../middleware/auth.js'

const createSchema = z.object({
  username: z.string().min(2).max(64).regex(/^[a-zA-Z0-9_.-]+$/, 'Username hanya huruf, angka, _ . -'),
  password: z.string().min(8, 'Password minimal 8 karakter').max(256),
  isAdmin: z.boolean().optional(),
})

const passwordSchema = z.object({
  newPassword: z.string().min(8, 'Password minimal 8 karakter').max(256),
})

export const usersRouter = new Hono<AppEnv>()

usersRouter.use('*', requireAdmin)

usersRouter.get('/stats/overview', async (c) => {
  const [userAgg] = await db
    .select({
      total: count(users.id),
      admins: sum(sql`CASE WHEN ${users.isAdmin} THEN 1 ELSE 0 END`),
    })
    .from(users)

  const [jobAgg] = await db
    .select({
      total: count(jobs.id),
      completed: sum(sql`CASE WHEN ${jobs.status} = 'completed' THEN 1 ELSE 0 END`),
      failed: sum(sql`CASE WHEN ${jobs.status} = 'failed' THEN 1 ELSE 0 END`),
      totalDuration: sum(jobs.durationSec),
    })
    .from(jobs)

  const [itemAgg] = await db
    .select({
      total: count(actionItems.id),
      done: sum(sql`CASE WHEN ${actionItems.done} THEN 1 ELSE 0 END`),
    })
    .from(actionItems)

  const totalJobs = Number(jobAgg?.total ?? 0)
  const completedJobs = Number(jobAgg?.completed ?? 0)
  const failedJobs = Number(jobAgg?.failed ?? 0)
  const totalItems = Number(itemAgg?.total ?? 0)
  const doneItems = Number(itemAgg?.done ?? 0)

  return c.json({
    users: Number(userAgg?.total ?? 0),
    admins: Number(userAgg?.admins ?? 0),
    jobs: totalJobs,
    completedJobs,
    failedJobs,
    completionRate: totalJobs > 0 ? completedJobs / totalJobs : 0,
    totalDurationSec: Number(jobAgg?.totalDuration ?? 0),
    actionItems: totalItems,
    actionItemsDone: doneItems,
    actionItemsCompletionRate: totalItems > 0 ? doneItems / totalItems : 0,
  })
})

usersRouter.get('/stats/jobs-trend', async (c) => {
  const days = Math.min(Number(c.req.query('days') ?? 30), 365)
  const rows = (await db.execute(sql`
    SELECT
      d::date AS date,
      COUNT(j.id)::int AS count,
      COALESCE(SUM(j.duration_sec), 0)::int AS duration
    FROM generate_series(
      date_trunc('day', NOW() - (${days} - 1) * INTERVAL '1 day'),
      date_trunc('day', NOW()),
      INTERVAL '1 day'
    ) AS d
    LEFT JOIN jobs j ON date_trunc('day', j.created_at) = d AND j.status <> 'cancelled'
    GROUP BY d
    ORDER BY d ASC
  `)) as Array<{ date: string; count: number; duration: number }>
  return c.json({ points: rows.map((r) => ({ date: r.date, count: r.count, duration: r.duration })) })
})

usersRouter.get('/stats/top-users', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 8), 50)
  const rows = await db
    .select({
      userId: jobs.userId,
      jobsCompleted: count(jobs.id),
      totalDuration: sum(jobs.durationSec),
    })
    .from(jobs)
    .where(eq(jobs.status, 'completed'))
    .groupBy(jobs.userId)
    .orderBy(desc(count(jobs.id)))
    .limit(limit)

  const ids = rows.map((r) => r.userId)
  if (ids.length === 0) return c.json({ users: [] })

  const userRows = await db
    .select({ id: users.id, username: users.username, displayName: users.displayName })
    .from(users)
    .where(sql`${users.id} = ANY(${sql.raw(`ARRAY[${ids.map((id) => `'${id}'`).join(',')}]::text[]`)})`)

  const byId = new Map(userRows.map((u) => [u.id, u]))
  return c.json({
    users: rows.map((r) => ({
      ...(byId.get(r.userId) ?? { username: '?', displayName: null }),
      jobsCompleted: Number(r.jobsCompleted),
      totalDuration: Number(r.totalDuration ?? 0),
    })),
  })
})

const DEEPGRAM_COST_PER_MIN = 0.0043

usersRouter.get('/stats/cost-overview', async (c) => {
  const range = c.req.query('range') ?? 'all'

  let dateFilter = sql`1=1`
  if (range === 'day') dateFilter = sql`j.created_at >= NOW() - INTERVAL '1 day'`
  else if (range === 'week') dateFilter = sql`j.created_at >= NOW() - INTERVAL '7 days'`
  else if (range === 'month') dateFilter = sql`j.created_at >= NOW() - INTERVAL '30 days'`
  else if (range === 'year') dateFilter = sql`j.created_at >= NOW() - INTERVAL '365 days'`

  const [agg] = await db.execute(sql`
    SELECT COALESCE(SUM(j.duration_sec), 0)::int AS total_duration_sec,
           COUNT(j.id)::int AS total_jobs
    FROM jobs j
    WHERE j.status = 'completed' AND ${dateFilter}
  `)

  const totalDurationSec = Number((agg as { total_duration_sec: number }).total_duration_sec ?? 0)
  const totalJobs = Number((agg as { total_jobs: number }).total_jobs ?? 0)
  const estimatedCostUSD = parseFloat(((totalDurationSec / 60) * DEEPGRAM_COST_PER_MIN).toFixed(4))

  return c.json({ totalDurationSec, totalJobs, estimatedCostUSD, range })
})

usersRouter.get('/stats/recent-failures', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 6), 50)
  const rows = (await db.execute(sql`
    SELECT j.id, j.filename, j.error_message, j.created_at, u.username
    FROM jobs j
    JOIN users u ON u.id = j.user_id
    WHERE j.status = 'failed'
    ORDER BY j.created_at DESC
    LIMIT ${limit}
  `)) as Array<{ id: string; filename: string; error_message: string | null; created_at: string; username: string }>
  return c.json({ failures: rows })
})

usersRouter.get('/', async (c) => {
  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      isAdmin: users.isAdmin,
      creditSeconds: users.creditSeconds,
      displayName: users.displayName,
      taskShareToken: users.taskShareToken,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(users.createdAt)

  return c.json({ users: rows })
})

usersRouter.post('/', async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }, 400)
  }

  const existing = await findUserByUsername(parsed.data.username)
  if (existing) return c.json({ error: 'Username sudah dipakai' }, 409)

  const user = await createUser(parsed.data)
  return c.json(
    { id: user.id, username: user.username, isAdmin: user.isAdmin, createdAt: user.createdAt },
    201
  )
})

usersRouter.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const self = c.get('user')

  if (id === self.id) {
    return c.json({ error: 'Tidak bisa hapus akun sendiri' }, 400)
  }

  const [deleted] = await db.delete(users).where(eq(users.id, id)).returning({ id: users.id })
  if (!deleted) return c.json({ error: 'User tidak ditemukan' }, 404)

  return c.json({ ok: true })
})

usersRouter.patch('/:id/password', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => null)
  const parsed = passwordSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Password tidak valid' }, 400)

  const passwordHash = await hashPassword(parsed.data.newPassword)
  const [updated] = await db
    .update(users)
    .set({ passwordHash })
    .where(eq(users.id, id))
    .returning({ id: users.id })

  if (!updated) return c.json({ error: 'User tidak ditemukan' }, 404)

  // Invalidate all active sessions so the new password takes effect immediately
  await db.delete(sessions).where(eq(sessions.userId, id))

  return c.json({ ok: true })
})

const displayNameSchema = z.object({
  displayName: z.string().min(1).max(80),
})

usersRouter.patch('/:id/display-name', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => null)
  const parsed = displayNameSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Input tidak valid' }, 400)
  }

  const [updated] = await db
    .update(users)
    .set({ displayName: parsed.data.displayName.trim() })
    .where(eq(users.id, id))
    .returning({ id: users.id, displayName: users.displayName })

  if (!updated) return c.json({ error: 'User tidak ditemukan' }, 404)
  return c.json({ ok: true, displayName: updated.displayName })
})

usersRouter.post('/:id/task-token', async (c) => {
  const id = c.req.param('id')
  const token = nanoid(32)

  const [updated] = await db
    .update(users)
    .set({ taskShareToken: token })
    .where(eq(users.id, id))
    .returning({ id: users.id, taskShareToken: users.taskShareToken })

  if (!updated) return c.json({ error: 'User tidak ditemukan' }, 404)
  return c.json({ taskShareToken: updated.taskShareToken, taskPath: `/tasks/${updated.taskShareToken}` })
})

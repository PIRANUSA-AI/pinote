import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { z } from 'zod'
import { eq, and, sum, max, count, or, sql, asc, desc } from 'drizzle-orm'
import {
  buildSessionCookie,
  clearSessionCookie,
  createSession,
  createUser,
  deleteSession,
  findUserByUsername,
  findUserByEmail,
  verifyPassword,
} from '../services/auth.js'
import { verifyGoogleToken } from '../services/firebase.js'
import { requireAuth, type AppEnv } from '../middleware/auth.js'
import { db } from '../db/client.js'
import { actionItems, jobs, users } from '../db/schema.js'
import { cacheUserStats, getCachedUserStats, cacheIncrWithTtl, cacheDelete, cacheGet } from '../services/cache.js'
import { nanoid } from 'nanoid'

function crossSiteReady(forwardedProto: string | undefined, host: string | undefined): boolean {
  if (forwardedProto === 'https') return true
  if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging') return true
  const name = host ?? ''
  return name.startsWith('localhost') || name.startsWith('127.0.0.1')
}

const TRANSCRIPTION_COST_PER_MIN = Number(process.env.TRANSCRIPTION_COST_PER_MIN ?? 0.0021)
const LOGIN_RATE_LIMIT_MAX = Number(process.env.LOGIN_RATE_LIMIT_MAX ?? 10)
const LOGIN_RATE_LIMIT_WINDOW_SEC = Number(process.env.LOGIN_RATE_LIMIT_WINDOW_SEC ?? 15 * 60)
// When "1", allow public self-signup via POST /auth/register (used by the
// Pinote welcome onboarding flow). Off by default — admin-only account
// creation remains the gate for internal team membership.
const ALLOW_PUBLIC_SIGNUP = process.env.ALLOW_PUBLIC_SIGNUP === '1'
// Welcome credits granted to a newly self-registered user (seconds).
const SIGNUP_CREDIT_SECONDS = Number(process.env.SIGNUP_CREDIT_SECONDS ?? 0)

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
})

export const authRouter = new Hono<AppEnv>()

authRouter.post('/login', async (c) => {
  return c.json({ error: 'Login dengan password sudah ditutup. Silakan masuk dengan Google.' }, 403)
})

authRouter.post('/google', async (c) => {
  try {
    const { idToken } = await c.req.json()
    if (!idToken) return c.json({ error: 'Token tidak ditemukan' }, 400)

    const googleUser = await verifyGoogleToken(idToken)

    let user = await findUserByEmail(googleUser.email)
    if (!user) {
      const username = googleUser.email.split('@')[0].replace(/[^a-zA-Z0-9_.-]/g, '')
      user = await createUser({
        username,
        email: googleUser.email,
        displayName: googleUser.name,
      })
    }

    const { token } = await createSession(user.id)
    c.header('Set-Cookie', buildSessionCookie(token, { secure: crossSiteReady(c.req.header('x-forwarded-proto'), c.req.header('host')) }))

    return c.json({
      id: user.id,
      username: user.username,
      email: user.email,
      isAdmin: user.isAdmin,
      displayName: user.displayName,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Gagal masuk dengan Google'
    return c.json({ error: msg }, 401)
  }
})

authRouter.post('/logout', async (c) => {
  const token = getCookie(c, 'session')
  if (token) await deleteSession(token)
  c.header('Set-Cookie', clearSessionCookie({ secure: crossSiteReady(c.req.header('x-forwarded-proto'), c.req.header('host')) }))
  return c.json({ ok: true })
})

const registerSchema = z.object({
  username: z.string().min(2).max(64).regex(/^[a-zA-Z0-9_.-]+$/, 'Username hanya huruf, angka, _ . -'),
  password: z.string().min(8, 'Password minimal 8 karakter').max(256),
  displayName: z.string().min(1).max(80).optional(),
})

authRouter.post('/register', async (c) => {
  return c.json({ error: 'Pendaftaran sudah ditutup. Silakan masuk dengan Google.' }, 403)
})

authRouter.get('/signup-status', (c) => {
  return c.json({ enabled: ALLOW_PUBLIC_SIGNUP })
})

authRouter.get('/me', requireAuth, async (c) => {
  const user = c.get('user')
  return c.json({
    id: user.id,
    username: user.username,
    email: user.email,
    isAdmin: user.isAdmin,
    displayName: user.displayName,
  })
})

authRouter.get('/me/tasks', requireAuth, async (c) => {
  const user = c.get('user')
  const isAdminMode = user.isAdmin && c.req.query('admin') === '1'

  let rows: Array<{
    id: string
    jobId: string | null
    owner: string
    assigneeId: string | null
    task: string
    due: string | null
    confidence: number
    done: boolean
    order: number
    createdAt: Date
    jobTitle: string | null
    jobFilename: string | null
    jobCreatedAt: Date | null
    jobCompletedAt: Date | null
  }>

  if (isAdminMode) {
    rows = await db
      .select({
        id: actionItems.id,
        jobId: actionItems.jobId,
        owner: actionItems.owner,
        assigneeId: actionItems.assigneeId,
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
          or(sql`${actionItems.jobId} IS NULL`, eq(jobs.isPrivate, false))
        )
      )
      .orderBy(desc(sql`COALESCE(${jobs.createdAt}, ${actionItems.createdAt})`), asc(actionItems.order), asc(actionItems.createdAt))
  } else {
    const matchName = (user.displayName ?? user.username).trim().toLowerCase()
    rows = await db
      .select({
        id: actionItems.id,
        jobId: actionItems.jobId,
        owner: actionItems.owner,
        assigneeId: actionItems.assigneeId,
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
          or(eq(actionItems.assigneeId, user.id), sql`LOWER(${actionItems.owner}) = ${matchName}`)
        )
      )
      .orderBy(desc(sql`COALESCE(${jobs.createdAt}, ${actionItems.createdAt})`), asc(actionItems.order), asc(actionItems.createdAt))
  }

  const openCount = rows.filter((r) => !r.done).length

  if (isAdminMode) {
    const byOwner = new Map<string, { owner: string; items: typeof rows }>()
    for (const r of rows) {
      const existing = byOwner.get(r.owner)
      if (existing) {
        existing.items.push(r)
      } else {
        byOwner.set(r.owner, { owner: r.owner, items: [r] })
      }
    }

    return c.json({
      isAdminView: true,
      totalCount: rows.length,
      groups: [...byOwner.values()],
    })
  }

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

  return c.json({
    user: { username: user.username, displayName: user.displayName ?? user.username },
    openCount,
    totalCount: rows.length,
    groups: [...byJob.values()],
  })
})

const meTaskPatchSchema = z.object({
  itemId: z.string().min(1),
  done: z.boolean().optional(),
  task: z.string().min(1).max(400).optional(),
  due: z.string().max(80).nullable().optional(),
})

authRouter.patch('/me/tasks', requireAuth, async (c) => {
  const user = c.get('user')
  const body = await c.req.json().catch(() => null)
  const parsed = meTaskPatchSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Input tidak valid' }, 400)
  }

  const matchName = (user.displayName ?? user.username).trim().toLowerCase()

  const [item] = await db
    .select({ id: actionItems.id, assigneeId: actionItems.assigneeId, owner: actionItems.owner })
    .from(actionItems)
    .where(eq(actionItems.id, parsed.data.itemId))
    .limit(1)
  if (!item) return c.json({ error: 'Tugas tidak ditemukan' }, 404)

  const owned =
    item.assigneeId === user.id || (item.owner ?? '').trim().toLowerCase() === matchName
  if (!owned) return c.json({ error: 'Tugas ini bukan milik kamu' }, 403)

  const patch: Record<string, unknown> = {}
  if (parsed.data.done !== undefined) patch.done = parsed.data.done
  if (parsed.data.task !== undefined) patch.task = parsed.data.task
  if (parsed.data.due !== undefined) patch.due = parsed.data.due
  if (item.assigneeId === null) patch.assigneeId = user.id
  if (Object.keys(patch).length === 0) return c.json({ ok: true, unchanged: true })

  await db.update(actionItems).set(patch).where(eq(actionItems.id, parsed.data.itemId))
  return c.json({ ok: true })
})

const meDisplayNameSchema = z.object({
  displayName: z.string().min(1).max(80),
})

authRouter.patch('/me/display-name', requireAuth, async (c) => {
  const user = c.get('user')
  const body = await c.req.json().catch(() => null)
  const parsed = meDisplayNameSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Input tidak valid' }, 400)
  }
  await db
    .update(users)
    .set({ displayName: parsed.data.displayName.trim() })
    .where(eq(users.id, user.id))
  return c.json({ ok: true, displayName: parsed.data.displayName.trim() })
})

const USERNAME_MAX_CHANGES = 3

const usernameSchema = z.object({
  username: z.string().min(2).max(64).regex(/^[a-zA-Z0-9_.-]+$/, 'Username hanya huruf, angka, _ . -'),
})

authRouter.patch('/me/username', requireAuth, async (c) => {
  const user = c.get('user')
  const body = await c.req.json().catch(() => null)
  const parsed = usernameSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Input tidak valid' }, 400)

  const [row] = await db
    .select({ usernameChanges: users.usernameChanges })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1)

  if (!row) return c.json({ error: 'User tidak ditemukan' }, 404)

  if (row.usernameChanges >= USERNAME_MAX_CHANGES) {
    return c.json({ error: `Kesempatan ganti username habis (maks ${USERNAME_MAX_CHANGES}x). Hubungi admin.` }, 403)
  }

  const existing = await findUserByUsername(parsed.data.username)
  if (existing && existing.id !== user.id) return c.json({ error: 'Username sudah dipakai' }, 409)

  await db
    .update(users)
    .set({
      username: parsed.data.username,
      usernameChanges: sql`${users.usernameChanges} + 1`,
      previousUsernames: sql`COALESCE(${users.previousUsernames}, '[]'::jsonb) || ${JSON.stringify([user.username])}::jsonb`,
    })
    .where(eq(users.id, user.id))

  return c.json({ ok: true, username: parsed.data.username, usernameChanges: row.usernameChanges + 1 })
})

authRouter.get('/me/aliases', requireAuth, async (c) => {
  const user = c.get('user')
  const [row] = await db
    .select({ nameAliases: users.nameAliases })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1)

  return c.json({ aliases: row?.nameAliases ?? [] })
})

const aliasesSchema = z.object({
  aliases: z.array(z.string().min(1).max(40)).max(15),
})

authRouter.patch('/me/aliases', requireAuth, async (c) => {
  const user = c.get('user')
  const body = await c.req.json().catch(() => null)
  const parsed = aliasesSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Input tidak valid' }, 400)

  await db
    .update(users)
    .set({ nameAliases: parsed.data.aliases })
    .where(eq(users.id, user.id))

  return c.json({ ok: true, aliases: parsed.data.aliases })
})

authRouter.get('/me/emails', requireAuth, async (c) => {
  const user = c.get('user')
  const [row] = await db
    .select({ email: users.email, ccEmails: users.ccEmails })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1)

  return c.json({ primary: row?.email ?? '', cc: row?.ccEmails ?? [] })
})

const emailsSchema = z.object({
  cc: z.array(z.string().email('Email tidak valid')).max(3),
})

authRouter.patch('/me/emails', requireAuth, async (c) => {
  const user = c.get('user')
  const body = await c.req.json().catch(() => null)
  const parsed = emailsSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Input tidak valid' }, 400)

  await db
    .update(users)
    .set({ ccEmails: parsed.data.cc })
    .where(eq(users.id, user.id))

  return c.json({ ok: true, cc: parsed.data.cc })
})

authRouter.post('/me/task-token', requireAuth, async (c) => {
  const user = c.get('user')
  const token = nanoid()
  const [updated] = await db
    .update(users)
    .set({ taskShareToken: token })
    .where(eq(users.id, user.id))
    .returning({ taskShareToken: users.taskShareToken })
  if (!updated) return c.json({ error: 'User tidak ditemukan' }, 404)
  return c.json({ taskShareToken: updated.taskShareToken, taskPath: `/tasks/${updated.taskShareToken}` })
})

authRouter.get('/me/stats', requireAuth, async (c) => {
  const user = c.get('user')

  const cached = await getCachedUserStats(user.id)
  if (cached) return c.json(cached)

  const [agg] = await db
    .select({
      totalDurationSec: sum(jobs.durationSec),
      latestDurationSec: max(jobs.durationSec),
      totalJobs: count(jobs.id),
    })
    .from(jobs)
    .where(and(eq(jobs.userId, user.id), eq(jobs.status, 'completed')))

  const [userRow] = await db
    .select({ createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1)

  const totalDurationSec = Number(agg?.totalDurationSec ?? 0)
  const estimatedCostUSD = parseFloat(((totalDurationSec / 60) * TRANSCRIPTION_COST_PER_MIN).toFixed(4))

  const stats = {
    totalDurationSec,
    latestDurationSec: Number(agg?.latestDurationSec ?? 0),
    totalJobs: Number(agg?.totalJobs ?? 0),
    estimatedCostUSD,
    memberSince: userRow?.createdAt ?? null,
  }

  await cacheUserStats(user.id, stats)
  return c.json(stats)
})

function loginRateLimitKey(ip: string, username: string): string {
  return `login:${ip.split(',')[0].trim()}:${username.trim().toLowerCase()}`
}

async function isLoginRateLimited(key: string): Promise<boolean> {
  const stored = await getCachedLoginCount(key)
  if (stored === null) return false
  return stored >= LOGIN_RATE_LIMIT_MAX
}

async function recordFailedLogin(key: string): Promise<void> {
  await cacheIncrWithTtl(`rate:${key}`, LOGIN_RATE_LIMIT_WINDOW_SEC)
}

async function clearFailedLogin(key: string): Promise<void> {
  await cacheDelete(`rate:${key}`)
}

async function getCachedLoginCount(key: string): Promise<number | null> {
  return cacheGet<number>(`rate:${key}`)
}

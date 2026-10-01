import { Hono } from 'hono'
import { z } from 'zod'
import { eq, and, sql, asc, desc } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import OpenAI from 'openai'
import { db } from '../db/client.js'
import { actionItemMembers, actionItems, reminders, users } from '../db/schema.js'
import { requireAdmin, requireAuth, type AppEnv } from '../middleware/auth.js'

const GLM_BASE_URL = process.env.GLM_BASE_URL ?? 'https://api.z.ai/api/paas/v4'
const GLM_MODEL = process.env.GLM_MODEL ?? 'glm-5.2'

function glmClient(): OpenAI {
  const k = process.env.GLM_API_KEY
  if (!k) throw new Error('GLM_API_KEY is required')
  return new OpenAI({ apiKey: k, baseURL: GLM_BASE_URL })
}

const REMINDER_TEMPLATES = [
  (o: string) => `Hey @${o}, tugas ini masih pending nih. Ada kendala?`,
  (o: string) => `Halo @${o}, gimana progress tugasnya? Butuh bantuan?`,
  (o: string) => `Masih ada yang belum kelar nih @${o}, ada yang bisa dibantu?`,
  (o: string) => `Pengingat @${o}: tugas ini belum selesai. Perlu bantuan?`,
  (o: string) => `Hai @${o}, cek yuk tugas yang masih terbuka. Ada masalah?`,
  (o: string) => `@${o}, tugasnya gimana nih? Masih ada hambatan?`,
  (o: string) => `Just a lil reminder @${o}, tugas ini masih nunggu. Butuh bantuan?`,
  (o: string) => `@${o}, jangan lupa ya, ada tugas yang masih pending.`,
  (o: string) => `Hai @${o}, aku cek tadi tugas ini belum kelar. Ada yang bisa gue bantu?`,
  (o: string) => `@${o}, progress tugasnya gimana? Share dong biar kita tau.`,
  (o: string) => `Eh @${o}, ini tugasnya udah dikerjain belum? Kalau mentok bilang ya.`,
  (o: string) => `@${o}, sekedar ingetin aja, tugas ini masih on progress belum nih?`,
]

export const remindersRouter = new Hono<AppEnv>()

async function resolveAssignee(taskId: string): Promise<{ userId: string | null; owner: string } | null> {
  const [item] = await db
    .select({
      id: actionItems.id,
      jobId: actionItems.jobId,
      owner: actionItems.owner,
      assigneeId: actionItems.assigneeId,
    })
    .from(actionItems)
    .where(eq(actionItems.id, taskId))
    .limit(1)
  if (!item) return null

  if (item.assigneeId) {
    return { userId: item.assigneeId, owner: item.owner }
  }

  const [member] = await db
    .select({ userId: actionItemMembers.userId })
    .from(actionItemMembers)
    .where(eq(actionItemMembers.itemId, taskId))
    .orderBy(asc(actionItemMembers.createdAt))
    .limit(1)
  if (member) return { userId: member.userId, owner: item.owner }
  if (item.jobId) return { userId: null, owner: item.owner }

  const matchName = item.owner.trim().toLowerCase()
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`LOWER(COALESCE(${users.displayName}, ${users.username})) = ${matchName}`)
    .limit(1)
  if (user) return { userId: user.id, owner: item.owner }

  return { userId: null, owner: item.owner }
}

async function lastReminderSent(taskId: string): Promise<Date | null> {
  const [row] = await db
    .select({ createdAt: reminders.createdAt })
    .from(reminders)
    .where(eq(reminders.taskId, taskId))
    .orderBy(desc(reminders.createdAt))
    .limit(1)
  return row?.createdAt ?? null
}

function generateReminderMessage(_taskText: string, ownerName: string): string {
  const idx = Math.floor(Math.random() * REMINDER_TEMPLATES.length)
  return REMINDER_TEMPLATES[idx](ownerName)
}

remindersRouter.post('/tasks/:id', requireAdmin, async (c) => {
  const user = c.get('user')
  const taskId = c.req.param('id')

  const resolved = await resolveAssignee(taskId)
  if (!resolved) return c.json({ error: 'Tugas tidak ditemukan' }, 404)
  if (!resolved.userId) return c.json({ error: 'Tugas ini belum memiliki pemilik yang terdaftar' }, 400)

  const lastSent = await lastReminderSent(taskId)
  if (lastSent) {
    const msSinceLast = Date.now() - lastSent.getTime()
    const oneHour = 60 * 60 * 1000
    if (msSinceLast < oneHour) {
      const remaining = Math.ceil((oneHour - msSinceLast) / 60000)
      return c.json({ error: `Sudah dikirim pengingat. Coba lagi ${remaining} menit lagi.` }, 429)
    }
  }

  const [taskRow] = await db
    .select({ task: actionItems.task })
    .from(actionItems)
    .where(eq(actionItems.id, taskId))
    .limit(1)
  if (!taskRow) return c.json({ error: 'Tugas tidak ditemukan' }, 404)

  const message = await generateReminderMessage(taskRow.task, resolved.owner)

  const id = nanoid()
  await db.insert(reminders).values({
    id,
    taskId,
    fromUserId: user.id,
    toUserId: resolved.userId,
    message,
    read: false,
  })

  return c.json({
    id,
    taskId,
    message,
    task: taskRow.task,
    owner: resolved.owner,
  }, 201)
})

remindersRouter.get('/', requireAuth, async (c) => {
  const user = c.get('user')

  const rows = await db
    .select({
      id: reminders.id,
      taskId: reminders.taskId,
      message: reminders.message,
      read: reminders.read,
      createdAt: reminders.createdAt,
      task: actionItems.task,
      owner: actionItems.owner,
    })
    .from(reminders)
    .leftJoin(actionItems, eq(actionItems.id, reminders.taskId))
    .where(
      and(
        eq(reminders.toUserId, user.id),
        eq(reminders.read, false),
      )
    )
    .orderBy(desc(reminders.createdAt))

  const latestPerTask = new Map<string, typeof rows[0]>()
  for (const r of rows) {
    if (!latestPerTask.has(r.taskId)) {
      latestPerTask.set(r.taskId, r)
    }
  }

  return c.json({ reminders: [...latestPerTask.values()] })
})

remindersRouter.get('/unread-count', requireAuth, async (c) => {
  const user = c.get('user')

  const [row] = await db
    .select({ count: sql<number>`COUNT(DISTINCT ${reminders.taskId})` })
    .from(reminders)
    .where(
      and(
        eq(reminders.toUserId, user.id),
        eq(reminders.read, false),
      )
    )

  return c.json({ count: Number(row?.count ?? 0) })
})

remindersRouter.patch('/:id/dismiss', requireAuth, async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')

  const [existing] = await db
    .select({ id: reminders.id, toUserId: reminders.toUserId })
    .from(reminders)
    .where(eq(reminders.id, id))
    .limit(1)

  if (!existing) return c.json({ error: 'Pengingat tidak ditemukan' }, 404)
  if (existing.toUserId !== user.id) return c.json({ error: 'Bukan pengingat milik kamu' }, 403)

  await db.update(reminders).set({ read: true }).where(eq(reminders.id, id))
  return c.json({ ok: true })
})

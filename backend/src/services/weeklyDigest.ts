import { and, desc, eq, gt, isNotNull, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { actionItems, jobs, users } from '../db/schema.js'
import { cacheIncrWithTtl } from './cache.js'
import { fallbackMeetingTitle, renderWeeklyDigest, sendEmail, type WeeklyTask } from './email.js'

const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const SEND_HOURS = [8, 9]

export function weeklyWindow(now: Date): { weekKey: string; today: string; weekEnd: string } | null {
  const local = new Date(now.getTime() + JAKARTA_OFFSET_MS)
  if (local.getUTCDay() !== 1 || !SEND_HOURS.includes(local.getUTCHours())) return null
  const day = (offset: number) => new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) + offset * DAY_MS).toISOString().slice(0, 10)
  return { weekKey: day(0), today: day(0), weekEnd: day(6) }
}

export function splitTasks(tasks: WeeklyTask[], today: string, weekEnd: string) {
  const overdue = tasks.filter((task) => task.dueOn && task.dueOn < today)
  const dueSoon = tasks.filter((task) => task.dueOn && task.dueOn >= today && task.dueOn <= weekEnd)
  return { overdue, dueSoon, otherOpen: tasks.length - overdue.length - dueSoon.length }
}

let lastCompletedWeek = ''

export async function maybeSendWeeklyDigests(now = new Date()): Promise<void> {
  if (process.env.WEEKLY_DIGEST === 'off') return
  const window = weeklyWindow(now)
  if (!window || lastCompletedWeek === window.weekKey) return

  const people = await db
    .select({ id: users.id, email: users.email, username: users.username, displayName: users.displayName })
    .from(users)
    .where(isNotNull(users.email))

  const since = new Date(now.getTime() - 7 * DAY_MS)
  for (const person of people) {
    if (!person.email) continue
    const claimed = await cacheIncrWithTtl(`weeklyDigest:${window.weekKey}:${person.id}`, 8 * 24 * 60 * 60)
    if (claimed !== 1) continue
    const matchName = (person.displayName ?? person.username).trim().toLowerCase()
    try {
      const open = await db
        .select({ task: actionItems.task, dueOn: actionItems.dueOn, due: actionItems.due, title: jobs.title })
        .from(actionItems)
        .leftJoin(jobs, eq(jobs.id, actionItems.jobId))
        .where(and(
          eq(actionItems.done, false),
          or(sql`${actionItems.jobId} IS NULL`, eq(jobs.status, 'completed')),
          or(eq(actionItems.assigneeId, person.id), sql`LOWER(${actionItems.owner}) = ${matchName}`),
        ))
        .orderBy(sql`${actionItems.dueOn} ASC NULLS LAST`)
        .limit(200)

      const meetings = await db
        .select({ id: jobs.id, title: jobs.title, createdAt: jobs.createdAt, durationSec: jobs.durationSec })
        .from(jobs)
        .where(and(eq(jobs.userId, person.id), eq(jobs.status, 'completed'), gt(jobs.createdAt, since)))
        .orderBy(desc(jobs.createdAt))
        .limit(20)

      const tasks: WeeklyTask[] = open.map((row) => ({ task: row.task, dueOn: row.dueOn, due: row.due, meetingTitle: row.title }))
      const split = splitTasks(tasks, window.today, window.weekEnd)
      const rendered = renderWeeklyDigest({
        to: person.email,
        name: person.displayName ?? person.username,
        ...split,
        meetings: meetings.map((meeting) => {
          const at = new Date(new Date(meeting.createdAt).getTime() - (meeting.durationSec ?? 0) * 1000)
          return { id: meeting.id, at, title: meeting.title || fallbackMeetingTitle(at) }
        }),
        now,
      })
      if (!rendered) continue
      await sendEmail({ to: person.email, ...rendered })
    } catch (err) {
      console.warn(`Weekly digest for ${person.id} failed:`, err instanceof Error ? err.message : err)
    }
  }
  lastCompletedWeek = window.weekKey
  console.log(`Weekly digest pass for ${window.weekKey} finished for ${people.length} user(s)`)
}

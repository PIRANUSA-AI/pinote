import { and, eq, or, sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client.js'
import { actionItems, jobs } from '../db/schema.js'

export function taskVisibleTo(userId: string, matchName: string): SQL {
  return or(
    eq(actionItems.assigneeId, userId),
    sql`EXISTS (SELECT 1 FROM action_item_members m WHERE m.item_id = ${actionItems.id} AND m.user_id = ${userId})`,
    and(sql`${actionItems.jobId} IS NULL`, sql`LOWER(${actionItems.owner}) = ${matchName}`),
    and(eq(jobs.userId, userId), sql`LOWER(${actionItems.owner}) = ${matchName}`)
  )!
}

export async function findTaskFor(itemId: string, userId: string, matchName: string) {
  const [row] = await db
    .select({ id: actionItems.id, assigneeId: actionItems.assigneeId, owner: actionItems.owner })
    .from(actionItems)
    .leftJoin(jobs, eq(jobs.id, actionItems.jobId))
    .where(and(eq(actionItems.id, itemId), taskVisibleTo(userId, matchName)))
    .limit(1)
  return row ?? null
}

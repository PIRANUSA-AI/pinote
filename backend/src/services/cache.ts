import { and, eq, gt, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { cacheEntries } from '../db/schema.js'

const STATUS_TTL_SEC = 60 * 30
const STATS_TTL_SEC = 300

export async function cacheSet(key: string, value: unknown, ttlSec: number): Promise<void> {
  try {
    const expiresAt = new Date(Date.now() + ttlSec * 1000)
    await db
      .insert(cacheEntries)
      .values({ key, value: value as never, expiresAt })
      .onConflictDoUpdate({
        target: cacheEntries.key,
        set: {
          value: value as never,
          expiresAt,
          updatedAt: new Date(),
        },
      })
  } catch (err) {
    console.warn(`cacheSet(${key}) failed:`, err)
  }
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const [row] = await db
      .select({ value: cacheEntries.value })
      .from(cacheEntries)
      .where(and(eq(cacheEntries.key, key), gt(cacheEntries.expiresAt, new Date())))
      .limit(1)
    return (row?.value as T | undefined) ?? null
  } catch (err) {
    console.warn(`cacheGet(${key}) failed:`, err)
    return null
  }
}

export async function cacheJobStatus(jobId: string, status: unknown): Promise<void> {
  await cacheSet(`job:${jobId}:status`, status, STATUS_TTL_SEC)
}

export async function getCachedJobStatus<T = unknown>(jobId: string): Promise<T | null> {
  return cacheGet<T>(`job:${jobId}:status`)
}

export async function cacheUserStats(userId: string, stats: unknown): Promise<void> {
  await cacheSet(`user:stats:${userId}`, stats, STATS_TTL_SEC)
}

export async function getCachedUserStats<T = unknown>(userId: string): Promise<T | null> {
  return cacheGet<T>(`user:stats:${userId}`)
}

export async function invalidateUserStats(userId: string): Promise<void> {
  try {
    await db.delete(cacheEntries).where(eq(cacheEntries.key, `user:stats:${userId}`))
  } catch (err) {
    console.warn('invalidateUserStats failed:', err)
  }
}

export async function setWorkerHeartbeat(workerId: string): Promise<void> {
  await cacheSet(
    'worker:heartbeat',
    { workerId, at: new Date().toISOString() },
    90
  )
}

export async function getWorkerHeartbeat(): Promise<{ workerId: string; at: string } | null> {
  return cacheGet<{ workerId: string; at: string }>('worker:heartbeat')
}

// Atomic increment with TTL reset on first use. Used by login rate-limit.
export async function cacheIncrWithTtl(key: string, ttlSec: number): Promise<number> {
  try {
    const expiresAt = new Date(Date.now() + ttlSec * 1000)
    const [row] = await db
      .insert(cacheEntries)
      .values({ key, value: 1 as never, expiresAt })
      .onConflictDoUpdate({
        target: cacheEntries.key,
        set: {
          value: sql`to_jsonb((((${cacheEntries.value})::text)::numeric + 1))`,
          updatedAt: new Date(),
        },
      })
      .returning({
        n: sql<number>`((${cacheEntries.value})::text)::numeric`,
      })
    return Number(row?.n ?? 0)
  } catch (err) {
    console.warn(`cacheIncrWithTtl(${key}) failed:`, err)
    return 0
  }
}

export async function cacheDelete(key: string): Promise<void> {
  try {
    await db.delete(cacheEntries).where(eq(cacheEntries.key, key))
  } catch (err) {
    console.warn(`cacheDelete(${key}) failed:`, err)
  }
}

// Health probe: round-trip write + read.
export async function checkCache(): Promise<boolean> {
  try {
    await cacheSet('health:cache', 'ok', 30)
    return (await cacheGet<string>('health:cache')) === 'ok'
  } catch {
    return false
  }
}

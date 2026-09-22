import { Hono } from 'hono'
import { and, eq, sql } from 'drizzle-orm'
import { Readable } from 'node:stream'
import { db } from '../db/client.js'
import { jobs, users, type JobStatus } from '../db/schema.js'
import { requireAuth, type AppEnv } from '../middleware/auth.js'
import { cacheJobStatus } from '../services/cache.js'
import { writeObjectStream } from '../services/storage.js'

export const uploadRouter = new Hono<AppEnv>()

uploadRouter.use('*', requireAuth)

uploadRouter.put('/:jobId/storage', async (c) => {
  const user = c.get('user')
  const jobId = c.req.param('jobId')

  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.userId, user.id)))
    .limit(1)

  if (!job) return c.json({ error: 'Job tidak ditemukan' }, 404)
  if (!job.storageKey) return c.json({ error: 'Job ini tidak punya storage key' }, 409)
  const retryableFailure = job.status === 'failed' && !job.uploadedAt
  if (job.status !== 'pending' && !retryableFailure) {
    return c.json({ error: `Job sudah ${job.status}, tidak bisa upload ulang` }, 409)
  }

  const body = c.req.raw.body
  if (!body) return c.json({ error: 'Request body kosong' }, 400)

  const contentLength = Number(c.req.header('content-length') ?? 0)
  if (!contentLength) return c.json({ error: 'Content-Length missing' }, 411)
  if (job.sizeBytes && contentLength !== job.sizeBytes) {
    return c.json({ error: 'Ukuran upload tidak cocok dengan job yang dibuat' }, 400)
  }

  await db.update(jobs).set({ status: 'uploading' satisfies JobStatus, errorMessage: null }).where(eq(jobs.id, jobId))
  await cacheJobStatus(jobId, { status: 'uploading', progress: 10 })

  try {
    await writeObjectStream({
      key: job.storageKey,
      mimeType: job.mimeType,
      sizeBytes: contentLength,
      body: Readable.from(body),
    })

    await db
      .update(jobs)
      .set({
        status: 'queued' satisfies JobStatus,
        uploadedAt: new Date(),
        queuedAt: new Date(),
      })
      .where(and(eq(jobs.id, jobId), eq(jobs.userId, user.id)))

    await cacheJobStatus(jobId, { status: 'queued', progress: 20 })
    return c.json({ jobId, status: 'queued' })
  } catch (err) {
    console.error(`[${jobId}] Menulis audio ke disk gagal:`, err)
    const msg = err instanceof Error ? err.message : String(err)
    await Promise.all([
      db
        .update(jobs)
        .set({ status: 'failed' satisfies JobStatus, errorMessage: `Upload gagal: ${msg}` })
        .where(eq(jobs.id, jobId)),
      cacheJobStatus(jobId, { status: 'failed', error: msg }),
    ])
    return c.json({ error: 'Gagal menyimpan audio', detail: msg }, 502)
  }
})

import 'dotenv/config'
import { setGlobalDispatcher, Agent } from 'undici'
import { and, asc, eq, isNotNull, lt, sql } from 'drizzle-orm'
import { db } from './db/client.js'
import { jobs, users, type JobStatus } from './db/schema.js'
import { cacheJobStatus, setWorkerHeartbeat } from './services/cache.js'
import { checkStorage, mediaRoot } from './services/storage.js'
import { processStoredTranscriptionJob } from './services/transcription.js'

setGlobalDispatcher(new Agent({
  headersTimeout: 180 * 60 * 1000,
  bodyTimeout: 180 * 60 * 1000,
  connectTimeout: 30 * 1000,
}))

const pollMs = Number(process.env.WORKER_POLL_MS ?? 5000)
const workerId = `${process.env.FLY_MACHINE_ID ?? 'local'}-${process.pid}`

async function claimQueuedJob(): Promise<string | null> {
  const [candidate] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(eq(jobs.status, 'queued'))
    .orderBy(asc(jobs.queuedAt), asc(jobs.createdAt))
    .limit(1)

  if (!candidate) return null

  const [claimed] = await db
    .update(jobs)
    .set({
      status: 'transcribing' satisfies JobStatus,
      startedAt: new Date(),
      errorMessage: null,
    })
    .where(and(eq(jobs.id, candidate.id), eq(jobs.status, 'queued')))
    .returning({ id: jobs.id })

  return claimed?.id ?? null
}

let lastStuckRecovery = 0

async function recoverStuckTranscribingJobs(): Promise<void> {
  const now = Date.now()
  if (now - lastStuckRecovery < 60_000) return
  lastStuckRecovery = now

  const cutoff = new Date(now - 180 * 60 * 1000)
  const stuck = await db
    .update(jobs)
    .set({
      status: 'failed' satisfies JobStatus,
      errorMessage: 'Job timeout: transkripsi tidak selesai dalam 3 jam',
    })
    .where(and(eq(jobs.status, 'transcribing'), lt(jobs.startedAt, cutoff)))
    .returning({ id: jobs.id })

  if (stuck.length > 0) {
    console.log(`Recovered ${stuck.length} stuck transcribing job(s):`, stuck.map((j) => j.id))
  }
}

async function tick(): Promise<void> {
  await setWorkerHeartbeat(workerId)
  await recoverStuckTranscribingJobs()
  const jobId = await claimQueuedJob()
  if (!jobId) return

  console.log(`[${jobId}] Worker ${workerId} claimed job`)
  await cacheJobStatus(jobId, { status: 'transcribing', progress: 30 })

  const heartbeatTimer = setInterval(() => {
    setWorkerHeartbeat(workerId).catch(() => {})
  }, 30_000)

  try {
    await processStoredTranscriptionJob(jobId)
  } finally {
    clearInterval(heartbeatTimer)
  }
}

async function main() {
  try {
    await checkStorage()
    console.log(`Worker media root: ${mediaRoot()}`)
  } catch (err) {
    throw new Error(`Worker requires a writable MEDIA_ROOT (${mediaRoot()}): ${err instanceof Error ? err.message : String(err)}`)
  }

  const recovered = await db
    .update(jobs)
    .set({
      status: 'queued' satisfies JobStatus,
      queuedAt: new Date(),
      startedAt: null,
      errorMessage: 'Worker restart; job re-queued.',
    })
    .where(and(eq(jobs.status, 'transcribing'), isNotNull(jobs.storageKey)))
    .returning({ id: jobs.id })

  if (recovered.length > 0) {
    console.log(`Re-queued ${recovered.length} in-flight job(s):`, recovered.map((job) => job.id))
  }

  console.log(`Pinote worker ${workerId} polling every ${pollMs}ms`)
  for (;;) {
    try {
      await tick()
    } catch (err) {
      console.error('Worker tick failed:', err)
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

void main()

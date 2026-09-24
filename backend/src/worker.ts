import 'dotenv/config'
import { setGlobalDispatcher, Agent } from 'undici'
import { and, asc, eq, isNotNull, lt, notInArray, sql } from 'drizzle-orm'
import { db } from './db/client.js'
import { jobs, users, type JobStatus } from './db/schema.js'
import { cacheJobStatus, setWorkerHeartbeat } from './services/cache.js'
import { checkStorage, mediaRoot } from './services/storage.js'
import { activeInsights, processStoredTranscriptionJob, runInsights } from './services/transcription.js'
import { maybeSendWeeklyDigests } from './services/weeklyDigest.js'

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

const INSIGHT_SWEEP_MS = 60_000
const INSIGHT_BACKOFF_MS = 2 * 60 * 1000
const INSIGHT_STALE_MS = 30 * 60 * 1000
const INSIGHT_BATCH = 3
let lastInsightSweep = 0

async function sweepInsights(): Promise<void> {
  const now = Date.now()
  if (now - lastInsightSweep < INSIGHT_SWEEP_MS) return
  lastInsightSweep = now

  const live = [...activeInsights]
  await db
    .update(jobs)
    .set({ insightStatus: 'pending' })
    .where(and(
      eq(jobs.insightStatus, 'running'),
      lt(jobs.insightStartedAt, new Date(now - INSIGHT_STALE_MS)),
      live.length > 0 ? notInArray(jobs.id, live) : undefined,
    ))

  const due = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(
      eq(jobs.insightStatus, 'pending'),
      eq(jobs.status, 'completed'),
      sql`(${jobs.insightStartedAt} IS NULL OR ${jobs.insightStartedAt} < ${new Date(now - INSIGHT_BACKOFF_MS)}::timestamptz - make_interval(secs => ${INSIGHT_BACKOFF_MS / 1000} * ${jobs.insightAttempts}))`,
    ))
    .orderBy(asc(jobs.completedAt))
    .limit(INSIGHT_BATCH)

  for (const { id } of due) {
    if (activeInsights.has(id)) continue
    console.log(`[${id}] Worker ${workerId} resuming insights`)
    runInsights(id).catch((err) => console.error(`[${id}] Insight resume failed:`, err))
  }
}

const WEEKLY_CHECK_MS = 10 * 60 * 1000
let lastWeeklyCheck = 0

function checkWeeklyDigest(): void {
  const now = Date.now()
  if (now - lastWeeklyCheck < WEEKLY_CHECK_MS) return
  lastWeeklyCheck = now
  maybeSendWeeklyDigests().catch((err) => console.error('Weekly digest failed:', err))
}

async function tick(): Promise<void> {
  await setWorkerHeartbeat(workerId)
  await recoverStuckTranscribingJobs()
  await sweepInsights()
  checkWeeklyDigest()
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

  const interrupted = await db
    .update(jobs)
    .set({ insightStatus: 'pending', insightStartedAt: null })
    .where(eq(jobs.insightStatus, 'running'))
    .returning({ id: jobs.id })

  if (interrupted.length > 0) {
    console.log(`Resuming insights for ${interrupted.length} job(s) interrupted by a restart:`, interrupted.map((job) => job.id))
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

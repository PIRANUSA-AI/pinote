import 'dotenv/config'
import { setGlobalDispatcher, Agent } from 'undici'

setGlobalDispatcher(new Agent({
  headersTimeout: 180 * 60 * 1000,
  bodyTimeout: 180 * 60 * 1000,
  connectTimeout: 30 * 1000,
}))

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import type { AppEnv } from './middleware/auth.js'
import { authRouter } from './routes/auth.js'
import { usersRouter } from './routes/users.js'
import { jobsRouter } from './routes/jobs.js'
import { uploadRouter } from './routes/upload.js'
import { shareRouter } from './routes/share.js'
import { tasksRouter } from './routes/tasks.js'
import { playgroundRouter } from './routes/playground.js'
import { searchRouter } from './routes/search.js'
import { remindersRouter } from './routes/reminders.js'
import { db } from './db/client.js'
import { jobs } from './db/schema.js'
import { inArray, sql } from 'drizzle-orm'
import { checkCache, getWorkerHeartbeat } from './services/cache.js'
import { checkStorage } from './services/storage.js'
import { mediaRouter } from './routes/media.js'
import { attachLiveTranscribe } from './lib/liveTranscribe.js'

function isProductionLike(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging'
}

const app = new Hono<AppEnv>()

app.use('*', logger())

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

app.use(
  '*',
  cors({
    origin: (origin) => {
      if (!origin) return allowedOrigins[0]
      return allowedOrigins.includes(origin) ? origin : null
    },
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['Content-Length'],
    maxAge: 600,
  })
)

app.get('/health/live', (c) => {
  return c.json({
    status: 'ok',
    service: 'pinote-api',
    time: new Date().toISOString(),
  })
})

app.get('/health', async (c) => {
  const checks = {
    db: false,
    cache: false,
    storage: false,
    worker: !isProductionLike(),
  }

  try {
    await withTimeout(
      (async () => {
        await db.select({ ok: sql<number>`1` })
      })(),
      5000
    )
    checks.db = true
  } catch (err) {
    console.error('Health DB check failed:', err)
  }

  checks.cache = await withTimeout(checkCache(), 5000).catch((err) => {
    console.error('Health cache check failed:', err)
    return false
  })

  checks.storage = await withTimeout(checkStorage(), 5000).catch((err) => {
    console.error('Health storage check failed:', err)
    return false
  })

  if (isProductionLike()) {
    const heartbeat = await withTimeout(getWorkerHeartbeat(), 5000).catch((err) => {
      console.error('Health worker heartbeat check failed:', err)
      return null
    })
    checks.worker = Boolean(heartbeat && Date.now() - Date.parse(heartbeat.at) < 90_000)
  }

  const ok = Object.values(checks).every(Boolean)
  return c.json(
    {
      status: ok ? 'ok' : 'degraded',
      service: 'pinote-api',
      checks,
      time: new Date().toISOString(),
    },
    ok ? 200 : 503
  )
})

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
    promise
      .then(resolve, reject)
      .finally(() => clearTimeout(timer))
  })
}

app.route('/media', mediaRouter)
app.route('/auth', authRouter)
app.route('/users', usersRouter)
app.route('/jobs', jobsRouter)
app.route('/upload', uploadRouter)
app.route('/share', shareRouter)
app.route('/tasks', tasksRouter)
app.route('/playground', playgroundRouter)
app.route('/search', searchRouter)
app.route('/reminders', remindersRouter)

app.onError((err, c) => {
  console.error('Unhandled error:', err)
  return c.json({ error: 'Internal server error' }, 500)
})

// On startup: mark non-durable in-flight uploads as failed. Queued durable
// storage jobs are owned by the worker process, not the API.
async function recoverStuckJobs() {
  try {
    const stuck = await db
      .update(jobs)
      .set({
        status: 'failed',
        errorMessage: 'Server restart saat proses berlangsung. Silakan upload ulang.',
      })
      .where(inArray(jobs.status, ['uploading']))
      .returning({ id: jobs.id })

    if (stuck.length > 0) {
      console.log(`Marked ${stuck.length} stuck job(s) as failed:`, stuck.map((j) => j.id))
    }
  } catch (err) {
    console.error('Failed to recover stuck jobs:', err)
  }
}

const port = Number(process.env.PORT ?? 3000)
const hostname = process.env.HOST ?? '0.0.0.0'
console.log(`Backend listening on http://${hostname}:${port}`)

const server = serve({ fetch: app.fetch, port, hostname })
attachLiveTranscribe(server as unknown as import('node:http').Server)

recoverStuckJobs()

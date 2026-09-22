import { eq, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from '../db/client.js'
import { actionItems, jobs, users, type JobStatus, type TranscriptPayload } from '../db/schema.js'
import { hasDeepgramKey, transcribeFromUrl as transcribeWithDeepgram } from './deepgram.js'
import { transcribeFromUrl as transcribeWithQwen } from './qwen.js'
import { polishTranscript, generateInsights } from './insights.js'
import { cacheJobStatus, invalidateUserStats } from './cache.js'
import { createDownloadUrl } from './storage.js'
import { sendTaskDigest } from './email.js'

const TRANSCRIPTION_URL_TTL_SEC = 4 * 60 * 60

const PROGRESS_BY_STEP: Record<string, number> = {
  'Transcribing audio...': 40,
  'Processing speaker labels...': 60,
  'Refining transcript...': 75,
  'Generating summary...': 85,
}

const transcribeFromUrl: typeof transcribeWithDeepgram = (args) =>
  hasDeepgramKey() ? transcribeWithDeepgram(args) : transcribeWithQwen(args)

function stepProgress(step: string): number {
  const exact = PROGRESS_BY_STEP[step]
  if (exact) return exact
  const chunkMatch = step.match(/Transcribing chunk (\d+)\/(\d+)/)
  if (chunkMatch) {
    const current = Number(chunkMatch[1])
    const total = Number(chunkMatch[2])
    return 40 + Math.round((current / total) * 20)
  }
  return 45
}

export async function processStoredTranscriptionJob(jobId: string): Promise<void> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1)
  if (!job) throw new Error(`Job ${jobId} not found`)
  if (job.status === 'cancelled') return
  if (!job.storageKey) throw new Error(`Job ${jobId} missing storage key`)

  try {
    await cacheJobStatus(jobId, { status: 'transcribing', progress: 30 })
    const audioUrl = await createDownloadUrl(job.storageKey, TRANSCRIPTION_URL_TTL_SEC)

    const { segments, detectedLanguage, durationSec: actualDuration } = await transcribeFromUrl({
      audioUrl,
      language: job.language as 'id' | 'en' | 'auto',
      onProgress: async (step) => {
        console.log(`[${jobId}] ${step}`)
        await cacheJobStatus(jobId, {
          status: 'transcribing',
          progress: stepProgress(step),
        })
      },
    })

    const [current] = await db
      .select({ status: jobs.status, durationSec: jobs.durationSec })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1)

    if (!current || current.status === 'cancelled') {
      console.log(`[${jobId}] Job cancelled before completion; skipping save and credit reconciliation`)
      return
    }

    const uniqueSpeakers = new Set(segments.map((s) => s.speaker))

    function normalizeLang(lang: string | undefined): 'id' | 'en' | 'mixed' {
      if (lang === 'id' || lang === 'en') return lang
      if (lang?.startsWith('id')) return 'id'
      if (lang?.startsWith('en')) return 'en'
      return 'mixed'
    }

    // Save raw transcript immediately so user can see results
    const rawPayload: TranscriptPayload = {
      segments,
      rawSegments: undefined,
      polished: false,
      speakerCount: uniqueSpeakers.size,
      summary: '',
      language: job.language === 'auto' ? normalizeLang(detectedLanguage) : job.language as 'id' | 'en' | 'mixed',
    }

    await db
      .update(jobs)
      .set({
        status: 'completed' satisfies JobStatus,
        transcript: rawPayload,
        durationSec: actualDuration,
        completedAt: new Date(),
        errorMessage: null,
      })
      .where(eq(jobs.id, jobId))

    await cacheJobStatus(jobId, { status: 'completed', progress: 65 })
    await invalidateUserStats(job.userId)

    // Phase 2: Background processing
    void (async () => {
      if (job.skipInsights) {
        await cacheJobStatus(jobId, { status: 'completed', progress: 100 })
        console.log(`[${jobId}] Background: insights skipped by request`)
        return
      }
      try {
        // Step 1: Generate title, summary, action items FIRST (uses raw segments)
        console.log(`[${jobId}] Background: Generating summary...`)
        await cacheJobStatus(jobId, { status: 'completed', progress: 75 })
        const insights = await generateInsights(segments)

        const updatedSpeakers = new Set(segments.map((s) => s.speaker))

        await db
          .update(jobs)
          .set({
            transcript: {
              segments,
              rawSegments: undefined,
              polished: false,
              speakerCount: updatedSpeakers.size,
              summary: insights.summary,
              language: rawPayload.language,
            },
            title: insights.title || null,
          })
          .where(eq(jobs.id, jobId))

        // Summary is now persisted, so the job is fully usable for the client.
        // Mark progress 100 immediately so a stale progress value can never
        // make the UI keep showing "Menyiapkan ringkasan..." after the summary
        // is already in the database.
        await cacheJobStatus(jobId, { status: 'completed', progress: 100 })

        if (insights.actionItems.length > 0 && job.isPrivate) {
          const [owner] = await db
            .select({ displayName: users.displayName, username: users.username })
            .from(users)
            .where(eq(users.id, job.userId))
            .limit(1)
          const ownerName = owner?.displayName ?? owner?.username ?? 'Saya'
          const ownerKey = ownerName.trim().toLowerCase()

          await db
            .insert(actionItems)
            .values(
              insights.actionItems.map((it, i) => {
                const mentioned = it.owner.trim()
                const task = mentioned && mentioned.toLowerCase() !== ownerKey ? `${it.task} (terkait ${mentioned})` : it.task
                return {
                  id: nanoid(),
                  jobId,
                  owner: ownerName,
                  assigneeId: job.userId,
                  task,
                  due: it.due ?? null,
                  confidence: it.confidence,
                  order: i,
                }
              })
            )
            .catch((err) => console.warn(`[${jobId}] Failed to persist private action items:`, err))
        }

        if (insights.actionItems.length > 0 && !job.isPrivate) {
          await db
            .insert(actionItems)
            .values(
              insights.actionItems.map((it, i) => ({
                id: nanoid(),
                jobId,
                owner: it.owner,
                task: it.task,
                due: it.due ?? null,
                confidence: it.confidence,
                order: i,
              }))
            )
            .catch((err) => console.warn(`[${jobId}] Failed to persist action items:`, err))

          const meetingTitle = job.title || job.filename.replace(/\.[^/.]+$/, '')

          type ResolvedUser = { email: string; displayName: string | null; ccEmails: string[] }
          const ownerCache = new Map<string, ResolvedUser | null>()
          const resolveOwner = async (name: string): Promise<ResolvedUser | null> => {
            const cached = ownerCache.get(name)
            if (cached !== undefined) return cached
            const [row] = await db
              .select({ email: users.email, displayName: users.displayName, ccEmails: users.ccEmails })
              .from(users)
              .where(sql`LOWER(COALESCE(${users.displayName}, ${users.username})) = ${name}`)
              .limit(1)
            const resolved: ResolvedUser | null = row?.email
              ? { email: row.email, displayName: row.displayName, ccEmails: (row.ccEmails ?? []) as string[] }
              : null
            ownerCache.set(name, resolved)
            return resolved
          }

          const bundles = new Map<string, { assigneeName: string; tasks: { taskTitle: string; due?: string | null }[] }>()

          for (const item of insights.actionItems) {
            const user = await resolveOwner(item.owner.trim().toLowerCase())
            if (!user) continue

            const assigneeName = user.displayName ?? item.owner
            const recipients = [user.email, ...user.ccEmails.filter((cc) => cc !== user.email)]
            for (const to of recipients) {
              const bundle = bundles.get(to)
              const task = { taskTitle: item.task, due: item.due ?? null }
              if (bundle) {
                bundle.tasks.push(task)
              } else {
                bundles.set(to, { assigneeName, tasks: [task] })
              }
            }
          }

          for (const [to, bundle] of bundles) {
            sendTaskDigest({
              to,
              tasks: bundle.tasks,
              meetingTitle,
              assigneeName: bundle.assigneeName,
            }).catch((err) => console.warn(`[${jobId}] Email send failed for ${to}:`, err))
          }
        }

        // Step 2: Polish transcript (refine segment text) in background
        if (segments.length > 0) {
          console.log(`[${jobId}] Background: Refining transcript...`)
          try {
            const r = await polishTranscript(segments)
            const polishedSegments = r.polished
            const rawSegments = r.raw
            console.log(`[${jobId}] Background: Polish pass done (${rawSegments.length} -> ${polishedSegments.length} segments)`)

            const finalSpeakers = new Set(polishedSegments.map((s) => s.speaker))

            await db
              .update(jobs)
              .set({
                transcript: {
                  segments: polishedSegments,
                  rawSegments,
                  polished: true,
                  speakerCount: finalSpeakers.size,
                  summary: insights.summary,
                  language: rawPayload.language,
                },
              })
              .where(eq(jobs.id, jobId))
          } catch (err) {
            console.warn(`[${jobId}] Background polish failed, keeping raw:`, err)
          }
        }

        await cacheJobStatus(jobId, { status: 'completed', progress: 100 })
        console.log(`[${jobId}] Background: Processing complete`)
      } catch (err) {
        const bgMsg = err instanceof Error ? err.message : String(err)
        console.error(`[${jobId}] Background processing failed:`, bgMsg)
        await db
          .update(jobs)
          .set({ errorMessage: `Peringatan: ${bgMsg}` })
          .where(eq(jobs.id, jobId))
      }
    })()
  } catch (err) {
    const [current] = await db
      .select({ status: jobs.status })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1)

    if (!current || current.status === 'cancelled') {
      console.log(`[${jobId}] Job cancelled; aborting transcription`)
      return
    }

    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[${jobId}] Transcription failed`, err)

    await Promise.all([
      db
        .update(jobs)
        .set({ status: 'failed' satisfies JobStatus, errorMessage: msg })
        .where(eq(jobs.id, jobId)),
      cacheJobStatus(jobId, { status: 'failed', error: msg }),
    ])
  }
}

import { pgTable, text, boolean, timestamp, bigint, integer, real, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core'

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull().unique(),
    email: text('email').unique(),
    passwordHash: text('password_hash'),
    isAdmin: boolean('is_admin').notNull().default(false),
    creditSeconds: integer('credit_seconds').notNull().default(0),
    displayName: text('display_name'),
    taskShareToken: text('task_share_token'),
    nameAliases: jsonb('name_aliases').$type<string[]>().default([]),
    ccEmails: jsonb('cc_emails').$type<string[]>().default([]),
    usernameChanges: integer('username_changes').notNull().default(0),
    previousUsernames: jsonb('previous_usernames').$type<string[]>().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    taskTokenIdx: uniqueIndex('users_task_share_token_idx').on(t.taskShareToken),
    emailIdx: uniqueIndex('users_email_idx').on(t.email),
  })
)

export const sessions = pgTable(
  'sessions',
  {
    token: text('token').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index('sessions_user_idx').on(t.userId),
  })
)

export const jobs = pgTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    title: text('title'),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    durationSec: integer('duration_sec'),
    language: text('language').notNull().default('auto'),
    status: text('status').notNull(),
    storageKey: text('storage_key'),
    // Internal (full) public share token — grants transcript + audio + summary.
    shareToken: text('share_token'),
    // Stakeholder share token — grants only the Minutes-of-Meeting view
    // (summary + action items). Never exposes transcript or audio. Kept on a
    // separate token so a stakeholder link cannot be mutated into a full one.
    shareTokenMom: text('share_token_mom'),
    transcript: jsonb('transcript').$type<TranscriptPayload | null>(),
    speakerNames: jsonb('speaker_names').$type<Record<string, string>>().notNull().default({}),
    attendance: jsonb('attendance').$type<string[]>().default([]),
    errorMessage: text('error_message'),
    source: text('source').notNull().default('upload'),
    isPrivate: boolean('is_private').notNull().default(false),
    skipInsights: boolean('skip_insights').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }),
    queuedAt: timestamp('queued_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  },
  (t) => ({
    userIdx: index('jobs_user_idx').on(t.userId),
    createdIdx: index('jobs_created_idx').on(t.createdAt),
    shareTokenIdx: uniqueIndex('jobs_share_token_idx').on(t.shareToken),
    shareTokenMomIdx: uniqueIndex('jobs_share_token_mom_idx').on(t.shareTokenMom),
  })
)

export type User = typeof users.$inferSelect
export type Session = typeof sessions.$inferSelect
export type Job = typeof jobs.$inferSelect
export type ActionItemRow = typeof actionItems.$inferSelect
export type CacheEntry = typeof cacheEntries.$inferSelect
export type ReminderRow = typeof reminders.$inferSelect

export type JobStatus = 'pending' | 'uploading' | 'queued' | 'transcribing' | 'completed' | 'failed' | 'cancelled'

// Generic key/value cache with TTL. Replaces what Upstash Redis used to do
// (job progress, user stats, worker heartbeat, login rate-limit counters).
export const cacheEntries = pgTable(
  'cache_entries',
  {
    key: text('key').primaryKey(),
    value: jsonb('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    expiresIdx: index('cache_entries_expires_idx').on(t.expiresAt),
  })
)

export interface TranscriptSegment {
  start: string
  end: string
  speaker: string
  text: string
}

export interface TranscriptPayload {
  segments: TranscriptSegment[]
  speakerCount: number
  summary: string
  language: 'id' | 'en' | 'mixed'
  // Original Deepgram output kept for audit when GLM polish is enabled.
  // Present only if the job was processed with TRANSCRIPT_POLISH=1.
  rawSegments?: TranscriptSegment[]
  polished?: boolean
}

// AI-extracted action item. Persisted in the action_items table; canonical
// owner is the raw diarization label ("Speaker 2"). The frontend resolves a
// human-readable name via jobs.speakerNames at render time.
export interface ActionItem {
  id: string
  owner: string
  task: string
  due: string | null
  confidence: number
  done: boolean
  order: number
}

// Shape produced by the LLM extractor before persistence.
export interface ExtractedActionItem {
  owner: string
  task: string
  due: string | null
  confidence: number
}

export const actionItems = pgTable(
  'action_items',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .references(() => jobs.id, { onDelete: 'cascade' }),
    owner: text('owner').notNull(),
    // Optional link to a real user once the owner label has been resolved
    // (manual assign or name match). Stays nullable so existing rows keep working.
    assigneeId: text('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    task: text('task').notNull(),
    due: text('due_date'),
    confidence: real('confidence').notNull().default(1),
    done: boolean('done').notNull().default(false),
    order: integer('order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    jobIdx: index('action_items_job_idx').on(t.jobId),
    ownerIdx: index('action_items_owner_idx').on(t.owner),
    assigneeIdx: index('action_items_assignee_idx').on(t.assigneeId),
  })
)

export const reminders = pgTable(
  'reminders',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => actionItems.id, { onDelete: 'cascade' }),
    fromUserId: text('from_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    toUserId: text('to_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    message: text('message').notNull(),
    read: boolean('read').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    taskIdx: index('reminders_task_idx').on(t.taskId),
    toUserIdx: index('reminders_to_user_idx').on(t.toUserId),
    createdIdx: index('reminders_created_idx').on(t.createdAt),
  })
)

const configuredBaseUrl = (import.meta.env.VITE_API_URL as string | undefined)?.trim()
const BASE_URL = (configuredBaseUrl || (import.meta.env.DEV ? '' : '/api')).replace(/\/$/, '')

export class ApiError extends Error {
  constructor(public status: number, message: string, public detail?: unknown) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    credentials: 'include',
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })

  if (!res.ok) {
    let body: { error?: string; detail?: unknown } | null = null
    try {
      body = await res.json()
    } catch {
      // ignore
    }
    throw new ApiError(res.status, body?.error ?? `HTTP ${res.status}`, body?.detail)
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export const api = {
  baseUrl: BASE_URL,
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}

// === Types ===
export interface SessionUser {
  id: string
  username: string
  isAdmin: boolean
  displayName?: string | null
  email?: string | null
}

export interface UserStats {
  totalDurationSec: number
  latestDurationSec: number
  totalJobs: number
  estimatedCostUSD: number
  memberSince: string | null
}

export interface JobSummary {
  id: string
  filename: string
  title: string | null
  durationSec: number | null
  sizeBytes: number | null
  language: string
  status: 'pending' | 'uploading' | 'queued' | 'transcribing' | 'completed' | 'failed' | 'cancelled'
  createdAt: string
  completedAt: string | null
  speakerCount: number | null
}

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
  rawSegments?: TranscriptSegment[]
  polished?: boolean
}

export interface ActionItem {
  id: string
  owner: string
  task: string
  due: string | null
  confidence: number
  done: boolean
  order: number
}

export interface ActionItemChange {
  id?: string
  owner?: string
  task?: string
  due?: string | null
  done?: boolean
  confidence?: number
  _delete?: boolean
}

export interface JobDetail {
  id: string
  filename: string
  title: string | null
  storageKey?: string | null
  mimeType: string
  sizeBytes: number | null
  durationSec: number | null
  language: string
  status: JobSummary['status']
  progress?: number
  transcript: TranscriptPayload | null
  speakerNames: Record<string, string>
  actionItems: ActionItem[]
  error: string | null
  createdAt: string
  completedAt: string | null
  cancelledAt?: string | null
  shareToken?: string | null
  shareTokenMom?: string | null
}

export type ShareKind = 'internal' | 'stakeholder'

export interface ShareJobResponse {
  kind: ShareKind
  shareToken: string
  sharePath: string
}

// Internal (full) shared job, returned by the public GET /share/:token endpoint.
export interface SharedJobDetail {
  shareKind: 'internal'
  id: string
  filename: string
  title: string | null
  mimeType: string
  durationSec: number | null
  language: string
  status: string
  transcript: TranscriptPayload | null
  speakerNames: Record<string, string>
  actionItems: ActionItem[]
  createdAt: string
  completedAt: string | null
  hasAudio: boolean
}

// Stakeholder Minutes-of-Meeting view, returned by GET /share/mom/:token.
export interface SharedMomDetail {
  shareKind: 'stakeholder'
  id: string
  filename: string
  title: string | null
  createdAt: string
  completedAt: string | null
  durationSec: number | null
  language: string
  speakerNames: Record<string, string>
  speakerCount: number
  summary: string
  actionItems: ActionItem[]
}

export interface JobStatusPayload {
  id: string
  status: JobSummary['status']
  progress?: number
  error?: string
}

export interface ManagedUser {
  id: string
  username: string
  isAdmin: boolean
  displayName: string | null
  taskShareToken: string | null
  createdAt: string
}

export interface TaskGroupItem {
  id: string
  jobId: string | null
  owner: string
  assigneeId: string | null
  task: string
  due: string | null
  confidence: number
  done: boolean
  order: number
  createdAt: string
  jobTitle: string | null
  jobFilename: string | null
  jobCreatedAt: string | null
  jobCompletedAt: string | null
}

export interface MyTasksResponse {
  user: { username: string; displayName: string }
  openCount: number
  totalCount: number
  groups: Array<{
    jobId: string
    title: string | null
    filename: string
    createdAt: string
    completedAt: string | null
    items: TaskGroupItem[]
  }>
}

export interface AdminTasksResponse {
  isAdminView: true
  totalCount: number
  groups: Array<{
    owner: string
    items: TaskGroupItem[]
  }>
}

export interface Reminder {
  id: string
  taskId: string
  message: string
  read: boolean
  createdAt: string
  task: string
  owner: string
}

export interface RemindersResponse {
  reminders: Reminder[]
}

export interface UnreadCountResponse {
  count: number
}

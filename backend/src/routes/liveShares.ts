import { Hono } from 'hono'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { requireAuth, type AppEnv } from '../middleware/auth.js'
import { cacheDelete, cacheGet, cacheSet } from '../services/cache.js'
import { applyLiveLines, cleanLiveLine, publicLiveView, type LiveShareLine, type LiveShareState } from '../lib/liveShare.js'
import { cleanTitleHint } from '../lib/titleHint.js'

const TTL_SEC = 12 * 60 * 60
const ENDED_TTL_SEC = 2 * 60 * 60
const key = (token: string) => `liveShare:${token}`

export const liveSharesRouter = new Hono<AppEnv>()

liveSharesRouter.get('/public/:token', async (c) => {
  const state = await cacheGet<LiveShareState>(key(c.req.param('token')))
  if (!state) return c.json({ error: 'Transkrip langsung ini tidak ditemukan atau sudah ditutup.' }, 404)
  const since = Math.max(0, Math.floor(Number(c.req.query('since') ?? 0)) || 0)
  c.header('Cache-Control', 'no-store')
  return c.json(publicLiveView(state, since))
})

const createSchema = z.object({
  title: z.string().max(300).optional(),
  source: z.enum(['meet', 'zoom', 'teams', 'whatsapp', 'upload']).optional(),
})

liveSharesRouter.post('/', requireAuth, async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: 'Input tidak valid' }, 400)
  if (parsed.data.source === 'whatsapp') return c.json({ error: 'Panggilan WhatsApp bersifat privat dan tidak bisa dibagikan.' }, 403)
  const user = c.get('user')
  const token = nanoid(24)
  const now = new Date().toISOString()
  const state: LiveShareState = {
    userId: user.id,
    title: cleanTitleHint(parsed.data.title),
    source: parsed.data.source ?? 'upload',
    startedAt: now,
    updatedAt: now,
    endedAt: null,
    base: 0,
    lines: [],
  }
  await cacheSet(key(token), state, TTL_SEC)
  return c.json({ token, path: `/live/${token}` }, 201)
})

const linesSchema = z.object({
  from: z.number().int().min(0),
  total: z.number().int().min(0),
  lines: z.array(z.unknown()).max(500),
})

async function ownedShare(token: string, userId: string): Promise<LiveShareState | null> {
  const state = await cacheGet<LiveShareState>(key(token))
  return state && state.userId === userId ? state : null
}

liveSharesRouter.put('/:token/lines', requireAuth, async (c) => {
  const token = c.req.param('token')
  const parsed = linesSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Input tidak valid' }, 400)
  const state = await ownedShare(token, c.get('user').id)
  if (!state) return c.json({ error: 'Transkrip langsung tidak ditemukan' }, 404)
  if (state.endedAt) return c.json({ error: 'Transkrip langsung sudah ditutup' }, 409)
  const incoming = parsed.data.lines.map(cleanLiveLine).filter((line): line is LiveShareLine => line !== null)
  const next = applyLiveLines(state, parsed.data.from, incoming, parsed.data.total)
  await cacheSet(key(token), next, TTL_SEC)
  return c.json({ ok: true, total: next.base + next.lines.length })
})

liveSharesRouter.post('/:token/end', requireAuth, async (c) => {
  const token = c.req.param('token')
  const state = await ownedShare(token, c.get('user').id)
  if (!state) return c.json({ ok: true })
  await cacheSet(key(token), { ...state, endedAt: new Date().toISOString() }, ENDED_TTL_SEC)
  return c.json({ ok: true })
})

liveSharesRouter.delete('/:token', requireAuth, async (c) => {
  const token = c.req.param('token')
  const state = await ownedShare(token, c.get('user').id)
  if (state) await cacheDelete(key(token))
  return c.json({ ok: true })
})

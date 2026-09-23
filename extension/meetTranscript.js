const UNKNOWN = 'Identitas belum tersedia'
const MAX_LINES = 20000

function lookup(state, id) {
  const participants = state.meetParticipants ?? {}
  const person = Object.hasOwn(participants, id) ? participants[id] : null
  const parent = person?.parentId && Object.hasOwn(participants, person.parentId) ? participants[person.parentId] : null
  const self = id === state.meetSelfId && typeof state.meetSelfName === 'string' && state.meetSelfName ? state.meetSelfName : null
  return parent?.name ?? person?.name ?? self
}

function resolveLine(state, line) {
  if (line.fixedName) return
  if (line.participantId.startsWith('csrc:')) {
    const streams = state.meetStreams ?? {}
    const streamId = line.participantId.slice(5)
    if (Object.hasOwn(streams, streamId)) line.participantId = streams[streamId]
  }
  const name = lookup(state, line.participantId)
  line.speaker = name ?? UNKNOWN
  line.identityResolved = Boolean(name)
}

function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
}

export function applyMeetEvent(state, message) {
  if (message.event === 'roster') {
    if (!Array.isArray(message.users)) return false
    const participants = state.meetParticipants ??= {}
    for (const user of message.users.slice(0, 2000)) {
      if (!validId(user?.id) || typeof user.name !== 'string' || !user.name.trim() || user.name.length > 120) continue
      Object.defineProperty(participants, user.id, {
        value: { name: user.name, parentId: typeof user.parentId === 'string' ? user.parentId : '', status: user.status },
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    if (validId(message.selfId) && !state.meetSelfId) state.meetSelfId = message.selfId
    for (const line of state.lines) if (line.provenance === 'meet-native') resolveLine(state, line)
    state.attendance = [...new Set(Object.values(participants).filter((p) => p.status === '1' || !p.status).map((p) => p.name))].slice(0, 50)
    return true
  }

  if (message.event === 'devices') {
    if (!Array.isArray(message.devices)) return false
    const streams = state.meetStreams ??= {}
    for (const device of message.devices.slice(0, 4000)) {
      if (typeof device?.streamId !== 'string' || !device.streamId || device.streamId.length > 64 || !validId(device.deviceId)) continue
      Object.defineProperty(streams, device.streamId, { value: device.deviceId, enumerable: true, writable: true, configurable: true })
    }
    for (const line of state.lines) if (line.provenance === 'meet-native') resolveLine(state, line)
    return true
  }

  if (message.event !== 'laneFinal') return false
  if (!validId(message.participantId) || typeof message.text !== 'string') return false
  const text = message.text.trim()
  if (!text || text.length > 10000 || !state.startedAt) return false
  if (state.lines.length >= MAX_LINES) {
    state.error = 'Batas 20.000 potongan transkrip tercapai. Hentikan sesi dan mulai sesi baru.'
    return true
  }

  const now = Date.now()
  const startedAt = Number.isFinite(message.startedAt) ? Math.min(message.startedAt, now) : now
  const offset = (at) => Math.max(0, (at - state.startedAt - (state.pausedTotalMs ?? 0)) / 1000)
  state.nativeSequence = (state.nativeSequence ?? 0) + 1

  const line = {
    at: startedAt,
    endAt: now,
    startSec: offset(startedAt),
    endSec: Math.max(offset(startedAt), offset(now)),
    captionId: String(state.nativeSequence),
    version: '1',
    final: true,
    participantId: message.participantId,
    provenance: 'meet-native',
    text,
  }
  if (message.voice === true) line.voice = true

  if (typeof message.name === 'string' && message.name.trim()) {
    line.fixedName = true
    line.speaker = message.name.trim().slice(0, 120)
    line.identityResolved = true
  } else {
    resolveLine(state, line)
  }

  state.lines.push(line)
  state.partial = ''
  return true
}

const COUNTER = /^\d{1,20}$/
const CHAT_PREFIX = 'Chat: '
const RECENT_LINES = 500

function sameOrNewer(next, prior) {
  return BigInt(next) >= BigInt(prior)
}

export function applyUtterance(state, event) {
  if (!event || typeof event !== 'object' || !state.startedAt) return false
  if (typeof event.source !== 'string' || event.source !== state.source) return false
  if (typeof event.meetingId !== 'string' || !event.meetingId || event.meetingId.length > 128) return false
  if (state.utteranceMeeting && state.utteranceMeeting !== event.meetingId) return false
  if (!COUNTER.test(event.eventId ?? '') || !COUNTER.test(event.version ?? '')) return false
  const participantId = validId(event.participantId) ? event.participantId : validId(event.deviceId) ? event.deviceId : null
  if (!participantId || typeof event.text !== 'string') return false
  const chat = event.kind === 'chat'
  const body = event.text.trim()
  if (!body || body.length > 10000) return false
  const text = body

  const now = Date.now()
  const at = Number.isFinite(event.timestamp) ? Math.min(event.timestamp, now) : now
  const offset = (value) => Math.max(0, (value - state.startedAt - (state.pausedTotalMs ?? 0)) / 1000)
  const key = `${chat ? 'chat|' : ''}${participantId}|${event.eventId}`
  const speakerName = typeof event.speakerName === 'string' ? event.speakerName.trim().slice(0, 120) : ''
  const language = typeof event.language === 'string' ? event.language.slice(0, 32) : ''
  state.utteranceMeeting ??= event.meetingId

  for (let i = state.lines.length - 1; i >= Math.max(0, state.lines.length - RECENT_LINES); i--) {
    const line = state.lines[i]
    if (line.utteranceKey !== key || line.frozen) continue
    if (!sameOrNewer(event.version, line.version)) {
      state.olderDrops = (state.olderDrops ?? 0) + 1
      return false
    }
    const final = line.final || event.isFinal === true
    if (line.version === event.version && line.text === text && line.final === final) return false
    line.text = text
    line.version = event.version
    line.final = final
    line.endAt = Math.max(line.at, at)
    line.endSec = Math.max(line.startSec, offset(line.endAt))
    if (language) line.language = language
    if (speakerName) {
      line.fixedName = true
      line.speaker = speakerName
      line.identityResolved = true
    } else resolveLine(state, line)
    return true
  }

  if (state.lines.length >= MAX_LINES) {
    state.error = 'Batas 20.000 potongan transkrip tercapai. Hentikan sesi dan mulai sesi baru.'
    return true
  }
  const line = {
    at,
    endAt: at,
    startSec: offset(at),
    endSec: offset(at),
    captionId: event.eventId,
    version: event.version,
    final: event.isFinal === true,
    participantId,
    provenance: 'meet-native',
    utteranceKey: key,
    language,
    text,
  }
  if (chat) {
    line.chat = true
    line.final = true
  }
  if (speakerName) {
    line.fixedName = true
    line.speaker = speakerName
    line.identityResolved = true
  } else resolveLine(state, line)
  state.lines.push(line)
  return true
}

const MATCH_MIN_WORDS = 3

function wordSet(text) {
  return new Set(String(text).toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((word) => word.length > 1))
}

export function textOverlap(a, b) {
  const left = wordSet(a)
  const right = wordSet(b)
  if (left.size < MATCH_MIN_WORDS || right.size < MATCH_MIN_WORDS) return 0
  let common = 0
  for (const word of left) if (right.has(word)) common++
  return common / Math.min(left.size, right.size)
}

export function claimSelfVoice(state, text, startedAt, { windowMs = 20000, minimum = 0.5 } = {}) {
  const now = Date.now()
  const from = (Number.isFinite(startedAt) ? startedAt : now) - windowMs
  const matches = new Map()
  for (const line of state.lines) {
    if (line.provenance !== 'meet-native' || line.chat || line.voice || !line.utteranceKey) continue
    if (line.at < from || line.participantId === 'local') continue
    if (textOverlap(line.text, text) < minimum) continue
    const list = matches.get(line.participantId) ?? []
    list.push(line)
    matches.set(line.participantId, list)
  }
  let owner = state.meetSelfId && matches.has(state.meetSelfId) ? state.meetSelfId : null
  if (!owner && !state.meetSelfId) {
    let best = 0
    for (const [participantId, list] of matches) {
      if (list.length > best) {
        best = list.length
        owner = participantId
      }
    }
  }
  if (!owner) return null
  if (!state.meetSelfId) {
    state.meetSelfId = owner
    for (const line of state.lines) {
      if (line.participantId !== 'local') continue
      line.participantId = owner
      line.fixedName = false
      resolveLine(state, line)
    }
  }
  const removed = new Set(matches.get(owner).map((line) => line.utteranceKey))
  state.selfSuppressed = [...(state.selfSuppressed ?? []), ...removed].slice(-500)
  state.lines = state.lines.filter((line) => !removed.has(line.utteranceKey))
  return owner
}

export function nativeTranscript(state) {
  return state.lines.filter((line) => line.provenance === 'meet-native' && line.text.trim()).map((line) => ({
    participantId: line.participantId,
    name: line.identityResolved ? line.speaker : null,
    text: line.chat ? `${CHAT_PREFIX}${line.text}`.slice(0, 10000) : line.text,
    start: line.startSec,
    end: line.endSec,
    eventId: line.captionId,
    version: line.version,
  }))
}

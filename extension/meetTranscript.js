const UNKNOWN = 'Identitas belum tersedia'
const MAX_LINES = 20000

function lookup(state, id) {
  const participants = state.meetParticipants ?? {}
  const person = Object.hasOwn(participants, id) ? participants[id] : null
  const parent = person?.parentId && Object.hasOwn(participants, person.parentId) ? participants[person.parentId] : null
  const self = id === state.meetSelfId && typeof state.meetSelfName === 'string' && state.meetSelfName ? state.meetSelfName : null
  return person?.name ?? parent?.name ?? self
}

function resolveLine(state, line) {
  if (line.fixedName) return false
  const before = `${line.participantId}\u0001${line.speaker}\u0001${line.identityResolved}`
  if (line.participantId.startsWith('csrc:')) {
    const streams = state.meetStreams ?? {}
    const streamId = line.participantId.slice(5)
    if (Object.hasOwn(streams, streamId)) line.participantId = streams[streamId]
  }
  const name = lookup(state, line.participantId)
  line.speaker = name ?? UNKNOWN
  line.identityResolved = Boolean(name)
  return before !== `${line.participantId}\u0001${line.speaker}\u0001${line.identityResolved}`
}

function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
}

const ANY_STREAM = 'csrc:*'
const MAX_STREAMS = 4000

function resolveAffected(state, affected) {
  if (affected.size === 0) return false
  const streams = affected.has(ANY_STREAM)
  let changed = false
  for (const line of state.lines) {
    if (line.provenance !== 'meet-native' || line.fixedName) continue
    const id = line.participantId
    if (!affected.has(id) && !(streams && id.startsWith('csrc:'))) continue
    if (resolveLine(state, line)) changed = true
  }
  return changed
}

function sameArray(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => value === b[index])
}

export function applyMeetEvent(state, message) {
  if (message.event === 'roster') {
    if (!Array.isArray(message.users)) return false
    const participants = state.meetParticipants ??= {}
    const affected = new Set()
    let rosterChanged = false
    for (const user of message.users.slice(0, 2000)) {
      if (!validId(user?.id) || typeof user.name !== 'string' || !user.name.trim() || user.name.length > 120) continue
      const parentId = typeof user.parentId === 'string' ? user.parentId : ''
      const prior = Object.hasOwn(participants, user.id) ? participants[user.id] : null
      if (prior && prior.name === user.name && prior.parentId === parentId && prior.status === user.status) continue
      Object.defineProperty(participants, user.id, {
        value: { name: user.name, parentId, status: user.status },
        enumerable: true,
        writable: true,
        configurable: true,
      })
      rosterChanged = true
      if (!prior || prior.name !== user.name || prior.parentId !== parentId) affected.add(user.id)
    }
    if (affected.size > 0) {
      for (const [id, person] of Object.entries(participants)) {
        if (person.parentId && affected.has(person.parentId)) affected.add(id)
      }
    }
    if (validId(message.selfId) && state.meetSelfId !== message.selfId) {
      state.meetSelfId = message.selfId
      affected.add(message.selfId)
      rosterChanged = true
    }
    const linesChanged = resolveAffected(state, affected)
    const attendance = [...new Set(Object.values(participants).filter((p) => p.status === '1' || !p.status).map((p) => p.name))].slice(0, 50)
    const attendanceChanged = !sameArray(attendance, state.attendance)
    if (attendanceChanged) state.attendance = attendance
    return rosterChanged || linesChanged || attendanceChanged
  }

  if (message.event === 'devices') {
    if (!Array.isArray(message.devices)) return false
    const streams = state.meetStreams ??= {}
    let changed = false
    for (const device of message.devices.slice(0, 4000)) {
      if (typeof device?.streamId !== 'string' || !device.streamId || device.streamId.length > 64 || !validId(device.deviceId)) continue
      if (Object.hasOwn(streams, device.streamId) && streams[device.streamId] === device.deviceId) continue
      Object.defineProperty(streams, device.streamId, { value: device.deviceId, enumerable: true, writable: true, configurable: true })
      changed = true
    }
    if (!changed) return false
    const known = Object.keys(streams)
    for (const streamId of known.slice(0, Math.max(0, known.length - MAX_STREAMS))) delete streams[streamId]
    resolveAffected(state, new Set([ANY_STREAM]))
    return true
  }

  return false
}

const COUNTER = /^\d{1,20}$/
const CHAT_PREFIX = 'Chat: '
const lineIndexes = new WeakMap()

function lineIndex(state) {
  let index = lineIndexes.get(state.lines)
  if (!index) {
    index = new Map()
    for (const line of state.lines) if (typeof line?.utteranceKey === 'string' && !line.frozen) index.set(line.utteranceKey, line)
    lineIndexes.set(state.lines, index)
  }
  return index
}

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

  const index = lineIndex(state)
  const line = index.get(key)
  if (line && line.utteranceKey === key && !line.frozen) {
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
  const fresh = {
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
    fresh.chat = true
    fresh.final = true
  }
  if (speakerName) {
    fresh.fixedName = true
    fresh.speaker = speakerName
    fresh.identityResolved = true
  } else resolveLine(state, fresh)
  state.lines.push(fresh)
  index.set(key, fresh)
  return true
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

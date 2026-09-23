const UNKNOWN = 'Identitas belum tersedia'
const MAX_LINES = 20000

function lookup(state, id) {
  const participants = state.meetParticipants ?? {}
  const person = Object.hasOwn(participants, id) ? participants[id] : null
  const parent = person?.parentId && Object.hasOwn(participants, person.parentId) ? participants[person.parentId] : null
  return parent?.name ?? person?.name ?? null
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

export function nativeTranscript(state) {
  return state.lines.filter((line) => line.provenance === 'meet-native' && line.text.trim()).map((line) => ({
    participantId: line.participantId,
    name: line.identityResolved ? line.speaker : null,
    text: line.text,
    start: line.startSec,
    end: line.endSec,
    eventId: line.captionId,
    version: line.version,
  }))
}

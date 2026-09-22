export function applyMeetEvent(state, message) {
  if (message.event === 'roster') {
    if (!Array.isArray(message.users)) return false
    const participants = state.meetParticipants ??= {}
    for (const user of message.users.slice(0, 2000)) {
      if (typeof user?.id !== 'string' || !user.id || user.id.length > 512 || typeof user.name !== 'string' || !user.name.trim() || user.name.length > 120) continue
      // Object keys are platform IDs; never use a display name as identity.
      Object.defineProperty(participants, user.id, { value: { name: user.name, parentId: typeof user.parentId === 'string' ? user.parentId : '', status: user.status }, enumerable: true, writable: true, configurable: true })
    }
    const named = (id) => {
      const p = Object.hasOwn(participants, id) ? participants[id] : null
      const parent = p?.parentId && Object.hasOwn(participants, p.parentId) ? participants[p.parentId] : null
      return parent?.name ?? p?.name
    }
    for (const line of state.lines) {
      if (line.provenance !== 'meet-native') continue
      const name = named(line.participantId)
      line.speaker = name ?? 'Identitas belum tersedia'
      line.identityResolved = Boolean(name)
    }
    state.attendance = [...new Set(Object.values(participants).filter((p) => p.status === '1' || !p.status).map((p) => p.name))].slice(0, 50)
    return true
  }
  if (message.event !== 'caption') return false
  const c = message.caption
  if (!c || typeof c.deviceId !== 'string' || !c.deviceId || c.deviceId.length > 512 || typeof c.id !== 'string' || typeof c.version !== 'string' || !/^\d{1,20}$/.test(c.id) || !/^\d{1,20}$/.test(c.version) || typeof c.text !== 'string' || c.text.length > 10000) return false
  const existing = state.lines.find((line) => line.captionId === c.id && line.participantId === c.deviceId)
  // A resumed native revision can contain speech from inside the paused period.
  // Keep the old boundary intact and wait for a new native caption ID.
  if (existing?.frozen) return false
  if (existing && (BigInt(c.version) < BigInt(existing.version) || (existing.final && !c.final))) return false
  if (existing && existing.version === c.version && existing.text === c.text && existing.final === Boolean(c.final)) return false
  const now = Date.now()
  const offset = Math.max(0, (now - state.startedAt - state.pausedTotalMs) / 1000)
  const participants = state.meetParticipants ?? {}
  const user = Object.hasOwn(participants, c.deviceId) ? participants[c.deviceId] : null
  const parent = user?.parentId && Object.hasOwn(participants, user.parentId) ? participants[user.parentId] : null
  const name = parent?.name ?? user?.name
  if (!existing && state.lines.length >= 20000) {
    state.error = 'Batas 20.000 potongan transkrip tercapai. Hentikan sesi dan mulai sesi baru.'
    return true
  }
  const line = existing ?? { at: now, startSec: offset, captionId: c.id, participantId: c.deviceId, provenance: 'meet-native' }
  Object.assign(line, { text: c.text, version: c.version, final: Boolean(c.final), endAt: now, endSec: offset, speaker: name ?? 'Identitas belum tersedia', identityResolved: Boolean(name) })
  if (!existing) state.lines.push(line)
  state.partial = ''
  return true
}

export function nativeTranscript(state) {
  return state.lines.filter((line) => line.provenance === 'meet-native' && line.text.trim()).map((line) => ({
    participantId: line.participantId, name: line.identityResolved ? line.speaker : null,
    text: line.text, start: line.startSec, end: line.endSec,
    eventId: line.captionId, version: line.version,
  }))
}

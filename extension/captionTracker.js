const CAPTION_IDLE_MS = 2500
const CAPTION_MAX_CHARS = 700
const CAPTION_MIN_OVERLAP_WORDS = 3

function captionWords(text) {
  return text.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean)
}

function sharedPrefix(a, b) {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

function isRevision(previous, next) {
  const a = captionWords(previous)
  const b = captionWords(next)
  if (a.length === 0 || b.length === 0) return false
  const shared = sharedPrefix(a, b)
  return shared >= Math.max(1, Math.ceil(Math.min(a.length, b.length) * 0.5))
}

function scrollOverlap(previous, next) {
  const a = previous.split(/\s+/).filter(Boolean)
  const b = next.split(/\s+/).filter(Boolean)
  const na = captionWords(previous)
  const nb = captionWords(next)
  if (na.length !== a.length || nb.length !== b.length) return 0
  for (let size = Math.min(na.length, nb.length); size >= 2; size--) {
    if (size < CAPTION_MIN_OVERLAP_WORDS && size < Math.ceil(na.length / 2)) continue
    let same = true
    for (let i = 0; i < size; i++) {
      if (na[na.length - size + i] !== nb[i]) { same = false; break }
    }
    if (same) return size
  }
  return 0
}

function joinCaption(...parts) {
  return parts.filter(Boolean).join(' ')
}

function dropWords(text, count) {
  return text.split(/\s+/).filter(Boolean).slice(count).join(' ')
}

function createCaptionTracker({ now = () => Date.now(), idleMs = CAPTION_IDLE_MS, firstId = now() * 1000 } = {}) {
  const open = new Map()
  let counter = 0

  const textOf = (entry) => joinCaption(entry.base, dropWords(entry.window, entry.skip))

  function emit(entry, isFinal) {
    entry.version += 1
    entry.sent = textOf(entry)
    return { key: entry.key, eventId: String(entry.eventId), version: String(entry.version), text: entry.sent, isFinal, startedAt: entry.startedAt }
  }

  function start(key, text, at, skip = 0) {
    counter += 1
    const entry = { key, eventId: firstId + counter, version: 0, base: '', window: text, skip, sent: '', startedAt: at, updatedAt: at }
    open.set(key, entry)
    return textOf(entry) ? [emit(entry, false)] : []
  }

  function changed(entry) {
    return textOf(entry) && textOf(entry) !== entry.sent ? [emit(entry, false)] : []
  }

  function observe(key, raw) {
    const text = String(raw ?? '').replace(/\s+/g, ' ').trim()
    const at = now()
    if (!key || !text) return []
    const entry = open.get(key)
    if (!entry) return start(key, text, at)
    entry.updatedAt = at
    if (text === entry.window) return []
    if (isRevision(entry.window, text)) {
      entry.window = text
      return changed(entry)
    }
    const overlap = scrollOverlap(entry.window, text)
    if (overlap > 0) {
      const kept = entry.window.split(/\s+/).filter(Boolean)
      const scrolled = kept.length - overlap
      entry.base = joinCaption(entry.base, kept.slice(Math.min(entry.skip, scrolled), scrolled).join(' '))
      entry.skip = Math.max(0, entry.skip - scrolled)
      entry.window = text
      if (textOf(entry).length <= CAPTION_MAX_CHARS) return changed(entry)
      const closed = close(entry)
      return [...closed, ...start(key, text, at, text.split(/\s+/).filter(Boolean).length)]
    }
    return [...close(entry), ...start(key, text, at)]
  }

  function close(entry) {
    open.delete(entry.key)
    return entry.sent || textOf(entry) ? [emit(entry, true)] : []
  }

  function flush(force = false) {
    const at = now()
    const closed = []
    for (const entry of [...open.values()]) {
      if (!force && at - entry.updatedAt < idleMs) continue
      closed.push(...close(entry))
    }
    return closed
  }

  return { observe, flush }
}

globalThis.RekapinCaptions = { createCaptionTracker, isRevision, scrollOverlap }

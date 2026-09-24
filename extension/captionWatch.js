const CAPTION_POLL_MS = 300
const NAME_RETRY_MS = 5000
const NAME_ANCESTORS = 5
const SELF_WORDS = /^(you|anda|kamu|saya|me)$/i

let captionTimer = null
let captionTracker = null
let speakerKeys = new Map()
let itemSpeakers = new Map()
let captionPrimed = false
let rosterStamp = ''
let lastNameScan = 0

function tidyName(text) {
  const name = String(text ?? '').replace(/\s+/g, ' ').trim().replace(/\s*\((you|anda|kamu|host|me)\)$/i, '')
  if (!name || name.length > 60 || SELF_WORDS.test(name)) return null
  if (/[.!?,;:]$/.test(name) || !/\p{L}/u.test(name)) return null
  return name
}

function imageKey(src) {
  return String(src ?? '').split('?')[0]
}

function zoomSpeakerKey(item) {
  let node = item.previousElementSibling
  while (node) {
    if (node.tagName === 'IMG' && node.getAttribute('src')) return `avatar:${imageKey(node.getAttribute('src'))}`
    const initials = (node.textContent ?? '').trim()
    if (initials && initials.length <= 3) return `initials:${initials}`
    node = node.previousElementSibling
  }
  return 'unknown'
}

function nameNear(node, skip) {
  let current = node
  for (let depth = 0; depth < NAME_ANCESTORS && current; depth++) {
    const label = tidyName(current.getAttribute?.('aria-label'))
    if (label) return label
    for (const leaf of current.querySelectorAll?.('span, div, p') ?? []) {
      if (leaf.children.length > 0 || skip.contains(leaf)) continue
      const name = tidyName(leaf.textContent)
      if (name && name.split(' ').length <= 5) return name
    }
    current = current.parentElement
  }
  return null
}

function zoomNameFor(key, captionRoot) {
  if (!key.startsWith('avatar:')) return null
  const wanted = key.slice(7)
  for (const img of document.querySelectorAll('img')) {
    if (captionRoot.contains(img) || imageKey(img.getAttribute('src')) !== wanted) continue
    const alt = tidyName(img.getAttribute('alt'))
    if (alt) return alt
    const name = nameNear(img, captionRoot)
    if (name) return name
  }
  return null
}

const TEAMS_SKIP = 'button, [role="button"], [role="menu"], [data-tid*="setting" i], [data-tid*="overflow" i], [data-tid*="feedback" i]'
const TEAMS_AVATAR = 'img, [data-tid*="avatar" i], [class*="avatar" i]'
const TEAMS_ROW_DEPTH = 6
const TEAMS_SEEN_LIMIT = 400
let teamsRowIds = new WeakMap()
let teamsSeen = new Map()
let teamsRowCounter = 0

function textLeaves(node) {
  const leaves = []
  for (const element of node.querySelectorAll('*')) {
    if (element.closest(TEAMS_SKIP)) continue
    if ([...element.children].some((child) => (child.textContent ?? '').trim())) continue
    const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (text) leaves.push({ element, text })
  }
  return leaves
}

function teamsRows(root) {
  const rows = []
  const taken = new Set()
  for (const avatar of root.querySelectorAll(TEAMS_AVATAR)) {
    let node = avatar.parentElement
    for (let depth = 0; depth < TEAMS_ROW_DEPTH && node && node !== root.parentElement; depth++, node = node.parentElement) {
      const leaves = textLeaves(node).filter((leaf) => !avatar.contains(leaf.element))
      if (leaves.length < 2) continue
      if (!taken.has(node)) {
        taken.add(node)
        rows.push({ node, leaves })
      }
      break
    }
  }
  return rows.filter((row) => !rows.some((other) => other !== row && row.node.contains(other.node)))
}

function teamsRowKey(node, signature) {
  const known = teamsRowIds.get(node)
  if (known) return known
  const reused = teamsSeen.get(signature)
  const key = reused ?? `row${++teamsRowCounter}`
  teamsRowIds.set(node, key)
  return key
}

function teamsItems(root) {
  const items = []
  for (const { node, leaves } of teamsRows(root)) {
    const name = tidyName(leaves[0].text)
    const text = leaves.slice(1).map((leaf) => leaf.text).join(' ')
    if (!name || !text) continue
    const signature = `${name}|${text}`
    const key = teamsRowKey(node, signature)
    teamsSeen.set(signature, key)
    if (teamsSeen.size > TEAMS_SEEN_LIMIT) teamsSeen.delete(teamsSeen.keys().next().value)
    items.push({ key, speakerKey: `name:${name}`, name, text })
  }
  return items
}

const CAPTION_SOURCES = [
  {
    match: () => /(^|\.)zoom\.us$/.test(location.hostname),
    root: () => document.querySelector('#live-transcription-subtitle') ?? document.querySelector('.live-transcription-subtitle__content'),
    items: (root) => [...root.querySelectorAll('.live-transcription-subtitle__item')].map((item) => {
      const key = zoomSpeakerKey(item)
      return { key, speakerKey: key, name: null, text: item.textContent ?? '' }
    }),
    nameFor: zoomNameFor,
    meetingId: () => location.pathname.match(/\/(\d{9,12})(?:\/|$)/)?.[1] ?? `zoom:${location.hostname}`,
  },
  {
    match: () => /^teams\.(microsoft\.com|live\.com|cloud\.microsoft)$/.test(location.hostname),
    root: () => document.querySelector('[data-tid="closed-caption-v2-virtual-list-content"]') ?? document.querySelector('[data-tid="closed-caption-renderer-wrapper"]'),
    items: teamsItems,
    nameFor: () => null,
    meetingId: () => `teams:${location.hostname}`,
  },
]

const captionSource = CAPTION_SOURCES.find((source) => source.match()) ?? null

function captionSend(payload) {
  try {
    if (!chrome.runtime?.id) throw new Error('gone')
    chrome.runtime.sendMessage({ target: 'service', type: 'captionFeed', ...payload }).catch(() => {})
  } catch {
    stopCaptions()
  }
}

function speakerFor(key) {
  let speaker = speakerKeys.get(key)
  if (!speaker) {
    speaker = { id: `caption:${key}`.slice(0, 500), name: null, placeholder: `Pembicara ${speakerKeys.size + 1}` }
    speakerKeys.set(key, speaker)
  }
  return speaker
}

function syncRoster(root) {
  const now = Date.now()
  if (now - lastNameScan >= NAME_RETRY_MS) {
    lastNameScan = now
    for (const [key, speaker] of speakerKeys) {
      if (speaker.name) continue
      speaker.name = captionSource.nameFor(key, root)
    }
  }
  const users = [...speakerKeys.values()].map((speaker) => ({ id: speaker.id, name: speaker.name ?? speaker.placeholder, status: speaker.name ? '1' : 'placeholder' }))
  const stamp = JSON.stringify(users)
  if (stamp === rosterStamp) return
  rosterStamp = stamp
  captionSend({ event: 'roster', users })
}

function captionTick(final = false) {
  let root = null
  let events = []
  try {
    root = captionSource.root()
    if (root && !final) {
      for (const item of captionSource.items(root)) {
        const speaker = speakerFor(item.speakerKey)
        if (item.name && !speaker.name) speaker.name = item.name
        itemSpeakers.set(item.key, speaker)
        for (const event of captionTracker.observe(item.key, item.text)) events.push({ ...event, speaker })
      }
    }
    for (const event of captionTracker.flush(final)) {
      events.push({ ...event, speaker: itemSpeakers.get(event.key) ?? speakerFor(event.key) })
      itemSpeakers.delete(event.key)
    }
    if (root && speakerKeys.size > 0) syncRoster(root)
  } catch {
    events = []
  }
  if (!captionPrimed && root) {
    captionPrimed = true
    return
  }
  if (events.length === 0) return
  const meetingId = captionSource.meetingId()
  captionSend({
    event: 'utterances',
    utterances: events.map((event) => ({
      meetingId,
      eventId: event.eventId,
      version: event.version,
      participantId: event.speaker.id,
      text: event.text,
      isFinal: event.isFinal,
      timestamp: event.startedAt,
    })),
  })
}

function startCaptions() {
  if (captionTimer || !captionSource || !globalThis.RekapinCaptions) return
  captionTracker = globalThis.RekapinCaptions.createCaptionTracker()
  speakerKeys = new Map()
  itemSpeakers = new Map()
  captionPrimed = false
  teamsRowIds = new WeakMap()
  teamsSeen = new Map()
  rosterStamp = ''
  lastNameScan = 0
  captionTimer = setInterval(captionTick, CAPTION_POLL_MS)
}

function stopCaptions() {
  if (!captionTimer) return
  clearInterval(captionTimer)
  captionTimer = null
  captionTick(true)
}

function followRecording(status) {
  if (status === 'recording') startCaptions()
  else stopCaptions()
}

if (captionSource) {
  chrome.storage.local.get('liveState').then((stored) => followRecording(stored?.liveState?.status)).catch(() => {})
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.liveState) followRecording(changes.liveState.newValue?.status)
  })
}

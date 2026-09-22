const POLL_MS = 400
const MAX_NODES_PER_TILE = 80
const SELF_LABELS = ['you', 'anda', 'kamu', 'saya']

const SPEAKING_SELECTORS = [
  '[data-is-speaking="true"]',
  '[class*="speaking" i]',
  '[class*="active-speaker" i]',
  '[class*="speaker-active" i]',
]

const MARKED_SELECTORS = [
  '[class*="active-speaker" i]',
  '[class*="speaker-active" i]',
  '[class*="is-speaking" i]',
  '[class*="isSpeaking"]',
]

let timer = null
let lastSent = null

function cleanName(text) {
  const name = (text ?? '').replace(/\s+/g, ' ').trim().replace(/\s*\((you|anda|kamu)\)$/i, '')
  if (!name || name.length > 60) return null
  if (SELF_LABELS.includes(name.toLowerCase())) return null
  if (!/[a-zA-ZÀ-ɏ一-鿿]/.test(name)) return null
  return name
}

function hasActiveAnimation(tile) {
  if (!tile.querySelectorAll) return false
  const nodes = tile.querySelectorAll('div, span, svg')
  const limit = Math.min(nodes.length, MAX_NODES_PER_TILE)
  for (let i = 0; i < limit; i++) {
    const node = nodes[i]
    if (typeof node.getAnimations !== 'function') continue
    if (node.getAnimations().length === 0) continue
    const box = node.getBoundingClientRect()
    if (box.width > 0 && box.width <= 48 && box.height > 0 && box.height <= 48) return true
  }
  return false
}

function isSpeaking(tile) {
  for (const selector of SPEAKING_SELECTORS) {
    if (tile.querySelector(selector)) return true
  }
  return hasActiveAnimation(tile)
}

function tileName(tile) {
  const self = tile.querySelector('[data-self-name]')
  if (self) {
    const name = cleanName(self.textContent)
    if (name) return name
  }
  const candidates = tile.querySelectorAll('.notranslate, [data-participant-name], [class*="name" i]')
  for (const node of candidates) {
    const name = cleanName(node.textContent)
    if (name) return name
  }
  return cleanName(tile.getAttribute('aria-label'))
}

function meetSpeaker() {
  const tiles = document.querySelectorAll('[data-participant-id]')
  for (const tile of tiles) {
    if (!isSpeaking(tile)) continue
    const name = tileName(tile)
    if (name) return name
  }
  return null
}

function markedSpeaker() {
  for (const selector of MARKED_SELECTORS) {
    for (const node of document.querySelectorAll(selector)) {
      const box = node.getBoundingClientRect()
      if (box.width === 0 && box.height === 0) continue
      const name = cleanName(node.getAttribute('aria-label')) ?? tileName(node) ?? cleanName(node.textContent)
      if (name) return name
    }
  }
  return null
}

function detect() {
  if (location.hostname === 'meet.google.com') return meetSpeaker() ?? markedSpeaker()
  return markedSpeaker()
}

function tick() {
  let name = null
  try {
    name = detect()
  } catch {
    name = null
  }
  if (name === lastSent) return
  lastSent = name
  chrome.runtime.sendMessage({ target: 'service', type: 'speaker', name }).catch(() => {})
}

function setWatching(on) {
  if (on && !timer) {
    lastSent = null
    timer = setInterval(tick, POLL_MS)
    return
  }
  if (!on && timer) {
    clearInterval(timer)
    timer = null
    lastSent = null
  }
}

chrome.storage.local.get('liveState').then((stored) => {
  setWatching(stored?.liveState?.status === 'recording')
}).catch(() => {})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.liveState) return
  setWatching(changes.liveState.newValue?.status === 'recording')
})

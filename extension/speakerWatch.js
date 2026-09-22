const POLL_MS = 350
const CAPTION_GRACE_MS = 6000
const MAX_NODES_PER_ROW = 60
const SELF_LABELS = ['you', 'anda', 'kamu', 'saya']

const CAPTION_ROW_SELECTORS = ['.nMcdL', '[class*="caption" i] [class*="row" i]']
const CAPTION_NAME_SELECTORS = ['.NWpY1d', '[class*="speaker" i]', '[class*="author" i]']
const CAPTION_TEXT_SELECTORS = ['.ygicle', '[class*="text" i]']

const SPEAKING_SELECTORS = [
  '[data-is-speaking="true"]',
  '[class*="speaking" i]',
  '[class*="active-speaker" i]',
  '[class*="speaker-active" i]',
]

const isMeet = location.hostname === 'meet.google.com'

let timer = null
let lastName = null
let lastCaptionsOn = null
let lastRoster = ''
let watchingSince = 0
let enableTried = false

function cleanName(text) {
  const name = (text ?? '').replace(/\s+/g, ' ').trim().replace(/\s*\((you|anda|kamu)\)$/i, '')
  if (!name || name.length > 60) return null
  if (SELF_LABELS.includes(name.toLowerCase())) return null
  if (!/[a-zA-ZÀ-ɏ一-鿿]/.test(name)) return null
  return name
}

function firstMatch(root, selectors) {
  for (const selector of selectors) {
    const found = root.querySelector(selector)
    if (found) return found
  }
  return null
}

function structuralName(row) {
  const nodes = row.querySelectorAll('div, span')
  const limit = Math.min(nodes.length, MAX_NODES_PER_ROW)
  for (let i = 0; i < limit; i++) {
    const node = nodes[i]
    if (node.children.length > 0) continue
    const text = (node.textContent ?? '').trim()
    if (!text || text.length > 40) continue
    if (/[.!?,;:]$/.test(text)) continue
    const name = cleanName(text)
    if (name) return name
  }
  return null
}

function rowName(row) {
  const labelled = firstMatch(row, CAPTION_NAME_SELECTORS)
  if (labelled) {
    const name = cleanName(labelled.textContent)
    if (name) return name
  }
  return structuralName(row)
}

function rowHasText(row) {
  const body = firstMatch(row, CAPTION_TEXT_SELECTORS)
  const text = (body ?? row).textContent ?? ''
  return text.trim().length > 0
}

function knownCaptionRows() {
  for (const selector of CAPTION_ROW_SELECTORS) {
    const rows = document.querySelectorAll(selector)
    if (rows.length > 0) return Array.from(rows)
  }
  return []
}

function genericCaptionRows() {
  const rows = []
  for (const img of document.querySelectorAll('img')) {
    const box = img.getBoundingClientRect()
    if (box.width < 16 || box.width > 64) continue
    if (Math.abs(box.width - box.height) > 8) continue
    const row = img.parentElement?.parentElement
    if (!row || rows.includes(row)) continue
    if ((row.textContent ?? '').trim().length < 4) continue
    rows.push(row)
  }
  return rows
}

function captionRows() {
  const known = knownCaptionRows()
  if (known.length > 0) return known
  return genericCaptionRows()
}

function captionSpeaker() {
  const rows = captionRows()
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (!rowHasText(row)) continue
    const name = rowName(row)
    if (name) return { name, rows: rows.length }
  }
  return { name: null, rows: rows.length }
}

function meetRoster() {
  const names = []
  let self = null
  for (const tile of document.querySelectorAll('[data-participant-id]')) {
    const selfNode = tile.querySelector('[data-self-name]')
    const name = cleanName(selfNode?.textContent) ?? structuralName(tile)
    if (!name) continue
    if (selfNode) {
      self = name
      continue
    }
    if (!names.includes(name)) names.push(name)
  }
  return { names, self }
}

function tileSpeaker() {
  for (const tile of document.querySelectorAll('[data-participant-id]')) {
    let speaking = false
    for (const selector of SPEAKING_SELECTORS) {
      if (tile.querySelector(selector)) {
        speaking = true
        break
      }
    }
    if (!speaking) continue
    const self = tile.querySelector('[data-self-name]')
    const name = cleanName(self?.textContent) ?? structuralName(tile) ?? cleanName(tile.getAttribute('aria-label'))
    if (name) return name
  }
  return null
}

function tryEnableCaptions() {
  if (enableTried) return
  enableTried = true
  const buttons = document.querySelectorAll('button[aria-label], [role="button"][aria-label]')
  for (const button of buttons) {
    const label = button.getAttribute('aria-label') ?? ''
    if (!/caption|subtitle|teks|takarir/i.test(label)) continue
    if (!/turn on|aktifkan|nyalakan|hidupkan|enable/i.test(label)) continue
    button.click()
    return
  }
}

function send(payload) {
  chrome.runtime.sendMessage({ target: 'service', ...payload }).catch(() => {})
}

function tick() {
  let name = null
  let captionsOn = null
  let roster = null

  try {
    if (isMeet) {
      const caption = captionSpeaker()
      captionsOn = caption.rows > 0
      name = caption.name ?? tileSpeaker()
      roster = meetRoster()
      if (!captionsOn && Date.now() - watchingSince > CAPTION_GRACE_MS) tryEnableCaptions()
    } else {
      name = tileSpeaker()
    }
  } catch {
    name = null
  }

  if (captionsOn !== null && captionsOn !== lastCaptionsOn) {
    lastCaptionsOn = captionsOn
    send({ type: 'captions', on: captionsOn })
  }

  if (roster) {
    const stamp = JSON.stringify(roster)
    if (stamp !== lastRoster) {
      lastRoster = stamp
      send({ type: 'roster', names: roster.names, self: roster.self })
    }
  }

  if (name === lastName) return
  lastName = name
  send({ type: 'speaker', name })
}

function setWatching(on) {
  if (on && !timer) {
    lastName = null
    lastCaptionsOn = null
    lastRoster = ''
    enableTried = false
    watchingSince = Date.now()
    timer = setInterval(tick, POLL_MS)
    send({ type: 'watcher', on: true })
    return
  }
  if (!on && timer) {
    clearInterval(timer)
    timer = null
    lastName = null
    send({ type: 'watcher', on: false })
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'content' || message.type !== 'ping') return undefined
  sendResponse({ ok: true, watching: Boolean(timer) })
  return undefined
})

chrome.storage.local
  .get('liveState')
  .then((stored) => setWatching(stored?.liveState?.status === 'recording'))
  .catch(() => {})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.liveState) return
  setWatching(changes.liveState.newValue?.status === 'recording')
})

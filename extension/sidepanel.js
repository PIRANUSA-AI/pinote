import { readConfig } from './config.js'

const el = (id) => document.getElementById(id)
let config = null
let activeTab = null
let loggedIn = false
let authTimer = null
let clockTimer = null
let renderedCount = 0
let partialNode = null
let stickToBottom = true
let latestState = null
let language = 'id'
let searchQuery = ''
let matches = []
let activeMatch = -1

function show(node, visible) {
  node.hidden = !visible
}

function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = String(Math.floor(total / 60)).padStart(2, '0')
  const seconds = String(total % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
}

function meetingKind(url) {
  if (!url) return null
  if (url.startsWith('https://meet.google.com/')) return 'Google Meet'
  if (/^https:\/\/[^/]*\.?zoom\.us\//.test(url)) return 'Zoom'
  return null
}

async function loadTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  activeTab = tab ?? null
}

async function fetchMe() {
  try {
    const response = await fetch(`${config.apiBase}/auth/me`, { credentials: 'include' })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

async function syncAuth() {
  const me = await fetchMe()
  loggedIn = Boolean(me)
  show(el('loginView'), !loggedIn)
  show(el('mainView'), loggedIn)
  if (me) {
    el('userName').textContent = me.displayName || me.username || me.email
  }
  return loggedIn
}

function scrollToLatest() {
  const lines = el('liveLines')
  lines.scrollTop = lines.scrollHeight
  stickToBottom = true
  show(el('jumpLatest'), false)
}

function buildLine(entry, startedAt) {
  const row = document.createElement('div')
  row.className = 'liveLine'
  row.dataset.speaker = entry.speaker ?? ''
  row.dataset.text = entry.text

  const header = document.createElement('div')
  header.className = 'speaker'

  const who = document.createElement('span')
  who.className = 'who'
  who.textContent = entry.speaker ?? 'Rapat'
  header.appendChild(who)

  if (startedAt && entry.at) {
    const stamp = document.createElement('span')
    stamp.className = 'stamp'
    stamp.textContent = formatClock(entry.at - startedAt)
    header.appendChild(stamp)
  }

  const body = document.createElement('div')
  body.className = 'body'
  body.textContent = entry.text

  row.appendChild(header)
  row.appendChild(body)
  return row
}

function highlightInto(node, source, query) {
  node.textContent = ''
  if (!query) {
    node.textContent = source
    return 0
  }

  const haystack = source.toLowerCase()
  let cursor = 0
  let hits = 0

  while (true) {
    const found = haystack.indexOf(query, cursor)
    if (found === -1) break
    if (found > cursor) node.appendChild(document.createTextNode(source.slice(cursor, found)))
    const mark = document.createElement('mark')
    mark.textContent = source.slice(found, found + query.length)
    node.appendChild(mark)
    cursor = found + query.length
    hits += 1
  }

  node.appendChild(document.createTextNode(source.slice(cursor)))
  return hits
}

function focusMatch(scroll) {
  for (const previous of el('liveLines').querySelectorAll('.liveLine.hit')) previous.classList.remove('hit')
  for (const previous of el('liveLines').querySelectorAll('mark.active')) previous.classList.remove('active')

  const row = matches[activeMatch]
  if (!row) return

  row.classList.add('hit')
  const firstMark = row.querySelector('mark')
  if (firstMark) firstMark.classList.add('active')
  if (scroll) row.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

function updateSearchCount() {
  const node = el('searchCount')
  if (!searchQuery) {
    node.textContent = ''
  } else if (matches.length === 0) {
    node.textContent = 'nihil'
  } else {
    node.textContent = `${activeMatch + 1}/${matches.length}`
  }
  el('searchPrev').disabled = matches.length === 0
  el('searchNext').disabled = matches.length === 0
}

function applySearch() {
  const query = searchQuery.trim().toLowerCase()
  const rows = [...el('liveLines').querySelectorAll('.liveLine:not(.partial)')]
  matches = []

  for (const row of rows) {
    const body = row.querySelector('.body')
    const who = row.querySelector('.who')
    const textHits = highlightInto(body, row.dataset.text ?? '', query)
    const speakerHits = highlightInto(who, row.dataset.speaker || 'Rapat', query)
    if (query && textHits + speakerHits > 0) matches.push(row)
  }

  activeMatch = matches.length === 0 ? -1 : Math.min(Math.max(activeMatch, 0), matches.length - 1)
  updateSearchCount()
  focusMatch(false)
}

function stepMatch(delta) {
  if (matches.length === 0) return
  activeMatch = (activeMatch + delta + matches.length) % matches.length
  updateSearchCount()
  focusMatch(true)
}

function setSearchOpen(open) {
  show(el('headDefault'), !open)
  show(el('headSearch'), open)
  if (open) {
    el('searchInput').focus()
    el('searchInput').select()
  } else {
    searchQuery = ''
    el('searchInput').value = ''
    activeMatch = -1
    applySearch()
    scrollToLatest()
  }
}

function renderTranscript(state) {
  const lines = el('liveLines')
  const entries = state.lines ?? []

  if (entries.length < renderedCount) {
    lines.textContent = ''
    renderedCount = 0
    partialNode = null
  }

  if (partialNode) {
    partialNode.remove()
    partialNode = null
  }

  for (let i = renderedCount; i < entries.length; i++) {
    lines.appendChild(buildLine(entries[i], state.startedAt))
  }
  renderedCount = entries.length

  if (state.partial) {
    partialNode = document.createElement('div')
    partialNode.className = 'liveLine partial'
    partialNode.textContent = state.partial
    lines.appendChild(partialNode)
  }

  const hasContent = entries.length > 0 || Boolean(state.partial)
  show(lines, hasContent)
  show(el('emptyState'), !hasContent)
  el('lineCount').textContent = entries.length > 0 ? `${entries.length} baris` : ''

  if (searchQuery) {
    applySearch()
    return
  }

  if (stickToBottom) scrollToLatest()
}

function elapsedMs(state) {
  if (!state.startedAt) return 0
  const paused = state.paused && state.pausedAt ? Date.now() - state.pausedAt : 0
  return Math.max(0, Date.now() - state.startedAt - (state.pausedTotalMs ?? 0) - paused)
}

function renderControls(state) {
  const recording = state.status === 'recording' || state.status === 'starting'
  const uploading = state.status === 'uploading'
  const button = el('recordButton')
  const kind = meetingKind(activeTab?.url)

  show(el('recordDot'), recording && !state.paused)
  show(el('identityRow'), !recording)
  show(el('languageGroup'), !recording)
  show(el('pauseButton'), recording)
  el('sheet').className = recording ? 'sheet compact' : 'sheet'

  if (recording) {
    el('pauseButton').textContent = state.paused ? 'Lanjut' : 'Jeda'
    el('pauseButton').className = state.paused ? 'secondaryAction resumed' : 'secondaryAction'
    el('tabState').textContent = state.paused
      ? `Dijeda  ${formatClock(elapsedMs(state))}`
      : `Transkrip berjalan  ${formatClock(elapsedMs(state))}`
    el('tabState').className = state.paused ? 'tabState' : 'tabState active'
    button.disabled = false
    button.className = 'primaryAction grow recording'
    el('recordLabel').textContent = 'Berhenti dan kirim'
  } else if (uploading) {
    el('tabState').textContent = 'Mengirim rekaman ke Rekapin'
    el('tabState').className = 'tabState'
    button.disabled = true
    button.className = 'primaryAction grow'
    el('recordLabel').textContent = 'Mengirim...'
  } else {
    button.className = 'primaryAction grow'
    el('recordLabel').textContent = 'Mulai Rekapin'
    if (kind) {
      el('tabState').textContent = `${kind} terdeteksi di tab ini`
      el('tabState').className = 'tabState'
      button.disabled = false
    } else {
      el('tabState').textContent = 'Buka tab Google Meet atau Zoom web dulu. Aplikasi Zoom desktop tidak bisa direkam.'
      el('tabState').className = 'tabState warn'
      button.disabled = true
    }
  }

  show(el('resultBox'), state.status === 'done' && Boolean(state.jobId))
  show(el('errorBox'), Boolean(state.error))
  if (state.error) el('errorBox').textContent = state.error
  show(el('recoveryRow'), state.status === 'interrupted' && (state.lines ?? []).length > 0)
}

function applyState(state) {
  latestState = state
  renderControls(state)
  renderTranscript(state)
}

async function pullState() {
  const state = await chrome.runtime.sendMessage({ target: 'service', type: 'getState' })
  if (state) applyState(state)
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.target === 'panel' && message.type === 'state') applyState(message.state)
  return undefined
})

el('liveLines').addEventListener('scroll', () => {
  const lines = el('liveLines')
  const distance = lines.scrollHeight - lines.scrollTop - lines.clientHeight
  stickToBottom = distance < 48
  show(el('jumpLatest'), !stickToBottom)
})

el('jumpLatest').addEventListener('click', scrollToLatest)

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault()
    setSearchOpen(true)
  }
})

el('searchToggle').addEventListener('click', () => setSearchOpen(true))
el('searchClose').addEventListener('click', () => setSearchOpen(false))
el('searchPrev').addEventListener('click', () => stepMatch(-1))
el('searchNext').addEventListener('click', () => stepMatch(1))

el('searchInput').addEventListener('input', (event) => {
  searchQuery = event.target.value
  activeMatch = searchQuery ? 0 : -1
  applySearch()
  if (matches.length > 0) focusMatch(true)
})

el('searchInput').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault()
    setSearchOpen(false)
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    stepMatch(event.shiftKey ? -1 : 1)
  }
})

el('pauseButton').addEventListener('click', async () => {
  if (!latestState || latestState.status !== 'recording') return
  el('pauseButton').disabled = true
  await chrome.runtime.sendMessage({ target: 'service', type: 'pause', paused: !latestState.paused })
  el('pauseButton').disabled = false
  await pullState()
})

el('languageGroup').addEventListener('click', (event) => {
  const segment = event.target.closest('.segment')
  if (!segment) return
  for (const node of el('languageGroup').querySelectorAll('.segment')) {
    node.classList.toggle('active', node === segment)
  }
  language = segment.dataset.value
})

el('copyTranscript').addEventListener('click', async () => {
  const entries = latestState?.lines ?? []
  if (entries.length === 0) return
  const text = entries.map((entry) => (entry.speaker ? `${entry.speaker}: ${entry.text}` : entry.text)).join('\n')
  await navigator.clipboard.writeText(text)
  el('copyTranscript').textContent = 'Tersalin'
  setTimeout(() => {
    el('copyTranscript').textContent = 'Salin transkrip'
  }, 1500)
})

el('discardSession').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ target: 'service', type: 'reset' })
  await pullState()
})

el('loginButton').addEventListener('click', async () => {
  await chrome.tabs.create({ url: `${config.appBase}/login` })
})

el('openJob').addEventListener('click', async () => {
  if (latestState?.jobId) {
    await chrome.tabs.create({ url: `${config.appBase}/job/${latestState.jobId}` })
    await chrome.runtime.sendMessage({ target: 'service', type: 'reset' })
  }
})

el('recordButton').addEventListener('click', async () => {
  if (latestState?.status === 'recording') {
    el('recordButton').disabled = true
    await chrome.runtime.sendMessage({ target: 'service', type: 'stop' })
    await pullState()
    return
  }

  await loadTab()
  if (!activeTab?.id) return
  el('recordButton').disabled = true
  await chrome.runtime.sendMessage({
    target: 'service',
    type: 'start',
    tabId: activeTab.id,
    language,
  })
  await pullState()
})

chrome.tabs.onActivated.addListener(async () => {
  await loadTab()
  if (latestState) renderControls(latestState)
})

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.url && tabId === activeTab?.id) {
    await loadTab()
    if (latestState) renderControls(latestState)
  }
})

async function init() {
  config = await readConfig()
  await loadTab()
  await syncAuth()
  show(el('loadingView'), false)
  if (loggedIn) await pullState()

  authTimer = setInterval(async () => {
    if (!loggedIn && (await syncAuth())) await pullState()
  }, 2000)

  clockTimer = setInterval(() => {
    if (latestState && latestState.status === 'recording' && !latestState.paused) {
      renderControls(latestState)
    }
  }, 1000)
}

window.addEventListener('unload', () => {
  if (authTimer) clearInterval(authTimer)
  if (clockTimer) clearInterval(clockTimer)
})

init()

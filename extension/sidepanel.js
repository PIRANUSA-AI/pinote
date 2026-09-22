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

function show(node, visible) {
  node.hidden = !visible
}

function formatCredit(seconds) {
  if (!Number.isFinite(seconds)) return ''
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.round((seconds % 3600) / 60)
  if (hours > 0) return `sisa ${hours} jam ${minutes} menit`
  return `sisa ${minutes} menit`
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
    el('userCredit').textContent = formatCredit(me.creditSeconds)
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

  const header = document.createElement('div')
  header.className = 'speaker'

  const who = document.createElement('span')
  who.textContent = entry.speaker ?? 'Rapat'
  header.appendChild(who)

  if (startedAt && entry.at) {
    const stamp = document.createElement('span')
    stamp.className = 'stamp'
    stamp.textContent = formatClock(entry.at - startedAt)
    header.appendChild(stamp)
  }

  row.appendChild(header)
  row.appendChild(document.createTextNode(entry.text))
  return row
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

  if (stickToBottom) scrollToLatest()
}

function renderControls(state) {
  const recording = state.status === 'recording' || state.status === 'starting'
  const uploading = state.status === 'uploading'
  const button = el('recordButton')
  const kind = meetingKind(activeTab?.url)

  show(el('recordDot'), recording)

  if (recording) {
    el('tabState').textContent = state.startedAt
      ? `Transkrip berjalan  ${formatClock(Date.now() - state.startedAt)}`
      : 'Menyiapkan...'
    el('tabState').className = 'tabState active'
    button.disabled = false
    button.className = 'primaryAction recording'
    el('recordLabel').textContent = 'Berhenti dan kirim'
  } else if (uploading) {
    el('tabState').textContent = 'Mengirim rekaman ke Rekapin'
    el('tabState').className = 'tabState'
    button.disabled = true
    button.className = 'primaryAction'
    el('recordLabel').textContent = 'Mengirim...'
  } else {
    button.className = 'primaryAction'
    el('recordLabel').textContent = 'Mulai transkrip'
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

el('languageGroup').addEventListener('click', (event) => {
  const segment = event.target.closest('.segment')
  if (!segment) return
  for (const node of el('languageGroup').querySelectorAll('.segment')) {
    node.classList.toggle('active', node === segment)
  }
  language = segment.dataset.value
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
    if (latestState && (latestState.status === 'recording' || latestState.status === 'starting')) {
      renderControls(latestState)
    }
  }, 1000)
}

window.addEventListener('unload', () => {
  if (authTimer) clearInterval(authTimer)
  if (clockTimer) clearInterval(clockTimer)
})

init()

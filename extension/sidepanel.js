import { readConfig } from './config.js'
import { combineLines } from './transcriptBlocks.js'
import { formatTalk, talkTime } from './talkTime.js'
import { actionSentences, findActions } from './actionItems.js'
import { markdownFilename, transcriptMarkdown } from './transcriptMarkdown.js'

const el = (id) => document.getElementById(id)
const LANGUAGE_NAMES = {
  'id-ID': 'Indonesia', 'en-US': 'Inggris', 'es-ES': 'Spanyol', 'pt-BR': 'Portugis', 'fr-FR': 'Prancis', 'de-DE': 'Jerman',
  'it-IT': 'Italia', 'nl-NL': 'Belanda', 'vi-VN': 'Vietnam', 'ja-JP': 'Jepang', 'cmn-Hans-CN': 'Mandarin', 'ko-KR': 'Korea',
  'th-TH': 'Thai', 'ar-EG': 'Arab', 'ru-RU': 'Rusia', 'hi-IN': 'Hindi', 'he-IL': 'Ibrani', 'el-GR': 'Yunani',
}
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
let notice = ''
let authDelay = 1500
let focusMode = false
let actionsOpen = false
let actionKey = ''
let actionItems = []
let currentEntries = []

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
  if (url.startsWith('https://web.whatsapp.com/')) return 'WhatsApp'
  if (/^https:\/\/teams\.(microsoft\.com|live\.com|cloud\.microsoft)\//.test(url)) return 'Microsoft Teams'
  return null
}

function sourceFor(url) {
  const kind = meetingKind(url)
  if (kind === 'Google Meet') return 'meet'
  if (kind === 'Zoom') return 'zoom'
  if (kind === 'WhatsApp') return 'whatsapp'
  if (kind === 'Microsoft Teams') return 'teams'
  return 'upload'
}

function isNewerVersion(candidate, installed) {
  const a = String(candidate).split('.').map((part) => Number(part) || 0)
  const b = String(installed).split('.').map((part) => Number(part) || 0)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff > 0
  }
  return false
}

async function checkForUpdate() {
  try {
    const response = await fetch(`${config.appBase}/downloads/latest.json?t=${Date.now()}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    })
    if (!response.ok) return
    const latest = await response.json()
    const installed = chrome.runtime.getManifest().version
    if (!latest?.version || !isNewerVersion(latest.version, installed)) return
    const banner = el('updateBanner')
    banner.textContent = `Versi ${latest.version} tersedia (kamu memakai ${installed}). Klik untuk mengunduh.`
    show(banner, true)
  } catch {
    return
  }
}

async function micPermissionState() {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' })
    return status.state
  } catch {
    return 'prompt'
  }
}

async function loadTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  activeTab = tab ?? null
}

const AUTH_TIMEOUT_MS = 8000
const AUTH_DELAY_MIN_MS = 1500
const AUTH_DELAY_MAX_MS = 30000

async function fetchMe() {
  try {
    const response = await fetch(`${config.apiBase}/auth/me`, {
      credentials: 'include',
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    })
    if (response.status === 401) return { state: 'loggedOut', user: null }
    if (!response.ok) return { state: 'error', user: null }
    return { state: 'loggedIn', user: await response.json() }
  } catch {
    return { state: 'error', user: null }
  }
}

async function syncAuth() {
  const result = await fetchMe()
  loggedIn = result.state === 'loggedIn'
  show(el('loadingView'), false)
  show(el('errorView'), result.state === 'error')
  show(el('loginView'), result.state === 'loggedOut')
  show(el('mainView'), loggedIn)
  if (result.user) {
    const name = result.user.displayName || result.user.username || result.user.email
    el('userName').textContent = name
    chrome.storage.local.set({ displayName: name }).catch(() => {})
  }
  return loggedIn
}

function scheduleAuth(ms) {
  clearTimeout(authTimer)
  authTimer = setTimeout(authTick, ms)
}

async function authTick() {
  if (loggedIn) return
  if (document.hidden) {
    scheduleAuth(5000)
    return
  }
  if (await syncAuth()) {
    await pullState()
    return
  }
  authDelay = Math.min(authDelay * 1.6, AUTH_DELAY_MAX_MS)
  scheduleAuth(authDelay)
}

function restartAuthPolling() {
  if (loggedIn) return
  authDelay = AUTH_DELAY_MIN_MS
  scheduleAuth(300)
}

function scrollToLatest() {
  const lines = el('liveLines')
  lines.scrollTop = lines.scrollHeight
  stickToBottom = true
  show(el('jumpLatest'), false)
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const CHAT_ICON = ['M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6c-.5.4-1.3.1-1.3-.6V16A2.5 2.5 0 0 1 4 13.5z']
const COPY_ICON = ['M9 9.5A1.5 1.5 0 0 1 10.5 8h8A1.5 1.5 0 0 1 20 9.5v9a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 9 18.5z', 'M15 8V5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H9']
const CHECK_ICON = ['M5 12.5l4.5 4.5L19 7.5']
const PAUSE_ICON = ['M9 5.5v13', 'M15 5.5v13']
const PLAY_ICON = ['M8 5.8v12.4a1 1 0 0 0 1.5.9l9.8-6.2a1 1 0 0 0 0-1.7L9.5 4.9A1 1 0 0 0 8 5.8z']

function icon(paths, className = '') {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '13')
  svg.setAttribute('height', '13')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  if (className) svg.setAttribute('class', className)
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.appendChild(path)
  }
  return svg
}

async function copyEntry(button, entry, startedAt) {
  const stamp = startedAt && entry.at ? `[${formatClock(entry.at - startedAt)}] ` : ''
  const who = entry.speaker ? `${entry.speaker}${entry.chat ? ' (Chat)' : ''}: ` : ''
  try {
    await navigator.clipboard.writeText(`${stamp}${who}${entry.text}`)
  } catch {
    return
  }
  button.replaceChildren(icon(CHECK_ICON))
  button.classList.add('done')
  setTimeout(() => {
    button.replaceChildren(icon(COPY_ICON))
    button.classList.remove('done')
  }, 1200)
}

function continues(entries, index) {
  const entry = entries[index]
  const previous = entries[index - 1]
  return Boolean(previous && entry)
    && (previous.speaker ?? '') === (entry.speaker ?? '')
    && previous.participantId === entry.participantId
    && Boolean(previous.chat) === Boolean(entry.chat)
}

function buildLine(entry, startedAt, continued = false) {
  const row = document.createElement('div')
  row.className = continued ? 'liveLine continued' : 'liveLine'
  row.dataset.speaker = entry.speaker ?? ''
  row.dataset.text = entry.text
  row.dataset.continued = continued ? '1' : ''
  if (actionSentences(entry.text).length > 0) row.classList.add('hasAction')

  const header = document.createElement('div')
  header.className = 'speaker'

  const who = document.createElement('span')
  who.className = 'who'
  who.textContent = continued ? '' : entry.speaker ?? 'Rapat'
  who.hidden = continued
  header.appendChild(who)

  if (entry.chat) {
    row.classList.add('chat')
    const badge = icon(CHAT_ICON, 'chatIcon')
    badge.setAttribute('role', 'img')
    badge.setAttribute('aria-label', 'Dari chat')
    const tip = document.createElementNS(SVG_NS, 'title')
    tip.textContent = 'Dari chat'
    badge.prepend(tip)
    who.after(badge)
  }

  const meta = document.createElement('span')
  meta.className = 'lineMeta'
  if (startedAt && entry.at) {
    const stamp = document.createElement('span')
    stamp.className = 'stamp'
    stamp.textContent = formatClock(entry.at - startedAt)
    meta.appendChild(stamp)
  }
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.className = 'copyLine'
  copy.title = 'Salin bagian ini'
  copy.setAttribute('aria-label', 'Salin bagian ini')
  copy.appendChild(icon(COPY_ICON))
  copy.addEventListener('click', () => copyEntry(copy, entry, startedAt))
  meta.appendChild(copy)
  header.appendChild(meta)

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
    const speakerHits = row.dataset.continued ? 0 : highlightInto(who, row.dataset.speaker || 'Rapat', query)
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
  const entries = combineLines(state.lines ?? [])

  if (entries.length < renderedCount) {
    lines.textContent = ''
    renderedCount = 0
    partialNode = null
  }

  if (partialNode) {
    partialNode.remove()
    partialNode = null
  }

  for (let i = 0; i < Math.min(renderedCount, entries.length); i++) {
    const rendered = lines.children[i]
    const entry = entries[i]
    const continued = continues(entries, i)
    if (rendered && entry && (rendered.dataset.text !== entry.text
      || rendered.dataset.speaker !== (entry.speaker ?? '')
      || Boolean(rendered.dataset.continued) !== continued)) {
      lines.replaceChild(buildLine(entry, state.startedAt, continued), rendered)
    }
  }

  for (let i = renderedCount; i < entries.length; i++) {
    lines.appendChild(buildLine(entries[i], state.startedAt, continues(entries, i)))
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
  currentEntries = entries
  show(el('exportWrap'), entries.length > 0)
  if (entries.length === 0) closeExportMenu()
  renderActions(entries, state.startedAt)

  if (searchQuery) {
    applySearch()
    return
  }

  if (stickToBottom) scrollToLatest()
}

function renderActions(entries, startedAt) {
  actionItems = findActions(entries)
  const toggle = el('actionToggle')
  const count = actionItems.length
  if (count === 0) actionsOpen = false
  show(toggle, count > 0)
  el('actionCount').textContent = String(count)
  toggle.setAttribute('aria-label', `${count} tugas terdengar`)
  toggle.setAttribute('aria-expanded', String(actionsOpen))
  toggle.classList.toggle('open', actionsOpen)
  show(el('actionPanel'), actionsOpen)

  const key = `${startedAt}|${JSON.stringify(actionItems)}`
  if (key === actionKey) return
  actionKey = key
  const list = el('actionList')
  list.textContent = ''
  for (const item of actionItems) {
    const entry = document.createElement('li')
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'actionItem'
    const who = document.createElement('span')
    who.className = 'actionWho'
    const stamp = startedAt && item.at ? ` · ${formatClock(item.at - startedAt)}` : ''
    who.textContent = `${item.speaker || 'Rapat'}${stamp}`
    const text = document.createElement('span')
    text.className = 'actionText'
    text.textContent = item.text
    button.append(who, text)
    button.addEventListener('click', () => jumpToLine(item.index))
    entry.appendChild(button)
    list.appendChild(entry)
  }
}

function jumpToLine(index) {
  const row = el('liveLines').children[index]
  if (!row) return
  row.scrollIntoView({ block: 'center', behavior: 'smooth' })
  row.classList.remove('flash')
  void row.offsetWidth
  row.classList.add('flash')
}

function closeExportMenu() {
  show(el('exportMenu'), false)
  el('exportToggle').setAttribute('aria-expanded', 'false')
}

function exportMarkdown() {
  const state = latestState ?? {}
  const recording = state.status === 'recording' || state.status === 'starting'
  const last = currentEntries.at(-1)
  const lastAt = last ? (last.endAt ?? last.at) : null
  return transcriptMarkdown({
    entries: currentEntries,
    startedAt: state.startedAt,
    source: state.source,
    attendance: state.attendance ?? [],
    talk: talkTime(state.lines),
    actions: actionItems,
    durationMs: recording ? elapsedMs(state) : state.startedAt && lastAt ? lastAt - state.startedAt : 0,
  })
}

function flashLabel(button, text) {
  const original = button.dataset.label ?? button.textContent
  button.dataset.label = original
  button.textContent = text
  setTimeout(() => { button.textContent = original }, 1400)
}

function elapsedMs(state) {
  if (!state.startedAt) return 0
  const paused = state.paused && state.pausedAt ? Date.now() - state.pausedAt : 0
  return Math.max(0, Date.now() - state.startedAt - (state.pausedTotalMs ?? 0) - paused)
}

function bgUploadText(bg) {
  if (bg.status === 'uploading') {
    return bg.queued > 1
      ? `Mengirim ${bg.queued} rekaman sebelumnya di latar belakang`
      : 'Mengirim rekaman sebelumnya di latar belakang'
  }
  if (bg.status === 'retrying') {
    return `Rekaman sebelumnya belum terkirim. Mencoba lagi dalam ${secondsUntil(bg.retryAt)} detik (${bg.attempt}/${bg.max}).`
  }
  if (bg.status === 'done') return 'Rekaman sebelumnya sudah terkirim ke Rekapin'
  return bg.message || 'Rekaman sebelumnya belum terkirim'
}

let talkKey = ''

function renderTalkTime(items) {
  const row = el('talkRow')
  const key = JSON.stringify(items)
  if (key === talkKey) return
  talkKey = key
  row.textContent = ''
  const visible = items.length > 1
  show(row, visible)
  if (!visible) return
  for (const item of items) {
    const entry = document.createElement('div')
    entry.className = 'talkItem'
    const name = document.createElement('span')
    name.className = 'talkName'
    name.textContent = item.name
    const meta = document.createElement('span')
    meta.className = 'talkMeta'
    meta.textContent = `${formatTalk(item.seconds)} · ${item.share}%`
    const bar = document.createElement('div')
    bar.className = 'talkBar'
    const fill = document.createElement('div')
    fill.className = 'talkFill'
    fill.style.width = `${item.share}%`
    bar.appendChild(fill)
    entry.append(name, meta, bar)
    row.appendChild(entry)
  }
}

function renderFocusBar(state) {
  const live = state.live?.status
  const clock = el('focusExpand')
  el('focusTime').textContent = formatClock(elapsedMs(state))
  clock.className = live === 'reconnecting' || live === 'lost' ? 'focusClock warn' : state.paused ? 'focusClock paused' : 'focusClock'
  clock.title = el('tabState').textContent
  const pause = el('focusPause')
  const mode = state.paused ? 'play' : 'pause'
  if (pause.dataset.mode !== mode) {
    pause.dataset.mode = mode
    pause.replaceChildren(icon(state.paused ? PLAY_ICON : PAUSE_ICON))
    pause.title = state.paused ? 'Lanjutkan' : 'Jeda'
    pause.setAttribute('aria-label', state.paused ? 'Lanjutkan rekaman' : 'Jeda rekaman')
  }
  el('focusFinish').disabled = el('recordButton').disabled
}

function setFocusMode(value) {
  focusMode = value
  chrome.storage.local.set({ focusMode }).catch(() => {})
  if (latestState) renderControls(latestState)
  el(value ? 'focusExpand' : 'focusToggle').focus()
}

function renderControls(state) {
  const recording = state.status === 'recording' || state.status === 'starting'
  const uploading = state.status === 'uploading'
  const button = el('recordButton')
  const kind = meetingKind(activeTab?.url)

  show(el('recordDot'), recording && !state.paused)
  show(el('identityRow'), !recording)
  show(el('languageGroup'), !recording)
  show(el('startHint'), Boolean(kind) && (state.status === 'idle' || state.status === 'error'))

  const bg = state.background
  if (bg) {
    el('bgUpload').textContent = bgUploadText(bg)
    el('bgUpload').className = bg.status === 'failed' ? 'bgUpload warn' : 'bgUpload'
  }
  show(el('bgUpload'), Boolean(bg))
  show(el('pauseButton'), recording)
  show(el('cancelButton'), recording)
  show(el('insightRow'), !recording)
  const attendance = state.attendance ?? []
  const onMeet = state.source === 'meet'
  show(el('watcherHint'), recording && onMeet && !state.watcherOn)
  if (attendance.length > 0) el('attendanceRow').textContent = `Hadir: ${attendance.join(', ')}`
  show(el('attendanceRow'), recording && attendance.length > 0)
  renderTalkTime(recording ? talkTime(state.lines) : [])
  const active = onMeet ? state.meetStats?.language : ''
  if (active) {
    const name = LANGUAGE_NAMES[active] ?? active
    const mode = state.meetStats.autoLanguage ? ' · otomatis' : ''
    el('languageRow').textContent = `Bahasa transkrip: ${name}${mode}`
  }
  const autoElsewhere = !onMeet && state.language === 'auto'
  if (autoElsewhere) el('languageRow').textContent = 'Bahasa transkrip langsung: Indonesia. Untuk rapat berbahasa Inggris, pilih English sebelum mulai.'
  show(el('languageRow'), recording && (Boolean(active) || autoElsewhere))
  const offer = recording && onMeet ? state.languageSuggestion : null
  if (offer) {
    const name = LANGUAGE_NAMES[offer.code] ?? offer.code
    el('languageSuggestText').textContent = `Terdeteksi bahasa ${name}`
    el('languageSuggestApply').textContent = `Ganti ke ${name}`
    el('languageSuggest').dataset.code = offer.code
  }
  show(el('languageSuggest'), Boolean(offer))
  if (!recording) closeCancelModal()
  const focused = recording && focusMode
  el('sheet').className = focused ? 'sheet compact focus' : recording ? 'sheet compact' : 'sheet'
  show(el('focusToggle'), recording && !focused)
  show(el('focusBar'), focused)

  if (recording) {
    el('pauseButton').textContent = state.paused ? 'Lanjut' : 'Jeda'
    el('pauseButton').className = state.paused ? 'secondaryAction resumed' : 'secondaryAction'
    const label = state.source === 'whatsapp' ? 'Transkrip privat berjalan' : 'Transkrip berjalan'
    const live = state.live?.status
    if (live === 'reconnecting') {
      el('tabState').textContent = `Koneksi terputus. Menyambung ulang dalam ${secondsUntil(state.live.retryAt)} detik (${state.live.attempt}/${state.live.max}). Rekaman tetap berjalan.`
      el('tabState').className = 'tabState warn'
    } else if (live === 'lost') {
      el('tabState').textContent = 'Transkrip langsung terhenti, tapi rekaman tetap berjalan dan diproses lengkap setelah selesai.'
      el('tabState').className = 'tabState warn'
    } else {
      el('tabState').textContent = state.paused
        ? `Dijeda  ${formatClock(elapsedMs(state))}`
        : `${label}  ${formatClock(elapsedMs(state))}`
      el('tabState').className = state.paused ? 'tabState' : 'tabState active'
    }
    button.disabled = false
    button.className = 'primaryAction grow recording'
    el('recordLabel').textContent = 'Selesai'
    renderFocusBar(state)
  } else if (uploading) {
    if (state.upload?.retryAt) {
      el('tabState').textContent = `Gagal mengirim. Mencoba lagi dalam ${secondsUntil(state.upload.retryAt)} detik (${state.upload.attempt}/${state.upload.max}). Rekaman aman.`
      el('tabState').className = 'tabState warn'
    } else {
      el('tabState').textContent = 'Mengirim rekaman ke Rekapin'
      el('tabState').className = 'tabState'
    }
    button.disabled = !kind
    button.className = 'primaryAction grow'
    el('recordLabel').textContent = 'Mulai Rekapin'
  } else if (state.status === 'uploadFailed') {
    el('tabState').textContent = 'Rekaman belum terkirim, tapi masih aman tersimpan di browser ini.'
    el('tabState').className = 'tabState warn'
    button.disabled = true
    button.className = 'primaryAction grow'
    el('recordLabel').textContent = 'Belum terkirim'
  } else {
    button.className = 'primaryAction grow'
    el('recordLabel').textContent = 'Mulai Rekapin'
    if (kind) {
      const detected = kind === 'WhatsApp'
        ? 'WhatsApp terdeteksi. Mode privat: tugas hanya untuk kamu, tanpa email, dan tidak bisa dibagikan.'
        : `${kind} terdeteksi di tab ini`
      el('tabState').textContent = notice || detected
      el('tabState').className = kind === 'WhatsApp' ? 'tabState private' : 'tabState'
      button.disabled = false
    } else {
      el('tabState').textContent = 'Buka tab Google Meet, Zoom web, Microsoft Teams web, atau WhatsApp Web dulu. Aplikasi desktop tidak bisa direkam.'
      el('tabState').className = 'tabState warn'
      button.disabled = true
    }
  }

  show(el('resultBox'), state.status === 'done' && Boolean(state.jobId))
  show(el('errorBox'), Boolean(state.error))
  if (state.error) el('errorBox').textContent = state.error
  const hasLines = (state.lines ?? []).length > 0
  show(el('recoveryRow'), state.status === 'interrupted' && (hasLines || Boolean(state.recoveryId)))
  show(el('recoverUpload'), state.status === 'interrupted' && Boolean(state.recoveryId))
  show(el('copyTranscript'), hasLines)
  show(el('uploadRow'), state.status === 'uploadFailed')
}

function secondsUntil(timestamp) {
  if (!timestamp) return 0
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 1000))
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
  if (message.target !== 'panel') return undefined
  if (message.type === 'state') applyState(message.state)
  if (message.type === 'micPermission') {
    notice = message.granted
      ? 'Mikrofon siap. Tekan Mulai Rekapin.'
      : 'Mikrofon ditolak. Rekapin tetap jalan, tapi hanya suara peserta lain yang tertangkap.'
    if (latestState) renderControls(latestState)
  }
  return undefined
})

el('liveLines').addEventListener('scroll', () => {
  const lines = el('liveLines')
  const distance = lines.scrollHeight - lines.scrollTop - lines.clientHeight
  stickToBottom = distance < 48
  show(el('jumpLatest'), !stickToBottom)
})

el('jumpLatest').addEventListener('click', scrollToLatest)

el('actionToggle').addEventListener('click', () => {
  actionsOpen = !actionsOpen
  renderActions(currentEntries, latestState?.startedAt)
})

el('exportToggle').addEventListener('click', (event) => {
  event.stopPropagation()
  const open = el('exportMenu').hidden
  show(el('exportMenu'), open)
  el('exportToggle').setAttribute('aria-expanded', String(open))
  if (open) el('exportCopy').focus()
})

el('exportMenu').addEventListener('click', (event) => event.stopPropagation())
document.addEventListener('click', closeExportMenu)
el('exportMenu').addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  closeExportMenu()
  el('exportToggle').focus()
})

el('exportCopy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(exportMarkdown())
    flashLabel(el('exportCopy'), 'Tersalin')
  } catch {
    flashLabel(el('exportCopy'), 'Gagal menyalin')
  }
})

el('exportDownload').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([exportMarkdown()], { type: 'text/markdown;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = markdownFilename(latestState?.startedAt)
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  closeExportMenu()
})

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

function cancellable() {
  return Boolean(latestState) && (latestState.status === 'recording' || latestState.status === 'starting')
}

function openCancelModal() {
  show(el('cancelModal'), true)
  el('cancelKeep').focus()
}

function closeCancelModal() {
  show(el('cancelModal'), false)
  el('cancelConfirm').disabled = false
}

el('cancelButton').addEventListener('click', () => {
  if (cancellable()) openCancelModal()
})

el('cancelKeep').addEventListener('click', closeCancelModal)

el('focusToggle').addEventListener('click', () => setFocusMode(true))
el('focusExpand').addEventListener('click', () => setFocusMode(false))
el('focusCancel').addEventListener('click', () => el('cancelButton').click())
el('focusPause').addEventListener('click', () => el('pauseButton').click())
el('focusFinish').addEventListener('click', () => el('recordButton').click())

async function answerSuggestion(type) {
  const code = el('languageSuggest').dataset.code
  if (!code) return
  el('languageSuggestApply').disabled = true
  await chrome.runtime.sendMessage({ target: 'service', type, code }).catch(() => null)
  el('languageSuggestApply').disabled = false
  await pullState()
}

el('languageSuggestApply').addEventListener('click', () => answerSuggestion('switchLanguage'))
el('languageSuggestDismiss').addEventListener('click', () => answerSuggestion('dismissLanguage'))

el('cancelModal').addEventListener('click', (event) => {
  if (event.target === el('cancelModal')) closeCancelModal()
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !el('cancelModal').hidden) closeCancelModal()
})

el('cancelConfirm').addEventListener('click', async () => {
  if (!cancellable()) {
    closeCancelModal()
    return
  }
  el('cancelConfirm').disabled = true
  el('cancelButton').disabled = true
  await chrome.runtime.sendMessage({ target: 'service', type: 'cancel' }).catch(() => null)
  el('cancelButton').disabled = false
  closeCancelModal()
  await pullState()
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
  chrome.storage.local.set({ language }).catch(() => {})
})

el('copyTranscript').addEventListener('click', async () => {
  const entries = combineLines(latestState?.lines ?? [])
  if (entries.length === 0) return
  const text = entries.map((entry) => {
    const who = entry.speaker ? `${entry.speaker}${entry.chat ? ' (Chat)' : ''}: ` : entry.chat ? 'Chat: ' : ''
    return `${who}${entry.text}`
  }).join('\n')
  await navigator.clipboard.writeText(text)
  el('copyTranscript').textContent = 'Tersalin'
  setTimeout(() => {
    el('copyTranscript').textContent = 'Salin transkrip'
  }, 1500)
})

el('retryUploadButton').addEventListener('click', async () => {
  el('retryUploadButton').disabled = true
  await chrome.runtime.sendMessage({ target: 'service', type: 'retryUpload' })
  el('retryUploadButton').disabled = false
  await pullState()
})

el('discardUploadButton').addEventListener('click', async () => {
  const sure = window.confirm('Buang rekaman ini? Rekaman yang belum terkirim akan hilang permanen.')
  if (!sure) return
  await chrome.runtime.sendMessage({ target: 'service', type: 'discardUpload' })
  await pullState()
})

el('recoverUpload').addEventListener('click', async () => {
  el('recoverUpload').disabled = true
  await chrome.runtime.sendMessage({ target: 'service', type: 'recoverUpload' }).catch(() => null)
  el('recoverUpload').disabled = false
  await pullState()
})

el('discardSession').addEventListener('click', async () => {
  if (latestState?.recoveryId && !window.confirm('Buang rekaman ini? Audio yang tersimpan akan hilang permanen.')) return
  await chrome.runtime.sendMessage({ target: 'service', type: 'reset' })
  await pullState()
})

el('loginButton').addEventListener('click', async () => {
  await chrome.tabs.create({ url: `${config.appBase}/login` })
  restartAuthPolling()
})

el('updateBanner').addEventListener('click', async () => {
  await chrome.tabs.create({ url: `${config.appBase}/extension` })
})

el('retryButton').addEventListener('click', async () => {
  el('retryButton').disabled = true
  show(el('errorView'), false)
  show(el('loadingView'), true)
  if (await syncAuth()) await pullState()
  else restartAuthPolling()
  el('retryButton').disabled = false
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

  if ((await micPermissionState()) === 'prompt') {
    notice = 'Izinkan mikrofon di tab yang baru terbuka, lalu tekan Mulai Rekapin lagi.'
    if (latestState) renderControls(latestState)
    await chrome.tabs.create({ url: chrome.runtime.getURL(`micPermission.html?returnTab=${activeTab.id}`) })
    return
  }

  notice = ''
  el('recordButton').disabled = true
  await chrome.runtime.sendMessage({
    target: 'service',
    type: 'start',
    tabId: activeTab.id,
    language,
    source: sourceFor(activeTab.url),
    mode: 'invoke',
    skipInsights: !el('autoInsights').checked,
  })
  el('recordButton').disabled = false
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

el('autoInsights').addEventListener('change', () => {
  chrome.storage.local.set({ autoInsights: el('autoInsights').checked }).catch(() => {})
})

async function restorePreferences() {
  const stored = await chrome.storage.local.get(['autoInsights', 'focusMode']).catch(() => null)
  el('autoInsights').checked = stored?.autoInsights !== false
  focusMode = stored?.focusMode === true
}

async function restoreLanguage() {
  const stored = await chrome.storage.local.get('language').catch(() => null)
  if (!stored?.language) return
  language = stored.language
  for (const node of el('languageGroup').querySelectorAll('.segment')) {
    node.classList.toggle('active', node.dataset.value === language)
  }
}

async function init() {
  config = await readConfig()
  await restoreLanguage()
  await restorePreferences()
  await loadTab()
  void checkForUpdate()
  await syncAuth()
  if (loggedIn) await pullState()
  else scheduleAuth(authDelay)

  clockTimer = setInterval(() => {
    if (!latestState) return
    const ticking = (latestState.status === 'recording' && !latestState.paused)
      || latestState.live?.status === 'reconnecting'
      || Boolean(latestState.upload?.retryAt)
      || Boolean(latestState.background?.retryAt)
    if (ticking) renderControls(latestState)
  }, 1000)
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) restartAuthPolling()
})

window.addEventListener('unload', () => {
  clearTimeout(authTimer)
  if (clockTimer) clearInterval(clockTimer)
})

init()

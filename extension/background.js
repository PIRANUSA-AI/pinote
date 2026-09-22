import { readConfig } from './config.js'

const ACTIVE_STATUSES = ['starting', 'recording', 'uploading', 'uploadFailed']
const MENU_ID = 'mulaiRekapin'
const SPEAKER_MEMORY_MS = 10 * 60 * 1000
const SPEAKER_TAIL_MS = 1200
const MERGE_WINDOW_MS = 4000
const MEETING_PATTERNS = ['https://meet.google.com/*', 'https://*.zoom.us/*', 'https://web.whatsapp.com/*']

const state = {
  status: 'idle',
  lines: [],
  partial: '',
  jobId: null,
  error: null,
  tabId: null,
  startedAt: null,
  paused: false,
  pausedAt: null,
  pausedTotalMs: 0,
  micOn: true,
  source: null,
  live: null,
  upload: null,
  background: null,
  captionsOn: null,
  utteranceStart: null,
}

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})

chrome.storage.local.remove(['apiBase', 'appBase']).catch(() => {})

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create(
    {
      id: MENU_ID,
      title: 'Mulai Rekapin di tab ini',
      contexts: ['page', 'video', 'audio', 'selection'],
      documentUrlPatterns: MEETING_PATTERNS,
    },
    () => chrome.runtime.lastError,
  )
})

let speakerEvents = []
let selfName = 'Saya'
let lastLiveError = null

chrome.storage.local
  .get('displayName')
  .then((stored) => {
    if (stored?.displayName) selfName = stored.displayName
  })
  .catch(() => {})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.displayName) return
  if (changes.displayName.newValue) selfName = changes.displayName.newValue
})

function noteSpeaker(name) {
  const at = Date.now()
  const last = speakerEvents[speakerEvents.length - 1]
  if (last) last.until = at
  if (!last || last.name !== name) speakerEvents.push({ name: name ?? null, at, until: at })
  const cutoff = at - SPEAKER_MEMORY_MS
  speakerEvents = speakerEvents.filter((event) => event.until >= cutoff)
}

function dominantName(from, to) {
  const totals = new Map()
  for (const event of speakerEvents) {
    if (!event.name) continue
    const start = Math.max(event.at, from)
    const end = Math.min(event.until + SPEAKER_TAIL_MS, to)
    if (end <= start) continue
    totals.set(event.name, (totals.get(event.name) ?? 0) + (end - start))
  }
  let best = null
  let bestMs = 0
  for (const [name, ms] of totals) {
    if (ms > bestMs) {
      best = name
      bestMs = ms
    }
  }
  return best
}

function clearLiveError() {
  if (!state.error || state.error !== lastLiveError) return
  state.error = null
  lastLiveError = null
}

function resolveSpeaker(source, from, to) {
  if (source === 'self') return selfName
  const name = dominantName(from, to)
  if (name) return name
  return source === 'remote' ? 'Peserta' : null
}

function sourceFor(url) {
  if (!url) return 'upload'
  if (url.startsWith('https://meet.google.com/')) return 'meet'
  if (/^https:\/\/[^/]*\.?zoom\.us\//.test(url)) return 'zoom'
  if (url.startsWith('https://web.whatsapp.com/')) return 'whatsapp'
  return 'upload'
}

async function storedLanguage() {
  const stored = await chrome.storage.local.get('language').catch(() => null)
  return stored?.language ?? 'id'
}

function pickTabStream() {
  return new Promise((resolvePick, rejectPick) => {
    chrome.desktopCapture.chooseDesktopMedia(['tab', 'audio'], (streamId, options) => {
      if (chrome.runtime.lastError || !streamId) {
        rejectPick(new Error('Pemilihan tab dibatalkan. Tekan Mulai Rekapin lagi, pilih tab rapatnya, lalu klik Bagikan.'))
        return
      }
      if (options && options.canRequestAudioTrack === false) {
        rejectPick(new Error('Audio tab tidak ikut dibagikan. Ulangi lalu nyalakan opsi bagikan audio tab di dialog Chrome.'))
        return
      }
      resolvePick(streamId)
    })
  })
}

async function resolveStream(tabId, mode) {
  if (mode === 'invoke') {
    return { streamId: await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }), mediaSource: 'tab' }
  }
  return { streamId: await pickTabStream(), mediaSource: 'desktop' }
}

async function restoreState() {
  try {
    const stored = await chrome.storage.local.get('liveState')
    const saved = stored?.liveState
    if (!saved) return
    Object.assign(state, saved)
    if (!ACTIVE_STATUSES.includes(saved.status)) return
    const alive = await chrome.offscreen.hasDocument().catch(() => false)
    if (alive) return
    state.status = 'interrupted'
    state.paused = false
    state.pausedAt = null
    state.live = null
    state.upload = null
    state.error = 'Sesi sebelumnya terputus sebelum rekaman sempat terkirim. Transkrip langsung di bawah masih tersimpan.'
  } catch {
    return
  }
}

const ready = restoreState()

function broadcast() {
  const snapshot = { ...state }
  chrome.runtime.sendMessage({ target: 'panel', type: 'state', state: snapshot }).catch(() => {})
  chrome.storage.local.set({ liveState: snapshot }).catch(() => {})
}

function reset() {
  state.status = 'idle'
  state.lines = []
  state.partial = ''
  state.jobId = null
  state.error = null
  state.tabId = null
  state.startedAt = null
  state.paused = false
  state.pausedAt = null
  state.pausedTotalMs = 0
  state.micOn = true
  state.source = null
  state.live = null
  state.upload = null
  state.captionsOn = null
  state.utteranceStart = null
}

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument()
  if (existing) return
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Merekam audio tab rapat untuk transkrip langsung.',
  })
}

async function closeOffscreen() {
  const existing = await chrome.offscreen.hasDocument()
  if (existing) await chrome.offscreen.closeDocument()
}

async function startRecording(tabId, language, source, mode, skipInsights) {
  if (state.status === 'uploadFailed') {
    return { ok: false, error: 'Rekaman sebelumnya belum terkirim. Kirim ulang atau buang dulu.' }
  }
  if (state.status === 'recording' || state.status === 'starting') {
    return { ok: false, error: 'Transkrip langsung sudah berjalan' }
  }

  let apiBase
  let picked
  try {
    apiBase = (await readConfig()).apiBase
    await ensureOffscreen()
    picked = await resolveStream(tabId, mode)
  } catch (err) {
    await closeOffscreen().catch(() => {})
    state.error = err instanceof Error ? err.message : String(err)
    broadcast()
    return { ok: false, error: state.error }
  }

  reset()
  state.status = 'starting'
  state.tabId = tabId
  state.source = source ?? 'upload'
  broadcast()

  try {
    const response = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'startCapture',
      streamId: picked.streamId,
      mediaSource: picked.mediaSource,
      language,
      apiBase,
      source: state.source,
      skipInsights: Boolean(skipInsights),
    })

    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : 'Gagal memulai transkrip')
    }

    state.status = 'recording'
    state.startedAt = Date.now()
    broadcast()
    return { ok: true }
  } catch (err) {
    state.status = 'error'
    state.error = err instanceof Error ? err.message : String(err)
    await closeOffscreen().catch(() => {})
    broadcast()
    return { ok: false, error: state.error }
  }
}

async function cancelRecording() {
  if (state.status !== 'recording' && state.status !== 'starting') {
    return { ok: false, error: 'Tidak ada sesi aktif' }
  }
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'cancelCapture' }).catch(() => null)
  const background = state.background
  reset()
  state.background = background
  broadcast()
  chrome.storage.local.remove('liveState').catch(() => {})
  return { ok: true }
}

async function startFromInvocation(tab) {
  if (!tab?.id) return
  if (state.status === 'recording') {
    await stopRecording()
    return
  }
  const language = await storedLanguage()
  const stored = await chrome.storage.local.get('autoInsights').catch(() => null)
  const skipInsights = stored?.autoInsights === false
  await startRecording(tab.id, language, sourceFor(tab.url), 'invoke', skipInsights)
}

async function setPaused(paused) {
  if (state.status !== 'recording') return { ok: false, error: 'Tidak ada sesi aktif' }
  if (state.paused === paused) return { ok: true, paused }

  const response = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'setPaused', paused })
  if (!response || !response.ok) {
    return { ok: false, error: response && response.error ? response.error : 'Gagal mengubah jeda' }
  }

  state.paused = paused
  if (paused) {
    state.pausedAt = Date.now()
  } else if (state.pausedAt) {
    state.pausedTotalMs += Date.now() - state.pausedAt
    state.pausedAt = null
  }
  broadcast()
  return { ok: true, paused }
}

async function stopRecording() {
  if (state.status !== 'recording') {
    return { ok: false, error: 'Tidak ada sesi aktif' }
  }

  state.status = 'uploading'
  state.live = null
  state.upload = null
  broadcast()

  try {
    const response = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stopCapture' })
    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : 'Gagal menyimpan rekaman')
    }
    return { ok: true }
  } catch (err) {
    state.status = 'error'
    state.error = err instanceof Error ? err.message : String(err)
    await closeOffscreen().catch(() => {})
    broadcast()
    return { ok: false, error: state.error }
  }
}

async function retryUpload() {
  if (state.status !== 'uploadFailed') return { ok: false, error: 'Tidak ada rekaman yang menunggu dikirim' }
  const response = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'retryUpload' }).catch(() => null)
  if (!response || !response.ok) {
    state.status = 'interrupted'
    state.error = 'Rekaman tidak lagi tersedia untuk dikirim ulang. Transkrip langsung di bawah masih tersimpan.'
    broadcast()
    return { ok: false, error: state.error }
  }
  state.status = 'uploading'
  state.error = null
  broadcast()
  return { ok: true }
}

async function discardUpload() {
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'discardUpload' }).catch(() => null)
  await closeOffscreen().catch(() => {})
  reset()
  state.background = null
  broadcast()
  chrome.storage.local.remove('liveState').catch(() => {})
  return { ok: true }
}

function handleOffscreenEvent(message) {
  if (message.type === 'livePartial') {
    if (!state.partial) state.utteranceStart = Date.now()
    state.partial = message.text
  } else if (message.type === 'liveFinal') {
    clearLiveError()
    const endedAt = Date.now()
    const startedAt = state.utteranceStart ?? endedAt - 4000
    if (message.text) {
      const speaker = resolveSpeaker(message.speakerSource, startedAt, endedAt)
      const last = state.lines[state.lines.length - 1]
      const lastEnd = last ? last.endAt ?? last.at : 0
      if (last && last.speaker === speaker && endedAt - lastEnd <= MERGE_WINDOW_MS) {
        last.text = `${last.text} ${message.text}`.trim()
        last.endAt = endedAt
      } else {
        state.lines.push({ text: message.text, at: startedAt, endAt: endedAt, speaker })
      }
    }
    state.partial = ''
    state.utteranceStart = null
  } else if (message.type === 'liveError') {
    state.error = message.message
    lastLiveError = message.message
  } else if (message.type === 'liveStatus') {
    if (message.status === 'connected') clearLiveError()
    state.live = {
      status: message.status,
      attempt: message.attempt ?? 0,
      max: message.max ?? 0,
      retryAt: message.retryAt ?? null,
    }
  } else if (message.type === 'sourceEnded') {
    if (state.status === 'recording') {
      stopRecording().catch(() => {})
      return
    }
  } else if (message.type === 'micUnavailable') {
    state.micOn = false
    state.error = 'Mikrofon tidak bisa diakses, jadi suara kamu sendiri tidak ikut terekam. Hanya suara peserta lain yang tertangkap.'
  } else if (message.type === 'uploadStatus') {
    const busy = state.status === 'recording' || state.status === 'starting'
    if (message.status === 'uploading') {
      if (busy) {
        state.background = { status: 'uploading', queued: message.queued ?? 1 }
      } else {
        state.status = 'uploading'
        state.upload = null
        state.error = null
      }
    } else if (message.status === 'retrying') {
      const info = {
        attempt: message.attempt,
        max: message.max,
        retryAt: message.retryAt,
        message: message.message,
      }
      if (busy) {
        state.background = { status: 'retrying', ...info }
      } else {
        state.status = 'uploading'
        state.upload = info
      }
    } else if (message.status === 'done') {
      if (busy) {
        state.background = { status: 'done', jobId: message.jobId }
      } else {
        state.status = 'done'
        state.jobId = message.jobId
        state.upload = null
        state.error = null
        state.background = null
        closeOffscreen().catch(() => {})
      }
    } else if (message.status === 'failed') {
      if (busy) {
        state.background = { status: 'failed', message: message.message }
      } else {
        state.status = 'uploadFailed'
        state.upload = null
        state.error = message.message
      }
    }
  } else {
    return
  }
  broadcast()
}

async function handleServiceMessage(message) {
  if (message.type === 'getState') return { ...state }
  if (message.type === 'speaker') {
    noteSpeaker(message.name ?? null)
    return { ok: true }
  }
  if (message.type === 'captions') {
    if (state.captionsOn !== message.on) {
      state.captionsOn = message.on
      broadcast()
    }
    return { ok: true }
  }
  if (message.type === 'cancel') return cancelRecording()
  if (message.type === 'start') {
    return startRecording(message.tabId, message.language, message.source, message.mode, message.skipInsights)
  }
  if (message.type === 'pause') return setPaused(Boolean(message.paused))
  if (message.type === 'stop') return stopRecording()
  if (message.type === 'retryUpload') return retryUpload()
  if (message.type === 'discardUpload') return discardUpload()
  if (message.type === 'reset') {
    reset()
    broadcast()
    chrome.storage.local.remove('liveState').catch(() => {})
    return { ok: true }
  }
  return { ok: false, error: 'Perintah tidak dikenal' }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {})
  ready.then(() => startFromInvocation(tab)).catch(() => {})
})

chrome.commands.onCommand.addListener((command) => {
  if (command !== MENU_ID) return
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab?.id) return
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => {})
    ready.then(() => startFromInvocation(tab)).catch(() => {})
  })
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === 'background') {
    ready.then(() => handleOffscreenEvent(message))
    return undefined
  }

  if (message.target !== 'service') return undefined

  ready.then(() => handleServiceMessage(message)).then(sendResponse)
  return true
})

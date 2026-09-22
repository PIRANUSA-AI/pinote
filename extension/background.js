import { readConfig } from './config.js'

const ACTIVE_STATUSES = ['starting', 'recording', 'uploading', 'uploadFailed']

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
}

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})

chrome.storage.local.remove(['apiBase', 'appBase']).catch(() => {})

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

async function startRecording(tabId, language, source) {
  if (state.status === 'uploadFailed' || state.status === 'uploading') {
    return { ok: false, error: 'Masih ada rekaman yang belum terkirim. Kirim ulang atau buang dulu.' }
  }
  if (state.status === 'recording' || state.status === 'starting') {
    return { ok: false, error: 'Transkrip langsung sudah berjalan' }
  }

  reset()
  state.status = 'starting'
  state.tabId = tabId
  state.source = source ?? 'upload'
  broadcast()

  try {
    const { apiBase } = await readConfig()
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId })
    await ensureOffscreen()

    const response = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'startCapture',
      streamId,
      language,
      apiBase,
      source: state.source,
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
  broadcast()
  chrome.storage.local.remove('liveState').catch(() => {})
  return { ok: true }
}

function handleOffscreenEvent(message) {
  if (message.type === 'livePartial') {
    state.partial = message.text
  } else if (message.type === 'liveFinal') {
    if (message.text) state.lines.push({ text: message.text, at: Date.now(), speaker: message.speaker ?? null })
    state.partial = ''
  } else if (message.type === 'liveError') {
    state.error = message.message
  } else if (message.type === 'liveStatus') {
    state.live = {
      status: message.status,
      attempt: message.attempt ?? 0,
      max: message.max ?? 0,
      retryAt: message.retryAt ?? null,
    }
  } else if (message.type === 'micUnavailable') {
    state.micOn = false
    state.error = 'Mikrofon tidak bisa diakses, jadi suara kamu sendiri tidak ikut terekam. Hanya suara peserta lain yang tertangkap.'
  } else if (message.type === 'uploadStatus') {
    if (message.status === 'uploading') {
      state.status = 'uploading'
      state.upload = null
      state.error = null
    } else if (message.status === 'retrying') {
      state.status = 'uploading'
      state.upload = {
        attempt: message.attempt,
        max: message.max,
        retryAt: message.retryAt,
        message: message.message,
      }
    } else if (message.status === 'done') {
      state.status = 'done'
      state.jobId = message.jobId
      state.upload = null
      state.error = null
      closeOffscreen().catch(() => {})
    } else if (message.status === 'failed') {
      state.status = 'uploadFailed'
      state.upload = null
      state.error = message.message
    }
  } else {
    return
  }
  broadcast()
}

async function handleServiceMessage(message) {
  if (message.type === 'getState') return { ...state }
  if (message.type === 'start') return startRecording(message.tabId, message.language, message.source)
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === 'background') {
    ready.then(() => handleOffscreenEvent(message))
    return undefined
  }

  if (message.target !== 'service') return undefined

  ready.then(() => handleServiceMessage(message)).then(sendResponse)
  return true
})

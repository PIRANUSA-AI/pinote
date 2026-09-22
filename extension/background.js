import { readConfig } from './config.js'

const state = {
  status: 'idle',
  lines: [],
  partial: '',
  jobId: null,
  error: null,
  tabId: null,
  startedAt: null,
}

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})

function broadcast() {
  chrome.runtime.sendMessage({ target: 'panel', type: 'state', state: { ...state } }).catch(() => {})
}

function reset() {
  state.status = 'idle'
  state.lines = []
  state.partial = ''
  state.jobId = null
  state.error = null
  state.tabId = null
  state.startedAt = null
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

async function startRecording(tabId, language) {
  if (state.status === 'recording' || state.status === 'uploading') {
    return { ok: false, error: 'Transkrip langsung sudah berjalan' }
  }

  reset()
  state.status = 'starting'
  state.tabId = tabId
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

async function stopRecording() {
  if (state.status !== 'recording') {
    return { ok: false, error: 'Tidak ada sesi aktif' }
  }

  state.status = 'uploading'
  broadcast()

  try {
    const response = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stopCapture' })
    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : 'Gagal menyimpan rekaman')
    }
    state.jobId = response.jobId
    state.status = 'done'
    return { ok: true, jobId: response.jobId }
  } catch (err) {
    state.status = 'error'
    state.error = err instanceof Error ? err.message : String(err)
    return { ok: false, error: state.error }
  } finally {
    await closeOffscreen().catch(() => {})
    broadcast()
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === 'background') {
    if (message.type === 'livePartial') {
      state.partial = message.text
      broadcast()
    } else if (message.type === 'liveFinal') {
      if (message.text) state.lines.push({ text: message.text, at: Date.now(), speaker: message.speaker ?? null })
      state.partial = ''
      broadcast()
    } else if (message.type === 'liveError') {
      state.error = message.message
      broadcast()
    } else if (message.type === 'uploadStarted') {
      state.status = 'uploading'
      broadcast()
    }
    return undefined
  }

  if (message.target !== 'service') return undefined

  if (message.type === 'getState') {
    sendResponse({ ...state })
    return undefined
  }

  if (message.type === 'start') {
    startRecording(message.tabId, message.language).then(sendResponse)
    return true
  }

  if (message.type === 'stop') {
    stopRecording().then(sendResponse)
    return true
  }

  if (message.type === 'reset') {
    reset()
    broadcast()
    sendResponse({ ok: true })
    return undefined
  }

  return undefined
})

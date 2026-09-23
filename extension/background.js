import { readConfig } from './config.js'
import './languageDetect.js'
import { applyMeetEvent, applyUtterance, claimSelfVoice, nativeTranscript } from './meetTranscript.js'

const ACTIVE_STATUSES = ['starting', 'recording', 'uploading', 'uploadFailed']
const MENU_ID = 'mulaiRekapin'
const SPEAKER_MEMORY_MS = 10 * 60 * 1000
const SPEAKER_TAIL_MS = 1200
const MERGE_WINDOW_MS = 4000
const SELF_VOICE_ERROR_MS = 15000
const SELF_VOICE_RECENT_MS = 15000
const VOICE_MIN_CONFIDENCE = 0.8
const VOICE_SCRIPT_CONFIDENCE = 0.9
const VOICE_MIN_TOKENS = 5
const VOICE_EVIDENCE = 2
const DISMISS_LANGUAGE_MS = 120000
const MEETING_PATTERNS =['https://meet.google.com/*', 'https://*.zoom.us/*', 'https://web.whatsapp.com/*']

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
  watcherOn: false,
  attendance: [],
  utteranceStart: null,
  sessionId: null,
  meetParticipants: {},
  meetStreams: {},
  utteranceMeeting: null,
  nativeSequence: 0,
  nativeError: null,
  language: null,
  meetSelfId: null,
  meetSelfName: null,
  selfSuppressed: [],
  selfVoiceAt: null,
  voiceLanguages: {},
  languageSuggestion: null,
  dismissedLanguages: {},
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
let roster = []

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
  if (roster.length === 1) return roster[0]
  return 'Peserta'
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
    try {
      return { streamId: await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }), mediaSource: 'tab' }
    } catch (error) {
      if (!/not been invoked|activeTab/i.test(String(error))) throw error
      // Opening a persistent side panel doesn't always grant this tab capture.
      // Let Chrome ask for a tab instead of leaving the user at a dead end.
    }
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
  speakerEvents = []
  roster = []
  state.sessionId = null
  state.meetParticipants = {}
  state.meetStreams = {}
  state.utteranceMeeting = null
  state.nativeSequence = 0
  state.meetStats = null
  state.laneStats = null
  state.nativeError = null
  state.watcherOn = false
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
  state.attendance = []
  state.utteranceStart = null
  state.language = null
  state.meetSelfId = null
  state.meetSelfName = null
  state.olderDrops = 0
  state.selfSuppressed = []
  state.selfVoiceAt = null
  state.voiceLanguages = {}
  state.languageSuggestion = null
  state.dismissedLanguages = {}
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
  state.sessionId = crypto.randomUUID()
  state.language = typeof language === 'string' ? language : null
  state.meetSelfName = selfName
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
      tabId,
      skipInsights: Boolean(skipInsights),
    })

    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : 'Gagal memulai transkrip')
    }

    state.status = 'recording'
    state.startedAt = Date.now()
    broadcast()
    if (state.source === 'meet') {
      const native = await chrome.tabs.sendMessage(tabId, { target: 'meetBridge', type: 'start', session: state.sessionId, language: state.language })
        .catch(() => ({ ok: false, error: 'Muat ulang tab Meet setelah memperbarui extension, lalu mulai lagi.' }))
      if (!native?.ok) throw new Error(native?.error || 'Koneksi transkrip native Meet belum siap.')
      state.watcherOn = true
      broadcast()
    } else void ensureWatcher(tabId)
    return { ok: true }
  } catch (err) {
    await chrome.tabs.sendMessage(tabId, { target: 'meetBridge', type: 'stop' }).catch(() => {})
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'cancelCapture' }).catch(() => {})
    state.status = 'error'
    state.error = err instanceof Error ? err.message : String(err)
    await closeOffscreen().catch(() => {})
    broadcast()
    return { ok: false, error: state.error }
  }
}

function buildSpeakerTimeline() {
  if (state.source === 'meet') return []
  if (!state.startedAt || state.pausedTotalMs > 0) return []
  return state.lines
    .filter((line) => line.speaker && line.speaker !== 'Peserta')
    .map((line) => ({
      name: line.speaker,
      start: Math.max(0, (line.at - state.startedAt) / 1000),
      end: Math.max(0, ((line.endAt ?? line.at) - state.startedAt) / 1000),
    }))
    .filter((slot) => slot.end > slot.start)
    .slice(-2000)
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

async function ensureWatcher(tabId) {
  if (!tabId) return
  const alive = await chrome.tabs.sendMessage(tabId, { target: 'content', type: 'ping' }).catch(() => null)
  if (alive?.ok) return
  await chrome.scripting.executeScript({ target: { tabId }, files: ['speakerWatch.js'] }).catch(() => {})
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
    if (state.source === 'meet') for (const line of state.lines) line.frozen = true
  } else if (state.pausedAt) {
    state.pausedTotalMs += Date.now() - state.pausedAt
    state.pausedAt = null
    if (state.source === 'meet') state.sessionId = crypto.randomUUID()
  }
  broadcast()
  if (state.source === 'meet') {
    if (paused) await chrome.tabs.sendMessage(state.tabId, { target: 'meetBridge', type: 'stop' }).catch(() => {})
    else {
      const resumed = await chrome.tabs.sendMessage(state.tabId, { target: 'meetBridge', type: 'start', session: state.sessionId, language: state.language }).catch(() => null)
      if (!resumed?.ok) { state.error = 'Transkrip Meet belum tersambung kembali. Hentikan sesi, lalu muat ulang tab Meet.'; broadcast() }
    }
  }
  return { ok: true, paused }
}

async function stopRecording() {
  if (state.status !== 'recording') {
    return { ok: false, error: 'Tidak ada sesi aktif' }
  }
  if (state.live?.status === 'draining') {
    return { ok: false, error: 'Sedang menyelesaikan kalimat terakhir' }
  }

  if (state.source === 'meet') {
    state.live = { status: 'draining', attempt: 0, max: 0, retryAt: null }
    broadcast()
    await chrome.tabs.sendMessage(state.tabId, { target: 'meetBridge', type: 'stop' }).catch(() => {})
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'drainLanes' }).catch(() => null)
  }

  state.status = 'uploading'
  state.live = null
  state.upload = null
  broadcast()

  try {
    const response = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'stopCapture',
      attendance: state.attendance ?? [],
      speakerTimeline: buildSpeakerTimeline(),
      nativeTranscript: state.source === 'meet' ? nativeTranscript(state) : undefined,
    })
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
  if (message.type === 'laneStats') {
    const errors = finiteOrZero(message.errors)
    const previous = state.laneStats
    state.laneStats = {
      sockets: finiteOrZero(message.sockets),
      finals: finiteOrZero(message.finals),
      errors,
      lastError: typeof message.lastError === 'string' ? message.lastError.slice(0, 120) : '',
      errorAt: previous && errors > previous.errors ? Date.now() : previous?.errorAt ?? null,
    }
  } else if (message.type === 'languageProbe') {
    if (state.source !== 'meet' || state.status !== 'recording' || !probeLanguage(message.text, message.source)) return
  } else if (message.type === 'lanePartial') {
    if (state.source !== 'meet' || typeof message.text !== 'string') return
    state.partial = message.text.slice(0, 2000)
  } else if (message.type === 'laneFinal') {
    if (state.source !== 'meet' || state.status !== 'recording') return
    clearLiveError()
    const local = message.participantId === 'local'
    if (local && typeof message.text === 'string') {
      state.selfVoiceAt = Date.now()
      claimSelfVoice(state, message.text, message.startedAt)
    }
    const selfId = local && typeof state.meetSelfId === 'string' ? state.meetSelfId : null
    if (!applyMeetEvent(state, {
      event: 'laneFinal',
      participantId: selfId ?? message.participantId,
      name: local && !selfId ? selfName : undefined,
      text: message.text,
      startedAt: message.startedAt,
      voice: local,
    })) return
    if (state.error && state.error === state.nativeError) {
      state.error = null
      state.nativeError = null
    }
  } else if (message.type === 'livePartial') {
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

function finiteOrZero(value) {
  return Number.isFinite(value) ? value : 0
}

function applyMeetStats(raw) {
  if (!raw || typeof raw !== 'object') return
  const next = {
    peers: finiteOrZero(raw.peers),
    channels: finiteOrZero(raw.channels),
    mediaSession: raw.mediaSession === true,
    packets: finiteOrZero(raw.packets),
    control: finiteOrZero(raw.control),
    captions: finiteOrZero(raw.captions),
    chats: finiteOrZero(raw.chats),
    rejected: finiteOrZero(raw.rejected),
    reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 40) : '',
    sent: finiteOrZero(raw.sent),
    recoveries: finiteOrZero(raw.recoveries),
    languageSends: finiteOrZero(raw.languageSends),
    languageSwitches: finiteOrZero(raw.languageSwitches),
    autoLanguage: raw.autoLanguage === true,
    languageReason: typeof raw.languageReason === 'string' ? raw.languageReason.slice(0, 20) : '',
    localMic: raw.localMic === true,
    localVoice: raw.localVoice === true,
    localChunks: finiteOrZero(raw.localChunks),
    ackLagMs: finiteOrZero(raw.ackLagMs),
    revisions: finiteOrZero(raw.revisions),
    language: typeof raw.language === 'string' ? raw.language.slice(0, 32) : '',
    meetLanguage: typeof raw.meetLanguage === 'string' ? raw.meetLanguage.slice(0, 32) : '',
    languageState: typeof raw.languageState === 'string' ? raw.languageState.slice(0, 32) : '',
    mediaSessionId: raw.mediaSessionId === true,
    selfDevice: raw.selfDevice === true,
    error: typeof raw.error === 'string' ? raw.error.slice(0, 120) : '',
  }
  state.meetStats = next
  if (state.languageSuggestion?.code === next.language) state.languageSuggestion = null
  broadcast()
}

const LANGUAGE_CODE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/

function offerLanguage(code, source) {
  if (typeof code !== 'string' || !LANGUAGE_CODE.test(code)) return false
  if (state.source !== 'meet' || state.status !== 'recording' || !state.meetStats?.autoLanguage) return false
  if (code === state.meetStats.language || state.languageSuggestion?.code === code) return false
  const dismissedAt = state.dismissedLanguages?.[code]
  if (dismissedAt && Date.now() - dismissedAt < DISMISS_LANGUAGE_MS) return false
  state.languageSuggestion = { code, source, at: Date.now() }
  return true
}

function probeLanguage(text, source) {
  const detect = globalThis.RekapinLanguage?.detect
  if (typeof detect !== 'function' || typeof text !== 'string') return false
  const origin = source === 'participants' ? 'participants' : 'voice'
  const result = detect(text)
  if (!result?.code) return false
  const strong = result.script && result.confidence >= VOICE_SCRIPT_CONFIDENCE
  if (!strong && (result.confidence < VOICE_MIN_CONFIDENCE || result.tokens < VOICE_MIN_TOKENS)) return false
  const evidence = state.voiceLanguages ?? {}
  const recent = [...(evidence[origin] ?? []), result.code].slice(-VOICE_EVIDENCE)
  state.voiceLanguages = { ...evidence, [origin]: recent }
  if (recent.length < VOICE_EVIDENCE || recent.some((code) => code !== result.code)) return false
  return offerLanguage(result.code, origin)
}

function selfVoiceHealthy(now = Date.now()) {
  const errorAt = state.laneStats?.errorAt
  if (errorAt && now - errorAt < SELF_VOICE_ERROR_MS) return false
  return Boolean(state.meetStats?.localMic) || Boolean(state.selfVoiceAt && now - state.selfVoiceAt < SELF_VOICE_RECENT_MS)
}

function deepgramCoversSelf(utterance) {
  if (!utterance || utterance.kind === 'chat') return false
  const participantId = typeof utterance.participantId === 'string' ? utterance.participantId : utterance.deviceId
  if (state.selfSuppressed?.includes(`${participantId}|${utterance.eventId}`)) return true
  const selfId = state.meetSelfId
  if (!selfId || participantId !== selfId) return false
  return selfVoiceHealthy()
}

async function handleServiceMessage(message, sender) {
  if (message.type === 'meetNative') {
    if (sender?.tab?.id !== state.tabId || sender.frameId !== 0 || state.source !== 'meet' || state.status !== 'recording' || state.paused || message.session !== state.sessionId) return { ok: false }
    if (message.event === 'error') {
      state.error = typeof message.message === 'string' ? message.message.slice(0, 300) : 'Data Meet belum tersedia.'
      state.nativeError = state.error
      broadcast()
    } else if (message.event === 'stats') {
      applyMeetStats(message.stats)
    } else if (message.event === 'utterances') {
      if (!Array.isArray(message.utterances)) return { ok: false }
      let changed = false
      for (const utterance of message.utterances.slice(0, 200)) {
        if (deepgramCoversSelf(utterance)) continue
        if (applyUtterance(state, utterance)) changed = true
      }
      if (changed) {
        if (state.error && state.error === state.nativeError) {
          state.error = null
          state.nativeError = null
        }
        broadcast()
      }
    } else if (message.event === 'languageSuggestion') {
      if (offerLanguage(message.code, message.reason === 'memory' ? 'memory' : 'captions')) broadcast()
    } else if (['roster', 'devices'].includes(message.event) && applyMeetEvent(state, message)) {
      broadcast()
    }
    return { ok: true }
  }
  if (message.type === 'switchLanguage' || message.type === 'dismissLanguage') {
    if (sender?.tab || typeof message.code !== 'string' || !LANGUAGE_CODE.test(message.code)) return { ok: false }
    if (state.source !== 'meet' || state.status !== 'recording') return { ok: false }
    if (state.languageSuggestion?.code === message.code) state.languageSuggestion = null
    if (message.type === 'dismissLanguage') {
      state.dismissedLanguages = { ...(state.dismissedLanguages ?? {}), [message.code]: Date.now() }
      broadcast()
      return { ok: true }
    }
    const reply = await chrome.tabs.sendMessage(state.tabId, { target: 'meetBridge', type: 'switchLanguage', code: message.code }).catch(() => null)
    broadcast()
    return { ok: Boolean(reply?.ok) }
  }
  if (['speaker', 'roster', 'watcher', 'captions'].includes(message.type)
    && (sender?.tab?.id !== state.tabId || state.source === 'meet' || state.status !== 'recording' || state.paused)) return { ok: false }
  if (message.type === 'getState') return { ...state }
  if (message.type === 'speaker') {
    noteSpeaker(message.name ?? null)
    return { ok: true }
  }
  if (message.type === 'roster') {
    const names = Array.isArray(message.names) ? message.names.filter((n) => typeof n === 'string').slice(0, 50) : []
    roster = names
    const attendance = message.self ? [message.self, ...names] : names
    if (JSON.stringify(state.attendance) !== JSON.stringify(attendance)) {
      state.attendance = attendance
      broadcast()
    }
    return { ok: true }
  }
  if (message.type === 'watcher') {
    if (state.watcherOn !== message.on) {
      state.watcherOn = message.on
      broadcast()
    }
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

  ready.then(() => handleServiceMessage(message, sender)).then(sendResponse)
  return true
})

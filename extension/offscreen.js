const MAX_RETRIES = 15
const RETRY_STEP_MS = 5000
const CREATE_TIMEOUT_MS = 15000
const UPLOAD_TIMEOUT_MS = 20 * 60 * 1000
const ENERGY_POLL_MS = 100
const SPEECH_FLOOR = 0.012
const SELF_DOMINANCE = 1.4
const SILENCE_FLUSH_MS = 700
const LANE_SAMPLE_RATE = 24000
const MAX_LANE_SOCKETS = 8
const LANE_QUEUE_LIMIT = 300
const LANE_RETIRE_MS = 2500
const TAB_PROBE_LANE = 9002
const TAB_PROBE_MS = 4000
const TAB_PROBE_TAIL_MS = 1200
const TAB_PROBE_GAP_MS = 15000
const TAB_QUIET_MS = 700
const PARTICIPANTS_OWNER = 'participants'
const DRAIN_WAIT_MS = 2500

let capture = null
let uploadQueue = []
let uploadRunning = false

function report(payload) {
  chrome.runtime.sendMessage({ target: 'background', ...payload }).catch(() => {})
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createMeter(context, stream) {
  const analyser = context.createAnalyser()
  analyser.fftSize = 512
  context.createMediaStreamSource(stream).connect(analyser)
  return { analyser, data: new Uint8Array(analyser.fftSize) }
}

function meterLevel(meter) {
  meter.analyser.getByteTimeDomainData(meter.data)
  let sum = 0
  for (let i = 0; i < meter.data.length; i++) {
    const value = (meter.data[i] - 128) / 128
    sum += value * value
  }
  return Math.sqrt(sum / meter.data.length)
}

function takeSpeakerSource() {
  const current = capture
  if (!current) return null
  const { mic, tab } = current.energy
  current.energy = { mic: 0, tab: 0 }
  if (mic <= 0 && tab <= 0) return null
  if (!current.micMeter) return 'remote'
  return mic > tab * SELF_DOMINANCE ? 'self' : 'remote'
}

function retryDelay(retry) {
  return RETRY_STEP_MS * retry
}

function pickRecorderMime() {
  const candidates = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate
  }
  return ''
}

function uploadDescriptor(recorderMime) {
  if (recorderMime.startsWith('audio/mp4')) return { mimeType: 'audio/mp4', extension: 'm4a' }
  return { mimeType: 'audio/webm', extension: 'webm' }
}

function websocketUrl(apiBase) {
  const url = new URL(`${apiBase}/live`)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

function apiUrl(apiBase, path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    throw permanentError('Alamat upload dari server tidak sah')
  }
  const base = new URL(apiBase)
  const target = new URL(`${apiBase}${path}`)
  if (target.origin !== base.origin || !target.pathname.startsWith(`${base.pathname}/`)) {
    throw permanentError('Alamat upload dari server tidak sah')
  }
  return target.toString()
}

function permanentError(message) {
  const err = new Error(message)
  err.permanent = true
  return err
}

function httpError(message, status) {
  const err = new Error(message)
  err.status = status
  err.permanent = status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429
  return err
}

function connectLive() {
  const current = capture
  if (!current || current.stopping) return

  const socket = new WebSocket(websocketUrl(current.apiBase))
  socket.binaryType = 'arraybuffer'
  current.socket = socket

  socket.addEventListener('open', () => {
    if (current.stopping) return
    current.liveRetry = 0
    socket.send(JSON.stringify({ type: 'start', language: current.language, sampleRate: current.sampleRate }))
    report({ type: 'liveStatus', status: 'connected' })
  })

  socket.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    if (message.type === 'partial') report({ type: 'livePartial', text: message.text })
    else if (message.type === 'final') report({ type: 'liveFinal', text: message.text, speakerSource: takeSpeakerSource() })
    else if (message.type === 'error') report({ type: 'liveError', message: message.message })
    else if (message.type === 'upstreamClosed' && !current.stopping) socket.close()
  })

  socket.addEventListener('close', (event) => {
    if (current.stopping || current.socket !== socket) return
    if (event.code === 1008) {
      report({ type: 'liveStatus', status: 'lost' })
      return
    }
    scheduleLiveReconnect(current)
  })
}

function base64ToBuffer(value) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

function parseTag(tag) {
  if (typeof tag !== 'string' || !tag) return { participantId: null, startedAt: null }
  const cut = tag.lastIndexOf('|')
  if (cut <= 0) return { participantId: tag, startedAt: null }
  const startedAt = Number(tag.slice(cut + 1))
  return { participantId: tag.slice(0, cut), startedAt: Number.isFinite(startedAt) ? startedAt : null }
}

function reportLaneStats(current) {
  report({
    type: 'laneStats',
    sockets: current.lanes.size,
    finals: current.laneFinals,
    errors: current.laneErrors,
    lastError: current.laneLastError,
  })
}

function laneSend(entry, payload) {
  if (entry.socket.readyState === WebSocket.OPEN) entry.socket.send(payload)
  else if (entry.queue.length < LANE_QUEUE_LIMIT) entry.queue.push(payload)
}

function laneLanguage(code) {
  const primary = String(code ?? '').split('-')[0].toLowerCase()
  return primary === 'id' || primary === 'en' ? primary : code
}

function laneEntry(current, lane, language, engine) {
  const existing = current.lanes.get(lane)
  const wanted = language ?? current.language
  if (existing && existing.socket.readyState <= WebSocket.OPEN) {
    if (existing.language === wanted && existing.engine === engine) return existing
    laneSend(existing, JSON.stringify({ type: 'flush' }))
    const retiring = existing.socket
    setTimeout(() => {
      try { retiring.close() } catch {}
    }, LANE_RETIRE_MS)
    current.lanes.delete(lane)
  }
  if (!current.lanes.has(lane) && current.lanes.size >= MAX_LANE_SOCKETS) return null

  const socket = new WebSocket(websocketUrl(current.apiBase))
  socket.binaryType = 'arraybuffer'
  const entry = { socket, queue: [], tag: null, language: wanted, engine }
  current.lanes.set(lane, entry)

  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'start', language: laneLanguage(wanted), sampleRate: LANE_SAMPLE_RATE, engine }))
    for (const item of entry.queue) socket.send(item)
    entry.queue = []
    reportLaneStats(current)
  })

  socket.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    const { participantId, startedAt } = parseTag(message.tag)
    const probe = entry.engine === 'qwen'
    if (message.type === 'partial') {
      if (!probe) report({ type: 'lanePartial', lane, participantId, text: message.text })
    } else if (message.type === 'final') {
      if (probe) {
        report({ type: 'languageProbe', source: participantId === PARTICIPANTS_OWNER ? 'participants' : 'voice', text: message.text })
        return
      }
      current.laneFinals++
      report({ type: 'laneFinal', lane, participantId: participantId ?? `lane:${lane}`, startedAt, text: message.text })
      reportLaneStats(current)
    } else if (message.type === 'error') {
      if (probe) return
      current.laneErrors++
      current.laneLastError = String(message.message ?? '').slice(0, 120)
      report({ type: 'liveError', message: message.message })
      reportLaneStats(current)
    }
  })

  socket.addEventListener('close', (event) => {
    if (current.lanes.get(lane) === entry) current.lanes.delete(lane)
    if (event.code !== 1000 && event.code !== 1005 && !current.stopping && entry.engine !== 'qwen') {
      current.laneErrors++
      current.laneLastError = `soket jalur tertutup (${event.code})`
    }
    reportLaneStats(current)
  })

  return entry
}

function handleLaneMessage(message, port) {
  const current = capture
  if (!current || current.stopping || current.source !== 'meet') return
  if (port.sender?.tab?.id !== current.tabId || port.sender?.frameId !== 0) return
  if (!Number.isSafeInteger(message?.lane)) return

  if (message.type === 'laneFlush') {
    const entry = current.lanes.get(message.lane)
    if (entry) laneSend(entry, JSON.stringify({ type: 'flush' }))
    return
  }

  if (message.type !== 'lane' || current.paused || typeof message.pcm !== 'string') return
  const language = typeof message.language === 'string' ? message.language : undefined
  const engine = message.engine === 'qwen' ? 'qwen' : undefined
  const entry = laneEntry(current, message.lane, language, engine)
  if (!entry) return

  const owner = typeof message.owner === 'string' && message.owner ? message.owner : `lane:${message.lane}`
  const tag = `${owner}|${Number.isFinite(message.startedAt) ? message.startedAt : Date.now()}`
  if (entry.tag !== tag) {
    entry.tag = tag
    laneSend(entry, JSON.stringify({ type: 'owner', tag }))
  }

  let pcm
  try {
    pcm = base64ToBuffer(message.pcm)
  } catch {
    return
  }
  laneSend(entry, pcm)
}

async function drainLanes() {
  const current = capture
  if (!current) return { ok: true }
  for (const entry of current.lanes.values()) laneSend(entry, JSON.stringify({ type: 'flush' }))
  if (current.socket && current.socket.readyState === WebSocket.OPEN) {
    current.socket.send(JSON.stringify({ type: 'flush' }))
  }
  await sleep(DRAIN_WAIT_MS)
  return { ok: true }
}

function frameLevel(frame) {
  let sum = 0
  for (let i = 0; i < frame.length; i++) {
    const value = frame[i] / 32768
    sum += value * value
  }
  return frame.length ? Math.sqrt(sum / frame.length) : 0
}

function sampleParticipants(current, buffer) {
  if (current.language !== 'auto') return
  const probe = current.tabProbe
  const now = Date.now()
  const loud = frameLevel(new Int16Array(buffer)) >= SPEECH_FLOOR
  if (!probe.startedAt) {
    const quietBefore = now - probe.loudAt >= TAB_QUIET_MS
    if (loud) probe.loudAt = now
    if (!loud || !quietBefore || now - probe.lastAt < TAB_PROBE_GAP_MS) return
    probe.startedAt = now
    probe.lastAt = now
    const entry = laneEntry(current, TAB_PROBE_LANE, 'auto', 'qwen')
    if (!entry) {
      probe.startedAt = 0
      return
    }
    laneSend(entry, JSON.stringify({ type: 'owner', tag: `${PARTICIPANTS_OWNER}|${now}` }))
  } else if (loud) probe.loudAt = now
  const entry = current.lanes.get(TAB_PROBE_LANE)
  if (!entry) {
    probe.startedAt = 0
    return
  }
  const elapsed = now - probe.startedAt
  if (elapsed < TAB_PROBE_MS) laneSend(entry, buffer)
  else if (elapsed < TAB_PROBE_MS + TAB_PROBE_TAIL_MS) laneSend(entry, new Int16Array(buffer.byteLength / 2).buffer)
  else probe.startedAt = 0
}

function closeLanes(current) {
  for (const entry of current.lanes.values()) {
    try {
      entry.socket.close()
    } catch {}
  }
  current.lanes.clear()
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'rekapinMeetAudio') return
  port.onMessage.addListener((message) => handleLaneMessage(message, port))
})

function scheduleLiveReconnect(current) {
  if (current.liveRetry >= MAX_RETRIES) {
    report({ type: 'liveStatus', status: 'lost' })
    return
  }
  current.liveRetry += 1
  const delay = retryDelay(current.liveRetry)
  report({
    type: 'liveStatus',
    status: 'reconnecting',
    attempt: current.liveRetry,
    max: MAX_RETRIES,
    retryAt: Date.now() + delay,
  })
  current.liveTimer = setTimeout(() => connectLive(), delay)
}

async function captureTab(streamId, mediaSource) {
  const audio = { mandatory: { chromeMediaSource: mediaSource, chromeMediaSourceId: streamId } }
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio, video: false })
  } catch (err) {
    if (mediaSource !== 'desktop') throw err
    stream = await navigator.mediaDevices.getUserMedia({
      audio,
      video: { mandatory: { chromeMediaSource: mediaSource, chromeMediaSourceId: streamId } },
    })
    stream.getVideoTracks().forEach((track) => {
      stream.removeTrack(track)
      track.stop()
    })
  }
  if (stream.getAudioTracks().length === 0) {
    stream.getTracks().forEach((track) => track.stop())
    throw new Error('Audio tab tidak ikut dibagikan. Ulangi lalu nyalakan opsi bagikan audio tab di dialog Chrome.')
  }
  return stream
}

async function start({ streamId, mediaSource, language, apiBase, source, tabId, skipInsights }) {
  if (capture) throw new Error('Perekaman sudah berjalan')

  const stream = await captureTab(streamId, mediaSource ?? 'tab')
  stream.getAudioTracks().forEach((track) => {
    track.addEventListener('ended', () => {
      if (capture && capture.stream === stream && !capture.stopping) report({ type: 'sourceEnded' })
    })
  })

  let micStream = null
  if (source !== 'meet') {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch (err) {
      report({ type: 'micUnavailable', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const playbackContext = new AudioContext()
  playbackContext.createMediaStreamSource(stream).connect(playbackContext.destination)

  const mixDestination = playbackContext.createMediaStreamDestination()
  playbackContext.createMediaStreamSource(stream).connect(mixDestination)
  if (micStream) playbackContext.createMediaStreamSource(micStream).connect(mixDestination)

  const asrContext = new AudioContext({ sampleRate: 24000 })
  await asrContext.audioWorklet.addModule(chrome.runtime.getURL('pcmWorklet.js'))
  const pcmNode = new AudioWorkletNode(asrContext, 'pcmProcessor')
  const mixer = asrContext.createGain()
  if (source !== 'meet' || language === 'auto') asrContext.createMediaStreamSource(stream).connect(mixer)
  if (micStream) asrContext.createMediaStreamSource(micStream).connect(mixer)
  const mute = asrContext.createGain()
  mute.gain.value = 0
  mixer.connect(pcmNode)
  pcmNode.connect(mute)
  mute.connect(asrContext.destination)

  const recorderMime = pickRecorderMime()
  const recorder = new MediaRecorder(mixDestination.stream, recorderMime ? { mimeType: recorderMime } : undefined)
  const chunks = []
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data)
  }
  recorder.onerror = (event) => {
    const reason = event?.error?.message ?? event?.error?.name ?? 'penyebab tidak diketahui'
    report({ type: 'liveError', message: `Perekam audio berhenti sendiri: ${reason}. Hentikan lalu mulai lagi.` })
  }
  recorder.start(1000)

  capture = {
    stream,
    micStream,
    playbackContext,
    asrContext,
    socket: null,
    recorder,
    chunks,
    recorderMime: recorderMime || 'audio/webm',
    sampleRate: asrContext.sampleRate,
    startedAt: Date.now(),
    language,
    apiBase,
    source: source ?? 'upload',
    tabId: Number.isSafeInteger(tabId) ? tabId : null,
    lanes: new Map(),
    tabProbe: { startedAt: 0, lastAt: 0, loudAt: 0 },
    laneFinals: 0,
    laneErrors: 0,
    laneLastError: '',
    skipInsights: Boolean(skipInsights),
    paused: false,
    pausedAt: null,
    pausedTotalMs: 0,
    stopping: false,
    liveRetry: 0,
    liveTimer: null,
    micMeter: micStream ? createMeter(playbackContext, micStream) : null,
    tabMeter: createMeter(playbackContext, stream),
    energy: { mic: 0, tab: 0 },
    energyTimer: null,
    lastVoiceAt: 0,
    awaitingFlush: false,
  }

  capture.energyTimer = setInterval(() => {
    const current = capture
    if (!current || current.paused || current.stopping) return
    const mic = current.micMeter ? meterLevel(current.micMeter) : 0
    const tab = current.tabMeter && current.source !== 'meet' ? meterLevel(current.tabMeter) : 0

    if (mic < SPEECH_FLOOR && tab < SPEECH_FLOOR) {
      if (!current.awaitingFlush) return
      if (Date.now() - current.lastVoiceAt < SILENCE_FLUSH_MS) return
      current.awaitingFlush = false
      if (current.socket && current.socket.readyState === WebSocket.OPEN) {
        current.socket.send(JSON.stringify({ type: 'flush' }))
      }
      return
    }

    current.lastVoiceAt = Date.now()
    current.awaitingFlush = true
    current.energy.mic += mic
    current.energy.tab += tab
  }, ENERGY_POLL_MS)

  pcmNode.port.onmessage = (event) => {
    const current = capture
    if (!current || current.paused || current.stopping) return
    if (current.socket && current.socket.readyState === WebSocket.OPEN) current.socket.send(event.data)
    else if (current.source === 'meet') sampleParticipants(current, event.data)
  }

  if (capture.source !== 'meet') connectLive()
  report({ type: 'captureStarted' })
}

function stopRecorder(recorder) {
  return new Promise((resolve) => {
    if (recorder.state === 'inactive') return resolve()
    recorder.onstop = () => resolve()
    recorder.stop()
  })
}

async function withRetries(task) {
  let retry = 0
  while (true) {
    try {
      return await task()
    } catch (err) {
      if (err.permanent || retry >= MAX_RETRIES) throw err
      retry += 1
      const delay = retryDelay(retry)
      report({
        type: 'uploadStatus',
        status: 'retrying',
        attempt: retry,
        max: MAX_RETRIES,
        retryAt: Date.now() + delay,
        message: err.message,
      })
      await sleep(delay)
    }
  }
}

async function createJob(job) {
  let response
  try {
    response = await fetch(`${job.apiBase}/jobs`, {
      method: 'POST',
      credentials: 'include',
      signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: job.filename,
        mimeType: job.mimeType,
        sizeBytes: job.blob.size,
        durationSec: job.durationSec,
        language: job.language,
        source: job.source,
        skipInsights: job.skipInsights,
        attendance: job.attendance,
        speakerTimeline: job.speakerTimeline,
        nativeTranscript: job.nativeTranscript,
      }),
    })
  } catch {
    throw new Error('Koneksi terputus saat menyiapkan pengiriman')
  }

  if (!response.ok) {
    const detail = await response.json().catch(() => ({}))
    throw httpError(detail.error || `Gagal membuat job (${response.status})`, response.status)
  }
  const result = await response.json()
  if (job.nativeTranscript !== undefined && result.transcriptSource !== 'meet-native') {
    throw permanentError('Server Rekapin perlu diperbarui sebelum rekaman ini bisa dikirim. Rekaman tetap tersimpan di sesi ini.')
  }
  return result
}

async function jobAlreadyReceived(job) {
  try {
    const response = await fetch(`${job.apiBase}/jobs/${encodeURIComponent(job.jobId)}`, {
      credentials: 'include',
      signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
    })
    if (!response.ok) return false
    const detail = await response.json()
    return ['queued', 'transcribing', 'completed'].includes(detail.status)
  } catch {
    return false
  }
}

async function putAudio(job) {
  let response
  try {
    response = await fetch(apiUrl(job.apiBase, job.uploadUrl), {
      method: 'PUT',
      credentials: 'include',
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      headers: { 'Content-Type': job.mimeType },
      body: job.blob,
    })
  } catch (err) {
    if (err?.permanent) throw err
    throw new Error('Koneksi terputus saat mengirim rekaman')
  }

  if (response.ok) return
  if (response.status === 409 && (await jobAlreadyReceived(job))) return
  const detail = await response.json().catch(() => ({}))
  throw httpError(detail.error || `Gagal upload rekaman (${response.status})`, response.status)
}

function friendlyFailure(err) {
  if (err?.status === 401) return 'Sesi login berakhir. Masuk lagi di Rekapin, lalu tekan Kirim ulang. Rekaman kamu masih aman.'
  const reason = err instanceof Error ? err.message : String(err)
  return `Rekaman belum terkirim: ${reason}. Rekaman masih aman, tekan Kirim ulang.`
}

async function runUpload() {
  if (uploadRunning) return
  const job = uploadQueue[0]
  if (!job) return
  uploadRunning = true
  report({ type: 'uploadStatus', status: 'uploading', queued: uploadQueue.length })

  let delivered = false
  try {
    if (!job.jobId) {
      const created = await withRetries(() => createJob(job))
      job.jobId = created.jobId
      job.uploadUrl = created.uploadUrl
    }
    await withRetries(() => putAudio(job))
    uploadQueue.shift()
    delivered = true
    report({ type: 'uploadStatus', status: 'done', jobId: job.jobId, queued: uploadQueue.length })
  } catch (err) {
    report({ type: 'uploadStatus', status: 'failed', message: friendlyFailure(err) })
  } finally {
    uploadRunning = false
  }

  if (delivered && uploadQueue.length > 0) void runUpload()
}

async function stop(attendance, speakerTimeline, nativeTranscript) {
  if (!capture) return { ok: false, error: 'Tidak ada perekaman aktif' }
  const current = capture
  current.stopping = true
  clearTimeout(current.liveTimer)
  clearInterval(current.energyTimer)
  closeLanes(current)
  capture = null

  try {
    if (current.socket && current.socket.readyState === WebSocket.OPEN) {
      current.socket.send(JSON.stringify({ type: 'stop' }))
    }
    await stopRecorder(current.recorder)
  } finally {
    current.stream.getTracks().forEach((track) => track.stop())
    current.micStream?.getTracks().forEach((track) => track.stop())
    current.playbackContext.close().catch(() => {})
    current.asrContext.close().catch(() => {})
    setTimeout(() => current.socket?.close(), 500)
  }

  const blob = new Blob(current.chunks, { type: current.recorderMime })
  if (blob.size === 0) {
    return {
      ok: false,
      error: `Rekaman kosong, tidak ada audio yang tertangkap (${current.chunks.length} potongan, perekam ${current.recorder.state}, format ${current.recorderMime}). Pastikan tab yang kamu pilih di dialog Chrome adalah tab rapat dan opsi bagikan audio tab menyala.`,
    }
  }

  const descriptor = uploadDescriptor(current.recorderMime)
  const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)
  const prefix = current.source === 'whatsapp' ? 'panggilan whatsapp' : 'rapat'

  uploadQueue.push({
    blob,
    apiBase: current.apiBase,
    mimeType: descriptor.mimeType,
    filename: `${prefix} ${stamp}.${descriptor.extension}`,
    durationSec: Math.max(1, Math.round((Date.now() - current.startedAt - current.pausedTotalMs - (current.pausedAt ? Date.now() - current.pausedAt : 0)) / 1000)),
    language: current.language,
    source: current.source,
    skipInsights: current.skipInsights,
    attendance: Array.isArray(attendance) ? attendance : [],
    speakerTimeline: Array.isArray(speakerTimeline) ? speakerTimeline : [],
    nativeTranscript: current.source === 'meet' && Array.isArray(nativeTranscript) ? nativeTranscript : undefined,
    jobId: null,
    uploadUrl: null,
  })

  runUpload()
  return { ok: true, accepted: true }
}

async function cancelCapture() {
  if (!capture) return { ok: false, error: 'Tidak ada perekaman aktif' }
  const current = capture
  current.stopping = true
  clearTimeout(current.liveTimer)
  clearInterval(current.energyTimer)
  closeLanes(current)
  capture = null

  try {
    await stopRecorder(current.recorder)
  } finally {
    current.stream.getTracks().forEach((track) => track.stop())
    current.micStream?.getTracks().forEach((track) => track.stop())
    current.playbackContext.close().catch(() => {})
    current.asrContext.close().catch(() => {})
    setTimeout(() => current.socket?.close(), 200)
  }

  return { ok: true }
}

function setPaused(paused) {
  if (!capture) return { ok: false, error: 'Tidak ada sesi aktif' }
  if (capture.paused === paused) return { ok: true, paused }
  if (paused) capture.pausedAt = Date.now()
  else if (capture.pausedAt) { capture.pausedTotalMs += Date.now() - capture.pausedAt; capture.pausedAt = null }
  capture.paused = paused
  if (paused && capture.recorder.state === 'recording') capture.recorder.pause()
  if (!paused && capture.recorder.state === 'paused') capture.recorder.resume()
  return { ok: true, paused }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return undefined

  if (message.type === 'setPaused') {
    sendResponse(setPaused(Boolean(message.paused)))
    return undefined
  }

  if (message.type === 'retryUpload') {
    if (uploadQueue.length === 0) {
      sendResponse({ ok: false, error: 'Tidak ada rekaman yang menunggu dikirim' })
      return undefined
    }
    runUpload()
    sendResponse({ ok: true })
    return undefined
  }

  if (message.type === 'discardUpload') {
    uploadQueue.shift()
    sendResponse({ ok: true })
    if (uploadQueue.length > 0) runUpload()
    return undefined
  }

  if (message.type === 'startCapture') {
    start(message)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }))
    return true
  }

  if (message.type === 'drainLanes') {
    drainLanes()
      .then((result) => sendResponse(result))
      .catch(() => sendResponse({ ok: true }))
    return true
  }

  if (message.type === 'cancelCapture') {
    cancelCapture()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }))
    return true
  }

  if (message.type === 'stopCapture') {
    stop(message.attendance, message.speakerTimeline, message.nativeTranscript)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }))
    return true
  }

  return undefined
})

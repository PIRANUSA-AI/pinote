let capture = null

function report(payload) {
  chrome.runtime.sendMessage({ target: 'background', ...payload }).catch(() => {})
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

async function start({ streamId, language, apiBase }) {
  if (capture) throw new Error('Perekaman sudah berjalan')

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  })

  const playbackContext = new AudioContext()
  const playbackSource = playbackContext.createMediaStreamSource(stream)
  playbackSource.connect(playbackContext.destination)

  const asrContext = new AudioContext({ sampleRate: 16000 })
  await asrContext.audioWorklet.addModule(chrome.runtime.getURL('pcmWorklet.js'))
  const asrSource = asrContext.createMediaStreamSource(stream)
  const pcmNode = new AudioWorkletNode(asrContext, 'pcmProcessor')
  const mute = asrContext.createGain()
  mute.gain.value = 0
  asrSource.connect(pcmNode)
  pcmNode.connect(mute)
  mute.connect(asrContext.destination)

  const socket = new WebSocket(websocketUrl(apiBase))
  socket.binaryType = 'arraybuffer'

  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'start', language }))
  })

  socket.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    if (message.type === 'partial') report({ type: 'livePartial', text: message.text })
    else if (message.type === 'final') report({ type: 'liveFinal', text: message.text })
    else if (message.type === 'error') report({ type: 'liveError', message: message.message })
  })

  socket.addEventListener('error', () => {
    report({ type: 'liveError', message: 'Koneksi transkrip langsung terputus' })
  })

  pcmNode.port.onmessage = (event) => {
    if (capture?.paused) return
    if (socket.readyState === WebSocket.OPEN) socket.send(event.data)
  }

  const recorderMime = pickRecorderMime()
  const recorder = new MediaRecorder(stream, recorderMime ? { mimeType: recorderMime } : undefined)
  const chunks = []
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data)
  }
  recorder.start(1000)

  capture = {
    stream,
    playbackContext,
    asrContext,
    socket,
    recorder,
    chunks,
    recorderMime: recorderMime || 'audio/webm',
    startedAt: Date.now(),
    language,
    apiBase,
    paused: false,
  }

  report({ type: 'captureStarted' })
}

function stopRecorder(recorder) {
  return new Promise((resolve) => {
    if (recorder.state === 'inactive') return resolve()
    recorder.onstop = () => resolve()
    recorder.stop()
  })
}

async function uploadRecording(current, blob) {
  const durationSec = Math.max(1, Math.round((Date.now() - current.startedAt) / 1000))
  const descriptor = uploadDescriptor(current.recorderMime)
  const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)
  const filename = `rapat ${stamp}.${descriptor.extension}`

  const createResponse = await fetch(`${current.apiBase}/jobs`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename,
      mimeType: descriptor.mimeType,
      sizeBytes: blob.size,
      durationSec,
      language: current.language,
    }),
  })

  if (!createResponse.ok) {
    const detail = await createResponse.json().catch(() => ({}))
    throw new Error(detail.error || `Gagal membuat job (${createResponse.status})`)
  }

  const created = await createResponse.json()

  const uploadResponse = await fetch(`${current.apiBase}${created.uploadUrl}`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': descriptor.mimeType },
    body: blob,
  })

  if (!uploadResponse.ok) {
    const detail = await uploadResponse.json().catch(() => ({}))
    throw new Error(detail.error || `Gagal upload rekaman (${uploadResponse.status})`)
  }

  return created.jobId
}

async function stop() {
  if (!capture) return { ok: false, error: 'Tidak ada perekaman aktif' }
  const current = capture
  capture = null

  try {
    if (current.socket.readyState === WebSocket.OPEN) {
      current.socket.send(JSON.stringify({ type: 'stop' }))
    }
    await stopRecorder(current.recorder)
  } finally {
    current.stream.getTracks().forEach((track) => track.stop())
    current.playbackContext.close().catch(() => {})
    current.asrContext.close().catch(() => {})
    setTimeout(() => current.socket.close(), 500)
  }

  const blob = new Blob(current.chunks, { type: current.recorderMime })
  if (blob.size === 0) throw new Error('Rekaman kosong')

  report({ type: 'uploadStarted' })
  const jobId = await uploadRecording(current, blob)
  return { ok: true, jobId }
}

function setPaused(paused) {
  if (!capture) return { ok: false, error: 'Tidak ada sesi aktif' }
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

  if (message.type === 'startCapture') {
    start(message)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }))
    return true
  }

  if (message.type === 'stopCapture') {
    stop()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }))
    return true
  }

  return undefined
})

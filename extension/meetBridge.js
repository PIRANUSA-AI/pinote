(() => {
  const PORT_NAME = 'rekapinMeetAudio'
  const DRAIN_MS = 1500
  const MAX_CHUNK_BYTES = 64000
  const MAX_UTTERANCES = 200
  let session = null
  let port = null
  let draining = null
  let pendingStart = null
  let startTimer = null
  let alive = true

  const control = (type, id = session) => window.postMessage({ bridge: 'rekapin-meet-control-v1', type, session: id }, location.origin)

  function contextAlive() {
    try {
      return Boolean(chrome.runtime?.id)
    } catch {
      return false
    }
  }

  function shutdown() {
    if (!alive) return
    alive = false
    clearTimeout(startTimer)
    startTimer = null
    if (session) control('stop', session)
    if (draining) control('stop', draining.session)
    session = null
    port = null
    draining = null
    pendingStart = null
  }

  function send(payload) {
    if (!alive) return
    if (!contextAlive()) {
      shutdown()
      return
    }
    try {
      chrome.runtime.sendMessage({ target: 'service', type: 'meetNative', session, ...payload }).catch(() => {})
    } catch {
      shutdown()
    }
  }

  function post(target, message) {
    try {
      target.postMessage(message)
      return true
    } catch {
      if (!contextAlive()) shutdown()
      else if (port === target) port = null
      return false
    }
  }

  function utteranceFields(item) {
    if (!item || typeof item !== 'object') return null
    const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : undefined
    return {
      source: text(item.source, 32),
      meetingId: text(item.meetingId, 128),
      eventId: text(item.eventId, 20),
      version: text(item.version, 20),
      deviceId: text(item.deviceId, 512),
      participantId: text(item.participantId, 512),
      speakerName: text(item.speakerName, 120),
      text: text(item.text, 10000),
      language: text(item.language, 32),
      isFinal: item.isFinal === true,
      timestamp: Number.isFinite(item.timestamp) ? item.timestamp : undefined,
    }
  }

  function toBase64(buffer) {
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    return btoa(binary)
  }

  function openPort() {
    try {
      port = chrome.runtime.connect({ name: PORT_NAME })
    } catch {
      port = null
      if (!contextAlive()) shutdown()
      return
    }
    const opened = port
    opened.onDisconnect.addListener(() => {
      if (port === opened) port = null
    })
  }

  function stop() {
    clearTimeout(startTimer)
    startTimer = null
    const ending = session
    if (!ending) return
    control('stop', ending)
    session = null
    draining = { session: ending, port }
    port = null
    setTimeout(() => {
      if (draining?.session !== ending) return
      try { draining.port?.disconnect() } catch {}
      draining = null
    }, DRAIN_MS)
  }

  function forwardAudio(target, data) {
    if (!target || !Number.isSafeInteger(data.lane)) return
    if (data.type === 'laneFlush') {
      post(target, { type: 'laneFlush', lane: data.lane })
      return
    }
    if (Object.prototype.toString.call(data.pcm) !== '[object ArrayBuffer]') return
    if (data.pcm.byteLength === 0 || data.pcm.byteLength > MAX_CHUNK_BYTES) return
    post(target, {
      type: 'lane',
      lane: data.lane,
      owner: typeof data.owner === 'string' ? data.owner.slice(0, 512) : null,
      startedAt: Number.isFinite(data.startedAt) ? data.startedAt : Date.now(),
      pcm: toBase64(data.pcm),
    })
  }

  window.addEventListener('message', (event) => {
    const data = event.data
    if (!alive) return
    if (event.source !== window || event.origin !== location.origin || data?.bridge !== 'rekapin-meet-v1') return
    if (!contextAlive()) {
      if (data.session) control('stop', data.session)
      shutdown()
      return
    }
    const active = Boolean(session) && data.session === session
    const drainingPort = draining && data.session === draining.session ? draining.port : null
    if (!active && !drainingPort) return

    if (data.type === 'lane' || data.type === 'laneFlush') {
      forwardAudio(active ? port : drainingPort, data)
      return
    }
    if (!active) return

    if (data.type === 'ready') {
      const error = !data.processor
        ? 'Chrome ini belum bisa membaca audio per peserta. Perbarui Chrome ke versi terbaru.'
        : !data.peers
          ? 'Muat ulang tab Meet setelah memperbarui extension, lalu masuk rapat dan mulai lagi.'
          : null
      pendingStart?.({ ok: !error, error })
      pendingStart = null
      clearTimeout(startTimer)
      if (error) stop()
      return
    }

    if (['roster', 'devices', 'error', 'stats'].includes(data.type)) {
      send({ event: data.type, users: data.users, devices: data.devices, message: data.message, stats: data.stats })
    } else if (data.type === 'utterances' && Array.isArray(data.utterances)) {
      send({ event: 'utterances', utterances: data.utterances.slice(0, MAX_UTTERANCES).map(utteranceFields).filter(Boolean) })
    }
  })

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.target !== 'meetBridge') return
    if (message.type === 'stop') {
      stop()
      respond({ ok: true })
      return
    }
    if (message.type !== 'start' || typeof message.session !== 'string') return
    stop()
    session = message.session
    openPort()
    pendingStart = respond
    control('start')
    startTimer = setTimeout(() => {
      if (!pendingStart) return
      pendingStart({ ok: false, error: 'Hook Meet belum terpasang. Muat ulang tab Meet setelah memperbarui extension.' })
      pendingStart = null
      stop()
    }, 2000)
    return true
  })

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.liveState || !session) return
    const state = changes.liveState.newValue
    if (!state || state.sessionId !== session || !['starting', 'recording'].includes(state.status) || state.paused) stop()
  })
})()

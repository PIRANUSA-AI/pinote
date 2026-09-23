(() => {
  if (window.__rekapinMeetInstalled) return
  window.__rekapinMeetInstalled = true
  const protocol = globalThis.RekapinMeetProtocol
  const origin = location.origin
  const TARGET_RATE = 24000
  const CHUNK_SAMPLES = 2400
  const SPEECH_FLOOR = 0.003
  const VOICE_LEVEL = 0.02
  const LEVEL_FLOOR = 0.001
  const STATS_MS = 2000
  const SCAN_MS = 250
  const SILENCE_FLUSH_MS = 700
  const UNMAPPED_WARNING = 30
  const MAX_LANES = 10
  const LOCAL_OWNER = 'local'
  const registry = new Map()
  const streamOwner = new Map()
  const peers = new Set()
  const receivers = new Set()
  const lanes = new Map()
  const seen = new WeakSet()
  let session = null
  let peerCount = 0
  let laneCounter = 0
  let pending = 0
  let queue = Promise.resolve()
  let lastError = 0
  let unmapped = 0
  let unmappedWarned = false
  let statsTimer = null
  let scanTimer = null
  let localSendingNow = false
  const stats = { frames: 0, chunks: 0, sent: 0, maxRms: 0, maxLevel: 0, format: '', error: '' }
  const ownersSeen = new Set()

  function resetStats() {
    Object.assign(stats, { frames: 0, chunks: 0, sent: 0, maxRms: 0, maxLevel: 0, format: '', error: '' })
    ownersSeen.clear()
  }

  function emit(type, data = {}, transfer) {
    if (type === 'error') {
      if (Date.now() - lastError < 5000) return
      lastError = Date.now()
    }
    if (session) window.postMessage({ bridge: 'rekapin-meet-v1', session, type, ...data }, origin, transfer)
  }

  function reportStats() {
    let remote = 0
    let local = 0
    for (const lane of lanes.values()) lane.local ? local++ : remote++
    emit('stats', {
      stats: {
        receivers: receivers.size,
        lanes: remote,
        localLanes: local,
        frames: stats.frames,
        chunks: stats.chunks,
        sent: stats.sent,
        maxRms: Math.round(stats.maxRms * 1000) / 1000,
        maxLevel: Math.round(stats.maxLevel * 1000) / 1000,
        owners: ownersSeen.size,
        mapped: streamOwner.size,
        format: stats.format,
        error: stats.error,
        localMic: localSendingNow,
      },
    })
  }

  function applyUsers(users) {
    for (const user of users) registry.set(user.id, user)
    while (registry.size > 2000) registry.delete(registry.keys().next().value)
    emit('roster', { users: [...registry.values()] })
  }

  function applyDevices(devices) {
    let changed = false
    for (const device of devices) {
      if (streamOwner.get(device.streamId) === device.deviceId) continue
      streamOwner.set(device.streamId, device.deviceId)
      changed = true
    }
    while (streamOwner.size > 4000) streamOwner.delete(streamOwner.keys().next().value)
    if (changed) emitDevices()
  }

  function emitDevices() {
    emit('devices', { devices: [...streamOwner].map(([streamId, deviceId]) => ({ streamId, deviceId })) })
  }

  function observe(channel) {
    if (seen.has(channel)) return
    seen.add(channel)
    if (channel.label !== 'collections') return
    channel.addEventListener('message', (event) => {
      if (pending >= 100) return
      pending++
      queue = queue.then(async () => {
        const bytes = await protocol.packet(event.data, true)
        const users = protocol.roster(bytes)
        if (users.length) applyUsers(users)
        const devices = protocol.devices(bytes)
        if (devices.length) applyDevices(devices)
      }).catch(() => {}).finally(() => { pending-- })
    })
  }

  function sampleOwner(lane) {
    if (lane.local) return { owner: LOCAL_OWNER, level: 0 }
    let sources = []
    try { sources = lane.receiver.getContributingSources() } catch {}
    let best = null
    for (const source of sources) {
      const level = source.audioLevel ?? 0
      if (level < LEVEL_FLOOR) continue
      if (!best || level > (best.audioLevel ?? 0)) best = source
    }
    if (!best && sources.length === 1) best = sources[0]
    const level = best?.audioLevel ?? 0
    if (!best) return { owner: lane.owner ?? `lane:${lane.id}`, level }
    const owner = streamOwner.get(String(best.source))
    if (owner) return { owner, level }
    unmapped++
    if (unmapped >= UNMAPPED_WARNING && !unmappedWarned) {
      unmappedWarned = true
      emit('error', { message: 'Sebagian suara peserta Meet belum terpetakan ke akun. Transkripnya tetap dicatat dengan label sementara.' })
    }
    return { owner: `csrc:${best.source}`, level }
  }

  function flushChunk(lane) {
    const rms = Math.sqrt(lane.sum / CHUNK_SAMPLES)
    lane.sum = 0
    lane.filled = 0
    stats.chunks++
    const now = Date.now()
    if (lane.muted) {
      if (lane.speaking) {
        lane.speaking = false
        emit('laneFlush', { lane: lane.id })
      }
      return
    }
    if (rms > stats.maxRms) stats.maxRms = rms
    const { owner, level } = sampleOwner(lane)
    if (level > stats.maxLevel) stats.maxLevel = level
    const voiced = rms >= SPEECH_FLOOR || level >= VOICE_LEVEL
    if (voiced) {
      lane.lastVoiceAt = now
      if (!lane.speaking) {
        lane.speaking = true
        lane.startedAt = now
      }
      if (owner !== lane.owner) {
        lane.owner = owner
        lane.startedAt = now
      }
      ownersSeen.add(owner)
    }
    if (!lane.speaking) return
    const pcm = lane.buffer.slice(0)
    stats.sent++
    emit('lane', { lane: lane.id, owner: lane.owner, startedAt: lane.startedAt, pcm: pcm.buffer }, [pcm.buffer])
    if (!voiced && now - lane.lastVoiceAt >= SILENCE_FLUSH_MS) {
      lane.speaking = false
      emit('laneFlush', { lane: lane.id })
    }
  }

  function readChannel(frame) {
    const count = frame.numberOfFrames
    const out = new Float32Array(count)
    try {
      frame.copyTo(out, { planeIndex: 0, format: 'f32-planar' })
      return out
    } catch {}
    const format = frame.format
    const channels = frame.numberOfChannels || 1
    const interleaved = !String(format).endsWith('-planar')
    const size = interleaved ? count * channels : count
    const stride = interleaved ? channels : 1
    let raw
    let scale
    let offset = 0
    if (format === 'f32' || format === 'f32-planar') { raw = new Float32Array(size); scale = 1 }
    else if (format === 's16' || format === 's16-planar') { raw = new Int16Array(size); scale = 1 / 32768 }
    else if (format === 's32' || format === 's32-planar') { raw = new Int32Array(size); scale = 1 / 2147483648 }
    else if (format === 'u8' || format === 'u8-planar') { raw = new Uint8Array(size); scale = 1 / 128; offset = 128 }
    else throw new Error(`format audio ${format} tidak didukung`)
    frame.copyTo(raw, { planeIndex: 0 })
    for (let i = 0; i < count; i++) out[i] = (raw[i * stride] - offset) * scale
    return out
  }

  function ingest(lane, frame) {
    const count = frame.numberOfFrames
    if (!count || !frame.sampleRate) return
    stats.frames++
    if (!stats.format) stats.format = `${frame.format ?? '?'} ${frame.sampleRate}Hz ${frame.numberOfChannels ?? '?'}ch`
    const data = readChannel(frame)
    const step = frame.sampleRate / TARGET_RATE
    let position = lane.position
    while (position < count) {
      const raw = data[Math.floor(position)]
      const sample = raw < -1 ? -1 : raw > 1 ? 1 : raw
      lane.buffer[lane.filled++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
      lane.sum += sample * sample
      if (lane.filled === CHUNK_SAMPLES) flushChunk(lane)
      position += step
    }
    lane.position = position - count
  }

  async function pump(lane) {
    try {
      while (session && lanes.get(lane.track) === lane) {
        const { value: frame, done } = await lane.reader.read()
        if (done) break
        try { ingest(lane, frame) } finally { frame.close() }
      }
    } catch (err) {
      stats.error = String(err?.message ?? err).slice(0, 120)
    }
    if (lanes.get(lane.track) === lane) lanes.delete(lane.track)
    lane.reader.cancel().catch(() => {})
  }

  function startLane(track, source) {
    if (!session || !track || lanes.has(track) || lanes.size >= MAX_LANES) return
    if (typeof MediaStreamTrackProcessor !== 'function') {
      stats.error = 'MediaStreamTrackProcessor tidak tersedia'
      return
    }
    if (track.readyState !== 'live') return
    let reader
    try {
      reader = new MediaStreamTrackProcessor({ track }).readable.getReader()
    } catch (err) {
      stats.error = String(err?.message ?? err).slice(0, 120)
      return
    }
    const lane = {
      id: ++laneCounter,
      track,
      receiver: source.receiver ?? null,
      local: Boolean(source.local),
      muted: false,
      reader,
      buffer: new Int16Array(CHUNK_SAMPLES),
      filled: 0,
      sum: 0,
      position: 0,
      owner: source.local ? LOCAL_OWNER : null,
      speaking: false,
      startedAt: 0,
      lastVoiceAt: 0,
    }
    lanes.set(track, lane)
    void pump(lane)
  }

  function stopLanes() {
    for (const lane of lanes.values()) lane.reader.cancel().catch(() => {})
    lanes.clear()
  }

  function watchReceiver(receiver) {
    if (!receiver || receivers.has(receiver) || receiver.track?.kind !== 'audio') return
    receivers.add(receiver)
    receiver.track.addEventListener('ended', () => receivers.delete(receiver))
    startLane(receiver.track, { receiver })
  }

  function localSending(sender) {
    const track = sender.track
    if (!track || track.kind !== 'audio' || track.readyState !== 'live' || !track.enabled || track.muted) return false
    try {
      const encodings = sender.getParameters()?.encodings ?? []
      if (encodings.length > 0 && encodings.every((encoding) => encoding.active === false)) return false
    } catch {}
    return true
  }

  function scanLocal() {
    const sending = new Set()
    for (const peer of peers) {
      let senders = []
      try { senders = peer.getSenders() } catch {}
      for (const sender of senders) {
        if (localSending(sender)) sending.add(sender.track)
      }
    }
    localSendingNow = sending.size > 0
    for (const track of sending) startLane(track, { local: true })
    for (const lane of lanes.values()) {
      if (lane.local) lane.muted = !sending.has(lane.track)
    }
  }

  const Original = window.RTCPeerConnection
  if (Original) {
    window.RTCPeerConnection = new Proxy(Original, {
      construct(target, args, newTarget) {
        const peer = Reflect.construct(target, args, newTarget)
        peerCount++
        peers.add(peer)
        peer.addEventListener('connectionstatechange', () => {
          if (peer.connectionState === 'closed') peers.delete(peer)
        })
        peer.addEventListener('datachannel', (event) => observe(event.channel))
        peer.addEventListener('track', (event) => watchReceiver(event.receiver))
        const create = peer.createDataChannel
        peer.createDataChannel = function (...args) {
          const channel = Reflect.apply(create, this, args)
          observe(channel)
          return channel
        }
        return peer
      },
    })
  }

  const originalFetch = window.fetch
  window.fetch = async function (...args) {
    const response = await Reflect.apply(originalFetch, this, args)
    if (response.url.split('?')[0] === `${origin}/$rpc/google.rtc.meetings.v1.MeetingSpaceService/SyncMeetingSpaceCollections`) {
      response.clone().text().then((body) => {
        if (body.length > 3 * 1024 * 1024) return
        const binary = atob(body.trim())
        applyUsers(protocol.roster(Uint8Array.from(binary, (c) => c.charCodeAt(0)), true))
      }).catch(() => {})
    }
    return response
  }

  window.addEventListener('message', (event) => {
    const data = event.data
    if (event.source !== window || event.origin !== origin || data?.bridge !== 'rekapin-meet-control-v1') return
    if (data.type === 'start' && typeof data.session === 'string') {
      stopLanes()
      session = data.session
      unmapped = 0
      unmappedWarned = false
      resetStats()
      clearInterval(statsTimer)
      clearInterval(scanTimer)
      statsTimer = setInterval(reportStats, STATS_MS)
      scanTimer = setInterval(scanLocal, SCAN_MS)
      for (const peer of peers) {
        try { for (const receiver of peer.getReceivers()) watchReceiver(receiver) } catch {}
      }
      for (const receiver of receivers) startLane(receiver.track, { receiver })
      scanLocal()
      emit('ready', { peers: peerCount, lanes: lanes.size, processor: typeof MediaStreamTrackProcessor === 'function' })
      emit('roster', { users: [...registry.values()] })
      emitDevices()
      reportStats()
    } else if (data.type === 'stop' && data.session === session) {
      for (const lane of lanes.values()) if (lane.speaking) emit('laneFlush', { lane: lane.id })
      clearInterval(statsTimer)
      clearInterval(scanTimer)
      statsTimer = null
      scanTimer = null
      session = null
      stopLanes()
    }
  })
})()

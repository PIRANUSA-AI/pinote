(() => {
  if (window.__rekapinMeetInstalled) return
  window.__rekapinMeetInstalled = true
  const protocol = globalThis.RekapinMeetProtocol
  const origin = location.origin
  const TARGET_RATE = 24000
  const CHUNK_SAMPLES = 2400
  const SPEECH_FLOOR = 0.01
  const LEVEL_FLOOR = 0.001
  const SILENCE_FLUSH_MS = 700
  const UNMAPPED_WARNING = 30
  const MAX_LANES = 8
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

  function emit(type, data = {}, transfer) {
    if (type === 'error') {
      if (Date.now() - lastError < 5000) return
      lastError = Date.now()
    }
    if (session) window.postMessage({ bridge: 'rekapin-meet-v1', session, type, ...data }, origin, transfer)
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

  function currentOwner(lane) {
    let sources = []
    try { sources = lane.receiver.getContributingSources() } catch {}
    let best = null
    for (const source of sources) {
      const level = source.audioLevel ?? 0
      if (level < LEVEL_FLOOR) continue
      if (!best || level > (best.audioLevel ?? 0)) best = source
    }
    if (!best && sources.length === 1) best = sources[0]
    if (!best) return lane.owner ?? `lane:${lane.id}`
    const owner = streamOwner.get(String(best.source))
    if (owner) return owner
    unmapped++
    if (unmapped >= UNMAPPED_WARNING && !unmappedWarned) {
      unmappedWarned = true
      emit('error', { message: 'Sebagian suara peserta Meet belum terpetakan ke akun. Transkripnya tetap dicatat dengan label sementara.' })
    }
    return `csrc:${best.source}`
  }

  function flushChunk(lane) {
    const rms = Math.sqrt(lane.sum / CHUNK_SAMPLES)
    lane.sum = 0
    lane.filled = 0
    const now = Date.now()
    if (rms >= SPEECH_FLOOR) {
      lane.lastVoiceAt = now
      if (!lane.speaking) {
        lane.speaking = true
        lane.startedAt = now
      }
      const owner = currentOwner(lane)
      if (owner !== lane.owner) {
        lane.owner = owner
        lane.startedAt = now
      }
    }
    if (!lane.speaking) return
    const pcm = lane.buffer.slice(0)
    emit('lane', { lane: lane.id, owner: lane.owner, startedAt: lane.startedAt, pcm: pcm.buffer }, [pcm.buffer])
    if (rms < SPEECH_FLOOR && now - lane.lastVoiceAt >= SILENCE_FLUSH_MS) {
      lane.speaking = false
      emit('laneFlush', { lane: lane.id })
    }
  }

  function ingest(lane, frame) {
    const count = frame.numberOfFrames
    if (!count || !frame.sampleRate) return
    const data = new Float32Array(count)
    frame.copyTo(data, { planeIndex: 0, format: 'f32-planar' })
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
      while (session && lanes.get(lane.receiver) === lane) {
        const { value: frame, done } = await lane.reader.read()
        if (done) break
        try { ingest(lane, frame) } finally { frame.close() }
      }
    } catch {}
    if (lanes.get(lane.receiver) === lane) lanes.delete(lane.receiver)
    lane.reader.cancel().catch(() => {})
  }

  function startLane(receiver) {
    if (!session || lanes.has(receiver) || lanes.size >= MAX_LANES) return
    if (typeof MediaStreamTrackProcessor !== 'function' || receiver.track?.readyState !== 'live') return
    let reader
    try { reader = new MediaStreamTrackProcessor({ track: receiver.track }).readable.getReader() } catch { return }
    const lane = {
      id: ++laneCounter,
      receiver,
      reader,
      buffer: new Int16Array(CHUNK_SAMPLES),
      filled: 0,
      sum: 0,
      position: 0,
      owner: null,
      speaking: false,
      startedAt: 0,
      lastVoiceAt: 0,
    }
    lanes.set(receiver, lane)
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
    startLane(receiver)
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
      for (const peer of peers) {
        try { for (const receiver of peer.getReceivers()) watchReceiver(receiver) } catch {}
      }
      for (const receiver of receivers) startLane(receiver)
      emit('ready', { peers: peerCount, lanes: lanes.size, processor: typeof MediaStreamTrackProcessor === 'function' })
      emit('roster', { users: [...registry.values()] })
      emitDevices()
    } else if (data.type === 'stop' && data.session === session) {
      for (const lane of lanes.values()) if (lane.speaking) emit('laneFlush', { lane: lane.id })
      session = null
      stopLanes()
    }
  })
})()

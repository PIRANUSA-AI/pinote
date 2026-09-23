(() => {
  if (window.__rekapinMeetInstalled) return
  window.__rekapinMeetInstalled = true
  const protocol = globalThis.RekapinMeetProtocol
  const origin = location.origin
  const STATS_MS = 2000
  const FLUSH_MS = 500
  const REOPEN_MS = 1000
  const PEER_WAIT_MS = 100
  const DUPLICATE_MS = 700
  const ALIAS_MS = 30000
  const RECENT_LIMIT = 512
  const LANGUAGE_GAP_MS = 2000
  const LANGUAGE_ACK_MS = 5000
  const RETRY_MS = 5000
  const RETRY_LIMIT = 5
  const SILENCE_MS = 60000
  const SPEAKING_RECENT_MS = 30000
  const SILENCE_CHECK_MS = 10000
  const RECOVERY_LIMIT = 3
  const SPEECH_LEVEL = 0.02
  const SPEECH_SCAN_MS = 1000
  const CAPTION_LABELS = ['captions', 'captions_v2']
  const CHAT_LABEL = 'meet_messages'
  const MEDIA_LABEL = 'media-session'
  const SETTINGS_PREFIX = 'rt_g3jartmcups-'
  const DESIRED_KEY = 'rekapinCaptionLanguage'
  const SPEAKING_SELECTOR = '.IisKdb.GF8M7d'
  const LANGUAGE_LISTBOX = '[role="listbox"].W7g1Rb-rymPhb.O68mGe-hqgu2c'
  const DEVICE_PATTERN = /spaces\/[A-Za-z0-9_-]+\/devices\/[A-Za-z0-9_-]+/
  const LANGUAGES = { id: 'id-ID', en: 'en-US' }
  const FALLBACK_LANGUAGE = 'id-ID'
  const detector = globalThis.RekapinLanguage
  const AUTO_MIN_TOKENS = 5
  const AUTO_MIN_CHARS = 25
  const AUTO_MIN_CONFIDENCE = 0.6
  const AUTO_EVIDENCE = 2
  const AUTO_REEVALUATE_CHARS = 30
  const LOCAL_OWNER = 'local'
  const PROBE_ENGINE = 'qwen'
  const PROBE_OWNER = 'probe'
  const PROBE_LANE = 9001
  const PROBE_CHUNKS = 40
  const PROBE_SILENCE_CHUNKS = 12
  const PROBE_GAP_MS = 15000
  const SUGGEST_GAP_MS = 20000
  const TARGET_RATE = 24000
  const CHUNK_SAMPLES = 2400
  const SPEECH_FLOOR = 0.003
  const SILENCE_FLUSH_MS = 700
  const LOCAL_SCAN_MS = 250
  const SELF_VOICE_WINDOW_MS = 3000
  const SELF_VOTES = 3
  const SELF_RATIO = 0.75
  const RPC = {
    modify: 'https://meet.google.com/hangouts/v1_meetings/media_sessions/modify',
    queryLanguage: 'https://meet.google.com/hangouts/v1_meetings/media_sessions/query',
    sync: 'https://meet.google.com/$rpc/google.rtc.meetings.v1.MeetingSpaceService/SyncMeetingSpaceCollections',
    message: 'https://meet.google.com/$rpc/google.rtc.meetings.v1.MeetingMessageService/CreateMeetingMessage',
    getMedia: 'https://meet.google.com/$rpc/google.rtc.meetings.v1.MediaSessionService/GetMediaSession',
    updateMedia: 'https://meet.google.com/$rpc/google.rtc.meetings.v1.MediaSessionService/UpdateMediaSession',
    device: 'https://meet.google.com/$rpc/google.rtc.meetings.v1.MeetingDeviceService/CreateMeetingDevice',
  }
  const registry = new Map()
  const streamOwner = new Map()
  const peers = new Set()
  const seen = new WeakSet()
  const listened = new WeakSet()
  const ours = new WeakSet()
  const opened = new Set()
  const latest = new Map()
  const pendingUtterances = new Map()
  const firstSeen = new Map()
  const delivered = new Set()
  const recentText = new Map()
  const aliases = new Map()
  const LOG_LIMIT = 6000
  const captionLog = []
  window.__rekapinCaptionLog = captionLog
  let sessionStart = Date.now()
  let session = null
  let language = ''
  let meetLanguage = ''
  let mediaSessionId = ''
  let selfDevice = ''
  let peerCount = 0
  let channelId = 50000
  let captionPeer = null
  let mediaSession = null
  let lastOp = 0
  let lastSeq = 0
  let lastIncoming = 0
  let ownLanguageSend = false
  let reassertLanguage = false
  let languageWaiter = null
  let pending = 0
  let captionQueue = Promise.resolve()
  let collectionQueue = Promise.resolve()
  let chatQueue = Promise.resolve()
  let mediaQueue = Promise.resolve()
  const sessionUtterances = new Set()
  let statsTimer = null
  let flushTimer = null
  let waitTimer = null
  let silenceTimer = null
  let speechTimer = null
  let creating = false
  let languageAt = 0
  let lastPacketAt = null
  let speakingAt = null
  let recoveries = 0
  let escalated = false
  const auto = {
    enabled: false,
    memory: new Map(),
    results: new Map(),
    evaluatedLength: new Map(),
    suggestedAt: new Map(),
    lastReason: '',
  }
  const local = { lane: null, sending: false, voiceAt: 0, counter: 0, timer: null, probe: { remaining: 0, silence: 0, lastAt: 0, startedAt: 0 } }
  const selfVotes = new Map()
  const freshStats = () => ({
    packets: 0, control: 0, captions: 0, chats: 0, rejected: 0, reason: '', sent: 0, recoveries: 0,
    languageState: '', languageSends: 0, languageSwitches: 0, suggestions: 0, ackLagMs: 0, localChunks: 0, probeChunks: 0, error: '',
  })
  const stats = freshStats()

  function resetStats() {
    Object.assign(stats, freshStats())
    sessionUtterances.clear()
  }

  function noteError(err) {
    stats.error = String(err?.message ?? err).slice(0, 120)
  }

  function emit(type, data = {}, transfer) {
    if (session) window.postMessage({ bridge: 'rekapin-meet-v1', session, type, ...data }, origin, transfer)
  }

  function meetingId() {
    return location.pathname.match(/[a-z]{3,4}-[a-z]{4}-[a-z]{3,4}/i)?.[0] ?? location.pathname.slice(1, 129)
  }

  function openChannels() {
    let count = 0
    for (const channel of opened) if (channel.readyState === 'open' && CAPTION_LABELS.includes(channel.label)) count++
    return count
  }

  function reportStats() {
    emit('stats', {
      stats: {
        peers: peers.size,
        channels: openChannels(),
        mediaSession: mediaSession?.readyState === 'open',
        packets: stats.packets,
        control: stats.control,
        captions: stats.captions,
        chats: stats.chats,
        rejected: stats.rejected,
        reason: stats.reason,
        sent: stats.sent,
        recoveries: stats.recoveries,
        languageSends: stats.languageSends,
        languageSwitches: stats.languageSwitches,
        autoLanguage: auto.enabled,
        languageReason: auto.lastReason,
        localMic: local.sending,
        localVoice: local.sending && Date.now() - local.voiceAt <= SELF_VOICE_WINDOW_MS,
        localChunks: stats.localChunks,
        probeChunks: stats.probeChunks,
        suggestions: stats.suggestions,
        ackLagMs: stats.ackLagMs,
        revisions: sessionUtterances.size ? Math.round((stats.captions / sessionUtterances.size) * 10) / 10 : 0,
        language,
        meetLanguage,
        languageState: stats.languageState,
        mediaSessionId: Boolean(mediaSessionId),
        selfDevice: Boolean(selfDevice),
        error: stats.error,
      },
    })
  }

  function emitRoster() {
    emit('roster', { users: [...registry.values()], selfId: selfDevice || undefined })
  }

  function applyUsers(users) {
    for (const user of users) registry.set(user.id, user)
    while (registry.size > 2000) registry.delete(registry.keys().next().value)
    emitRoster()
  }

  function noteSelf(text) {
    if (selfDevice) return
    const match = text.match(DEVICE_PATTERN)
    if (!match) return
    selfDevice = match[0]
    emitRoster()
  }

  function applyDevices(devices) {
    let changed = false
    for (const device of devices) {
      if (streamOwner.get(device.streamId) === device.deviceId) continue
      streamOwner.set(device.streamId, device.deviceId)
      changed = true
    }
    while (streamOwner.size > 4000) streamOwner.delete(streamOwner.keys().next().value)
    if (changed) emit('devices', { devices: [...streamOwner].map(([streamId, deviceId]) => ({ streamId, deviceId })) })
  }

  function readJson(text) {
    try {
      const value = JSON.parse(text)
      return Array.isArray(value) ? value : null
    } catch { return null }
  }

  const storageGet = Storage.prototype.getItem
  const storageSet = Storage.prototype.setItem
  const guard = {
    desired: null,
    meetDefault: null,
    key: null,
    settingsKey() {
      if (this.key) return this.key
      try {
        const keys = Object.keys(window.localStorage).filter((key) => key.startsWith(SETTINGS_PREFIX))
        return keys.length === 1 ? keys[0] : null
      } catch { return null }
    },
    withLanguage(value, id) {
      const list = value ? [...value] : []
      while (list.length < 3) list.push(null)
      list[2] = id
      return JSON.stringify(list)
    },
    persist() {
      try { storageSet.call(window.localStorage, DESIRED_KEY, JSON.stringify({ code: this.desired?.code ?? null })) } catch {}
    },
    writeThrough() {
      if (!this.desired) return
      const key = this.settingsKey()
      if (!key) return
      this.key = key
      try { storageSet.call(window.localStorage, key, this.withLanguage(readJson(storageGet.call(window.localStorage, key)), this.desired.id)) } catch {}
    },
    advise(code) {
      const id = code ? protocol.languageId(code) : null
      if (code && id === null) return
      if ((this.desired?.code ?? null) === (code || null)) return
      this.desired = code ? { code, id } : null
      this.persist()
      this.writeThrough()
    },
    classify(code) {
      if (!this.desired || code === this.desired.code) return 'pass'
      if (this.meetDefault === null) this.meetDefault = code
      if (code === this.meetDefault) return 'rewrite'
      const id = protocol.languageId(code)
      if (id === null) return 'pass'
      this.desired = { code, id }
      this.persist()
      this.writeThrough()
      return 'adopt'
    },
    install() {
      try {
        const saved = JSON.parse(storageGet.call(window.localStorage, DESIRED_KEY) ?? 'null')
        const id = typeof saved?.code === 'string' ? protocol.languageId(saved.code) : null
        if (id !== null) this.desired = { code: saved.code, id }
      } catch {}
      const self = this
      Storage.prototype.getItem = function (key) {
        const value = Reflect.apply(storageGet, this, arguments)
        try {
          if (this === window.localStorage && typeof key === 'string' && key.startsWith(SETTINGS_PREFIX)) {
            self.key = key
            const list = readJson(value)
            const stored = protocol.languageCode(list?.[2])
            if (self.desired && stored !== self.desired.code) return self.withLanguage(list, self.desired.id)
          }
        } catch {}
        return value
      }
      Storage.prototype.setItem = function (key, value) {
        const result = Reflect.apply(storageSet, this, arguments)
        try {
          if (this === window.localStorage && typeof key === 'string' && key.startsWith(SETTINGS_PREFIX)) {
            self.key = key
            const code = protocol.languageCode(readJson(value)?.[2])
            if (code) {
              const verdict = self.classify(code)
              if (verdict === 'rewrite') self.writeThrough()
              else if (verdict === 'adopt') adoptLanguage(code)
            }
          }
        } catch {}
        return result
      }
    },
  }
  guard.install()
  if (guard.desired) language = guard.desired.code

  function adoptLanguage(code) {
    language = code
    meetLanguage = code
    stats.languageState = 'diganti di Meet'
  }

  function prune(map, now, age) {
    if (map.size <= RECENT_LIMIT) return
    for (const [key, entry] of map) if (now - entry.at > age) map.delete(key)
    if (map.size <= RECENT_LIMIT) return
    const oldest = [...map.entries()].sort((a, b) => a[1].at - b[1].at)
    for (const [key] of oldest.slice(0, map.size - RECENT_LIMIT)) map.delete(key)
  }

  function canonical(caption, now) {
    const alias = aliases.get(caption.messageId)
    if (alias && now - alias.at <= ALIAS_MS) {
      alias.at = now
      return alias.utteranceId
    }
    const key = `${caption.deviceId}|${caption.version}|${caption.text}`
    const hit = recentText.get(key)
    if (hit && now - hit.at <= DUPLICATE_MS) {
      if (hit.messageId === caption.messageId) return caption.utteranceId
      aliases.set(caption.messageId, { utteranceId: hit.utteranceId, at: now })
      prune(aliases, now, ALIAS_MS)
      return hit.utteranceId
    }
    recentText.set(key, { messageId: caption.messageId, utteranceId: caption.utteranceId, at: now })
    prune(recentText, now, DUPLICATE_MS)
    return caption.utteranceId
  }

  function queueEntry(key, entry, stamp) {
    const now = Date.now()
    if (!firstSeen.has(key)) firstSeen.set(key, stamp ?? now)
    while (firstSeen.size > 4000) firstSeen.delete(firstSeen.keys().next().value)
    const prior = pendingUtterances.get(key)
    if (prior && BigInt(prior.version) > BigInt(entry.version)) return false
    pendingUtterances.set(key, {
      source: 'meet',
      meetingId: meetingId(),
      participantId: entry.deviceId,
      isFinal: false,
      ...entry,
      timestamp: delivered.has(key) ? now : firstSeen.get(key),
    })
    return true
  }

  function queueCaption(caption, dedupe, channel) {
    const entry = {
      c: channel?.label === 'captions_v2' ? 'v2' : 'v1',
      own: Boolean(channel && ours.has(channel)),
      id: caption.utteranceId,
      v: caption.version,
      dev: String(caption.deviceId).slice(-8),
      n: caption.text?.length ?? 0,
      tail: String(caption.text ?? '').slice(-40),
    }
    if (!session) return trace({ ...entry, r: 'noSession' })
    if (!caption.text) return trace({ ...entry, r: 'empty' })
    caption.messageId = `${caption.utteranceId}/${caption.deviceId}`
    const utteranceId = dedupe ? canonical(caption, Date.now()) : caption.utteranceId
    const key = `${utteranceId}/${caption.deviceId}`
    const isNew = !firstSeen.has(key)
    sessionUtterances.add(key)
    while (sessionUtterances.size > 4000) sessionUtterances.delete(sessionUtterances.values().next().value)
    if (isNew) voteSelf(caption.deviceId)
    observeLanguage(caption, key, isNew)
    const accepted = queueEntry(key, {
      eventId: utteranceId,
      version: caption.version,
      deviceId: caption.deviceId,
      text: caption.text,
      language: caption.language || meetLanguage || language,
    })
    if (accepted) stats.captions++
    trace({ ...entry, as: utteranceId === caption.utteranceId ? undefined : utteranceId, r: accepted ? 'ok' : 'older' })
  }

  function trace(entry) {
    captionLog.push({ t: Date.now() - sessionStart, ...entry })
    if (captionLog.length > LOG_LIMIT) captionLog.splice(0, captionLog.length - LOG_LIMIT)
  }

  function switchLanguage(code, reason) {
    if (!code || code === language || protocol.languageId(code) === null) return
    language = code
    meetLanguage = code
    auto.lastReason = reason
    stats.languageSwitches++
    guard.advise(code)
    trace({ r: `switch:${reason}`, tail: code })
    sendLanguage(true)
  }

  function suggest(code, reason) {
    if (!code || code === language || protocol.languageId(code) === null) return
    const now = Date.now()
    if (now - (auto.suggestedAt.get(code) ?? 0) < SUGGEST_GAP_MS) return
    auto.suggestedAt.set(code, now)
    stats.suggestions++
    trace({ r: `suggest:${reason}`, tail: code })
    emit('languageSuggestion', { code, reason })
  }

  function rememberResult(device, key, code) {
    const history = auto.results.get(device) ?? []
    const index = history.findIndex((item) => item.key === key)
    if (index >= 0) history[index] = { key, code }
    else history.push({ key, code })
    while (history.length > 4) history.shift()
    auto.results.set(device, history)
    while (auto.results.size > 200) auto.results.delete(auto.results.keys().next().value)
    return history
  }

  function observeLanguage(caption, key, isNew) {
    if (!auto.enabled || !session || !detector) return
    const device = caption.deviceId
    const now = Date.now()
    if (isNew) {
      const known = auto.memory.get(device)
      if (known && known !== language) suggest(known, 'memory')
    }
    const text = caption.text
    if (text.length < AUTO_MIN_CHARS) return
    const measured = auto.evaluatedLength.get(key) ?? 0
    if (measured && text.length - measured < AUTO_REEVALUATE_CHARS) return
    auto.evaluatedLength.set(key, text.length)
    while (auto.evaluatedLength.size > 2000) auto.evaluatedLength.delete(auto.evaluatedLength.keys().next().value)
    const result = detector.detect(text)
    if (!result?.code || result.confidence < AUTO_MIN_CONFIDENCE) return
    if (!result.script && result.tokens < AUTO_MIN_TOKENS) return
    if (protocol.languageId(result.code) === null) return
    const history = rememberResult(device, key, result.code)
    const strongScript = result.script && result.confidence >= 0.9
    const recent = strongScript ? [history[history.length - 1]] : history.slice(-AUTO_EVIDENCE)
    if (!strongScript && recent.length < AUTO_EVIDENCE) return
    if (recent.some((item) => item.code !== recent[0].code)) return
    const code = recent[0].code
    auto.memory.set(device, code)
    while (auto.memory.size > 200) auto.memory.delete(auto.memory.keys().next().value)
    if (code !== language) suggest(code, 'evidence')
  }

  function voteSelf(device) {
    if (selfDevice || !local.lane || typeof device !== 'string') return
    const entry = selfVotes.get(device) ?? { self: 0, other: 0 }
    if (local.sending && Date.now() - local.voiceAt <= SELF_VOICE_WINDOW_MS) entry.self++
    else entry.other++
    selfVotes.set(device, entry)
    if (entry.self >= SELF_VOTES && entry.self / (entry.self + entry.other) >= SELF_RATIO) {
      selfDevice = device
      trace({ r: 'selfDevice', dev: device.slice(-8) })
      emitRoster()
    }
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

  function emitProbe(pcm) {
    stats.probeChunks++
    emit('lane', { lane: PROBE_LANE, owner: PROBE_OWNER, startedAt: local.probe.startedAt, language: 'auto', engine: PROBE_ENGINE, pcm: pcm.buffer }, [pcm.buffer])
  }

  function probeStep(lane, now) {
    const probe = local.probe
    if (!auto.enabled) {
      probe.remaining = 0
      probe.silence = 0
      return
    }
    if (!probe.remaining && !probe.silence) {
      if (!lane.speaking || lane.startedAt !== now || now - probe.lastAt < PROBE_GAP_MS) return
      probe.remaining = PROBE_CHUNKS
      probe.lastAt = now
      probe.startedAt = now
      trace({ r: 'probe' })
    }
    if (probe.remaining) {
      emitProbe(lane.buffer.slice(0))
      probe.remaining--
      if (!probe.remaining) probe.silence = PROBE_SILENCE_CHUNKS
      return
    }
    emitProbe(new Int16Array(CHUNK_SAMPLES))
    probe.silence--
  }

  function flushLocal(lane) {
    const rms = Math.sqrt(lane.sum / CHUNK_SAMPLES)
    lane.sum = 0
    lane.filled = 0
    const now = Date.now()
    if (lane.muted || !session) {
      if (lane.speaking) {
        lane.speaking = false
        emit('laneFlush', { lane: lane.id })
      }
      return
    }
    const voiced = rms >= SPEECH_FLOOR
    if (voiced) {
      lane.lastVoiceAt = now
      local.voiceAt = now
      if (!lane.speaking) {
        lane.speaking = true
        lane.startedAt = now
      }
    }
    probeStep(lane, now)
    if (!lane.speaking) return
    const pcm = lane.buffer.slice(0)
    stats.localChunks++
    emit('lane', { lane: lane.id, owner: LOCAL_OWNER, startedAt: lane.startedAt, language, pcm: pcm.buffer }, [pcm.buffer])
    if (!voiced && now - lane.lastVoiceAt >= SILENCE_FLUSH_MS) {
      lane.speaking = false
      emit('laneFlush', { lane: lane.id })
    }
  }

  function ingestLocal(lane, frame) {
    const count = frame.numberOfFrames
    if (!count || !frame.sampleRate) return
    const data = readChannel(frame)
    const step = frame.sampleRate / TARGET_RATE
    let position = lane.position
    while (position < count) {
      const raw = data[Math.floor(position)]
      const sample = raw < -1 ? -1 : raw > 1 ? 1 : raw
      lane.buffer[lane.filled++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
      lane.sum += sample * sample
      if (lane.filled === CHUNK_SAMPLES) flushLocal(lane)
      position += step
    }
    lane.position = position - count
  }

  async function pumpLocal(lane) {
    try {
      while (local.lane === lane) {
        const { value: frame, done } = await lane.reader.read()
        if (done) break
        try { ingestLocal(lane, frame) } finally { frame.close() }
      }
    } catch (err) {
      noteError(err)
    }
    if (local.lane === lane) local.lane = null
    lane.reader.cancel().catch(() => {})
  }

  function stopLocalLane() {
    const lane = local.lane
    if (!lane) return
    local.lane = null
    if (lane.speaking && session) emit('laneFlush', { lane: lane.id })
    lane.reader.cancel().catch(() => {})
  }

  function startLocalLane(track) {
    if (typeof MediaStreamTrackProcessor !== 'function') {
      stats.error = 'MediaStreamTrackProcessor tidak tersedia'
      return
    }
    stopLocalLane()
    let reader
    try {
      reader = new MediaStreamTrackProcessor({ track }).readable.getReader()
    } catch (err) {
      noteError(err)
      return
    }
    const lane = {
      id: ++local.counter,
      track,
      reader,
      buffer: new Int16Array(CHUNK_SAMPLES),
      filled: 0,
      sum: 0,
      position: 0,
      muted: false,
      speaking: false,
      startedAt: 0,
      lastVoiceAt: 0,
    }
    local.lane = lane
    trace({ r: 'localLane', v: String(lane.id) })
    void pumpLocal(lane)
  }

  function scanLocal() {
    let track = null
    for (const peer of peers) {
      let senders = []
      try { senders = peer.getSenders() } catch {}
      for (const sender of senders) {
        if (localSending(sender)) {
          track = sender.track
          break
        }
      }
      if (track) break
    }
    local.sending = Boolean(track)
    if (!session) return
    if (track && local.lane?.track !== track) startLocalLane(track)
    if (local.lane) local.lane.muted = !track || local.lane.track !== track
  }

  function digits(value) {
    const text = String(value)
    if (/^\d{1,20}$/.test(text)) return text
    let hash = 0xcbf29ce484222325n
    for (let i = 0; i < text.length; i++) hash = BigInt.asUintN(64, (hash ^ BigInt(text.charCodeAt(i))) * 0x100000001b3n)
    return (hash % 10000000000000000000n).toString()
  }

  function queueChat(chat) {
    if (!session || !chat?.text?.trim()) return
    const eventId = digits(chat.messageId)
    if (queueEntry(`chat/${eventId}/${chat.deviceId}`, {
      kind: 'chat',
      eventId,
      version: '0',
      deviceId: chat.deviceId,
      text: chat.text,
      language: '',
    })) stats.chats++
  }

  function flushUtterances() {
    if (!pendingUtterances.size) return
    const utterances = [...pendingUtterances.values()]
    for (const key of pendingUtterances.keys()) delivered.add(key)
    while (delivered.size > 4000) delivered.delete(delivered.values().next().value)
    pendingUtterances.clear()
    for (let i = 0; i < utterances.length; i += 200) {
      stats.sent += Math.min(200, utterances.length - i)
      emit('utterances', { utterances: utterances.slice(i, i + 200) })
    }
  }

  function reject(reason) {
    stats.rejected++
    stats.reason = reason
  }

  async function bytesOf(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data)
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer())
    return null
  }

  function syncBytes(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data)
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    return null
  }

  function textOf(body) {
    if (typeof body === 'string') return body
    const bytes = syncBytes(body)
    return bytes ? new TextDecoder().decode(bytes) : ''
  }

  function handleV2(channel, raw, arrived) {
    try {
      const parsed = protocol.captionV2(raw)
      if (parsed.reason === 'noUtterance') {
        stats.control++
        trace({ c: 'v2', r: 'control', n: raw.byteLength })
        return
      }
      if (parsed.kind !== 'caption') {
        trace({ c: 'v2', r: `reject:${parsed.reason}`, n: raw.byteLength })
        return reject(parsed.reason)
      }
      if (ours.has(channel)) {
        try { channel.send(protocol.captionAck(parsed.utteranceId, parsed.version)) } catch {}
        stats.ackLagMs = Math.max(stats.ackLagMs, Date.now() - arrived)
      }
      queueCaption(parsed, true, channel)
    } catch (err) {
      reject('exception')
      noteError(err)
    }
  }

  function ackOnly(channel, data) {
    if (channel.label !== 'captions_v2' || !ours.has(channel)) return
    const raw = syncBytes(data)
    if (!raw) return
    try {
      const parsed = protocol.captionV2(raw)
      if (parsed.kind === 'caption') channel.send(protocol.captionAck(parsed.utteranceId, parsed.version))
    } catch {}
  }

  function onCaptionMessage(channel, event) {
    if (!session) {
      ackOnly(channel, event.data)
      return
    }
    const arrived = Date.now()
    stats.packets++
    lastPacketAt = arrived
    recoveries = 0
    escalated = false
    if (channel.label === 'captions_v2') {
      const raw = syncBytes(event.data)
      if (raw) {
        handleV2(channel, raw, arrived)
        return
      }
      captionQueue = captionQueue.then(async () => {
        const bytes = await bytesOf(event.data)
        if (bytes) handleV2(channel, bytes, arrived)
        else reject('notBinary')
      }).catch((err) => {
        reject('exception')
        noteError(err)
      })
      return
    }
    captionQueue = captionQueue.then(async () => {
      const raw = await bytesOf(event.data)
      if (!raw) return reject('notBinary')
      const bytes = await protocol.unwrap(raw)
      const parsed = protocol.captionLegacy(bytes)
      if (parsed.kind === 'control') {
        stats.control++
        trace({ c: 'v1', r: 'control', n: bytes.byteLength })
        return
      }
      if (parsed.kind === 'caption') return queueCaption(parsed, false, channel)
      const fallback = protocol.captionLoose(bytes)
      if (fallback) {
        trace({ c: 'v1', r: 'loose', n: bytes.byteLength })
        return queueCaption(fallback, false, channel)
      }
      trace({ c: 'v1', r: `reject:${parsed.reason}`, n: bytes.byteLength })
      reject(parsed.reason)
    }).catch((err) => {
      reject('exception')
      noteError(err)
    })
  }

  function onChatPacket(data) {
    if (!session) return
    chatQueue = chatQueue.then(async () => {
      const raw = await bytesOf(data)
      if (!raw) return
      queueChat(protocol.chatMessage(await protocol.unwrap(raw)))
    }).catch(() => {})
  }

  function listenCaptions(channel) {
    if (listened.has(channel)) return
    listened.add(channel)
    channel.binaryType = 'arraybuffer'
    channel.addEventListener('message', (event) => onCaptionMessage(channel, event))
  }

  function createChannel(peer, label) {
    creating = true
    try {
      return peer.createDataChannel(label, { ordered: true, maxRetransmits: 10, id: ++channelId })
    } finally {
      creating = false
    }
  }

  function usable(peer) {
    return peer && peer.connectionState !== 'closed' && peer.connectionState !== 'failed'
  }

  function reopen(peer, label) {
    try {
      track(peer, createChannel(peer, label))
      return
    } catch (err) {
      noteError(err)
    }
    let attempts = 0
    const retry = () => {
      if (!session || attempts++ >= RETRY_LIMIT) return
      const next = captionPeer
      if (next && next !== peer && usable(next)) {
        try {
          track(next, createChannel(next, label))
          return
        } catch {}
      }
      setTimeout(retry, RETRY_MS)
    }
    setTimeout(retry, RETRY_MS)
  }

  function keepOpen(peer, channel) {
    const check = () => {
      if (!opened.has(channel)) return
      if (channel.readyState !== 'closing' && channel.readyState !== 'closed') {
        setTimeout(check, REOPEN_MS)
        return
      }
      opened.delete(channel)
      trace({ c: channel.label, r: 'closed', own: ours.has(channel) })
      if (!session || latest.get(channel.label) !== channel) return
      const target = usable(peer) ? peer : captionPeer
      if (usable(target)) reopen(target, channel.label)
    }
    setTimeout(check, REOPEN_MS)
  }

  function track(peer, channel) {
    trace({ c: channel.label, r: 'opened', own: ours.has(channel) })
    opened.add(channel)
    latest.set(channel.label, channel)
    keepOpen(peer, channel)
    if (!CAPTION_LABELS.includes(channel.label)) return
    const announce = () => sendLanguage()
    if (channel.readyState === 'open') announce()
    else channel.addEventListener('open', announce, { once: true })
  }

  function openCaptionPair(peer) {
    for (const label of CAPTION_LABELS) {
      try { track(peer, createChannel(peer, label)) } catch (err) { noteError(err) }
    }
  }

  function startCaptions() {
    clearTimeout(waitTimer)
    if (!session) return
    const peer = captionPeer
    if (!usable(peer)) {
      waitTimer = setTimeout(startCaptions, PEER_WAIT_MS)
      return
    }
    for (const channel of opened) {
      if (ours.has(channel) && CAPTION_LABELS.includes(channel.label) && ['open', 'connecting'].includes(channel.readyState)) return
    }
    openCaptionPair(peer)
  }

  function adoptPeer(peer) {
    if (captionPeer === peer) return
    captionPeer = peer
    trace({ r: 'peer', n: peers.size })
    if (session) startCaptions()
  }

  function settleLanguage(result) {
    if (!languageWaiter) return
    clearTimeout(languageWaiter.timer)
    languageWaiter = null
    stats.languageState = result
    if (result === 'timeout' || result === 'unavailable') {
      reassertLanguage = true
      sendLanguage(true, false)
    }
  }

  function sendLanguage(force = false, confirm = true) {
    if (!session || !language) return
    if (mediaSession?.readyState !== 'open') {
      reassertLanguage = true
      return
    }
    const now = Date.now()
    if (!force && now - languageAt < LANGUAGE_GAP_MS) return
    languageAt = now
    const op = lastOp + 1
    const seq = lastSeq + 1
    try {
      ownLanguageSend = true
      mediaSession.send(protocol.languageCommand(op, language))
      ownLanguageSend = false
      mediaSession.send(protocol.languageAck(seq))
      mediaSession.send(protocol.languageAck(seq + 1))
      stats.languageSends++
      trace({ r: 'language', tail: language, v: String(op) })
    } catch (err) {
      ownLanguageSend = false
      noteError(err)
      if (confirm) settleLanguage('unavailable')
      return
    }
    if (!confirm) return
    if (languageWaiter) clearTimeout(languageWaiter.timer)
    stats.languageState = 'menunggu'
    languageWaiter = { timer: setTimeout(() => settleLanguage('timeout'), LANGUAGE_ACK_MS) }
  }

  function onMediaMessage(event) {
    mediaQueue = mediaQueue.then(async () => {
      const raw = await bytesOf(event.data)
      if (!raw) return
      const bytes = await protocol.unwrap(raw)
      if (bytes.byteLength <= 100 || !languageWaiter) return
      const seq = protocol.incomingSeq(bytes)
      if (seq === undefined) return settleLanguage('ok')
      if (seq > lastIncoming) {
        lastIncoming = seq
        settleLanguage('ok')
      } else settleLanguage('ditolak')
    }).catch(() => {})
  }

  function adoptMediaSession(channel) {
    if (languageWaiter) settleLanguage('unavailable')
    mediaSession = channel
    lastOp = 0
    lastSeq = 0
    lastIncoming = 0
    channel.addEventListener('message', onMediaMessage)
    const ready = () => {
      if (mediaSession !== channel) return
      if (reassertLanguage) {
        reassertLanguage = false
        sendLanguage(true, false)
      } else sendLanguage()
    }
    if (channel.readyState === 'open') ready()
    else channel.addEventListener('open', ready, { once: true })
  }

  function observeCollections(channel) {
    channel.addEventListener('message', (event) => {
      if (pending >= 100) return
      pending++
      collectionQueue = collectionQueue.then(async () => {
        const bytes = await protocol.packet(event.data, true)
        const users = protocol.roster(bytes)
        if (users.length) applyUsers(users)
        const devices = protocol.devices(bytes)
        if (devices.length) applyDevices(devices)
        queueChat(protocol.chatMessage(bytes))
      }).catch(() => {}).finally(() => { pending-- })
    })
  }

  function observe(peer, channel, local) {
    if (seen.has(channel)) return
    seen.add(channel)
    if (channel.label === 'collections') {
      adoptPeer(peer)
      observeCollections(channel)
    } else if (channel.label === MEDIA_LABEL) {
      adoptMediaSession(channel)
    } else if (CAPTION_LABELS.includes(channel.label)) {
      listenCaptions(channel)
    } else if (channel.label === CHAT_LABEL && local) {
      channel.addEventListener('message', (event) => onChatPacket(event.data))
      track(peer, channel)
    }
  }

  function rewriteOutgoing(bytes) {
    const code = protocol.outgoingLanguage(bytes)
    if (!code) return bytes
    if (ownLanguageSend) {
      meetLanguage = code
      return bytes
    }
    const verdict = guard.classify(code)
    trace({ r: `meetLanguage:${verdict}`, tail: code })
    if (verdict === 'rewrite' && guard.desired) {
      meetLanguage = guard.desired.code
      const op = protocol.outgoingOp(bytes)
      return op === undefined ? null : protocol.languageCommand(op, guard.desired.code)
    }
    if (verdict === 'adopt') adoptLanguage(code)
    else meetLanguage = code
    return bytes
  }

  const ChannelProto = window.RTCDataChannel?.prototype
  const originalSend = ChannelProto?.send
  if (originalSend) {
    ChannelProto.send = function (data) {
      if (this.label === MEDIA_LABEL) {
        const bytes = syncBytes(data)
        if (bytes) {
          let replaced = bytes
          try {
            const op = protocol.outgoingOp(bytes)
            if (op !== undefined) lastOp = op
            const seq = protocol.outgoingAck(bytes)
            if (seq !== undefined) lastSeq = seq
            replaced = rewriteOutgoing(bytes)
          } catch {}
          if (replaced === null) return undefined
          if (replaced !== bytes) return Reflect.apply(originalSend, this, [replaced])
        }
      }
      return Reflect.apply(originalSend, this, arguments)
    }
  }

  const Original = window.RTCPeerConnection
  if (Original) {
    const originalCreate = Original.prototype.createDataChannel
    Original.prototype.createDataChannel = function (...args) {
      const channel = Reflect.apply(originalCreate, this, args)
      if (channel) {
        if (creating) ours.add(channel)
        observe(this, channel, true)
      }
      return channel
    }
    window.RTCPeerConnection = new Proxy(Original, {
      construct(target, args, newTarget) {
        const peer = Reflect.construct(target, args, newTarget)
        peerCount++
        peers.add(peer)
        peer.addEventListener('connectionstatechange', () => {
          if (usable(peer)) return
          peers.delete(peer)
          if (captionPeer === peer) captionPeer = null
        })
        peer.addEventListener('datachannel', (event) => observe(peer, event.channel, false))
        return peer
      },
    })
  }

  function decodeBase64(text) {
    return Uint8Array.from(atob(text.trim()), (c) => c.charCodeAt(0))
  }

  function noteMeetLanguage(code) {
    if (typeof code !== 'string' || !code || code.length > 32) return
    meetLanguage = code
  }

  function inspectRequest(url, body) {
    if (body === undefined || body === null) return
    if (url === RPC.device) {
      const match = textOf(body).match(/\b[A-Za-z0-9_-]{28}\b/)
      if (match) mediaSessionId = match[0]
    } else if (url === RPC.sync) {
      noteSelf(textOf(body))
    } else if (url === RPC.getMedia) {
      const match = textOf(body).match(/mediasessions\/([A-Za-z0-9_-]+)/)
      if (match) mediaSessionId = match[1]
    } else if (url === RPC.updateMedia) {
      const match = textOf(body).match(/\n[\x01-\x7f]([a-zA-Z-]+)\x12/)
      if (match) noteMeetLanguage(match[1])
    }
  }

  function inspectResponse(url, response) {
    if (url === RPC.sync) {
      response.clone().text().then((body) => {
        if (body.length > 3 * 1024 * 1024) return
        applyUsers(protocol.roster(decodeBase64(body), true))
      }).catch(() => {})
    } else if (url === RPC.message) {
      response.clone().text().then((body) => {
        if (body.length > 3 * 1024 * 1024) return
        queueChat(protocol.chatMessage(decodeBase64(body)))
      }).catch(() => {})
    } else if (url === RPC.device) {
      response.clone().text().then((body) => {
        if (body.length > 3 * 1024 * 1024) return
        noteSelf(new TextDecoder().decode(decodeBase64(body)))
      }).catch(() => {})
    }
  }

  const originalFetch = window.fetch
  window.fetch = async function (...args) {
    try {
      const target = args[0]
      const url = String(typeof target === 'string' ? target : target?.url ?? '').split('?')[0]
      inspectRequest(url, args[1]?.body)
    } catch {}
    const response = await Reflect.apply(originalFetch, this, args)
    try { inspectResponse(String(response.url ?? '').split('?')[0], response) } catch {}
    return response
  }

  const XHR = window.XMLHttpRequest?.prototype
  if (XHR) {
    const originalOpen = XHR.open
    const originalXhrSend = XHR.send
    XHR.open = function (method, url) {
      const text = String(url ?? '')
      this.__rekapinRpc = text.startsWith(RPC.modify) ? 'modify' : text.startsWith(RPC.queryLanguage) ? 'query' : null
      return Reflect.apply(originalOpen, this, arguments)
    }
    XHR.send = function (body) {
      try {
        if (this.__rekapinRpc === 'modify') {
          const ids = JSON.parse(String(body ?? '[]'))[3][0][17]
          const code = protocol.languageCode(Number(ids?.[3]))
          if (code) noteMeetLanguage(code)
        } else if (this.__rekapinRpc === 'query') {
          const id = JSON.parse(String(body ?? '[]'))[1]
          if (typeof id === 'string' && id.length <= 128) mediaSessionId = id
        }
      } catch {}
      return Reflect.apply(originalXhrSend, this, arguments)
    }
  }

  function scanSpeech() {
    if (document.querySelector?.(SPEAKING_SELECTOR)) watchIndicators()
    for (const peer of peers) {
      let receivers = []
      try { receivers = peer.getReceivers() } catch {}
      for (const receiver of receivers) {
        if (receiver.track?.kind !== 'audio') continue
        let sources = []
        try { sources = receiver.getSynchronizationSources() } catch {}
        if (sources.some((source) => (source.audioLevel ?? 0) >= SPEECH_LEVEL)) speakingAt = Date.now()
      }
    }
  }

  const indicatorWatcher = typeof MutationObserver === 'function' ? new MutationObserver(() => { speakingAt = Date.now() }) : null
  const watchedIndicators = new WeakSet()
  function watchIndicators() {
    if (!indicatorWatcher) return
    for (const node of document.querySelectorAll(SPEAKING_SELECTOR)) {
      if (watchedIndicators.has(node)) continue
      watchedIndicators.add(node)
      indicatorWatcher.observe(node, { attributes: true })
    }
  }

  function captionButton() {
    const icon = Array.from(document.querySelectorAll('button i.google-symbols, button i.google-material-icons'))
      .find((node) => (node.textContent ?? '').startsWith('closed_caption'))
    const button = icon?.closest('button')
    if (!button) return null
    const box = button.getBoundingClientRect()
    if (!box.width || !box.height) return null
    return { button, icon: icon.textContent.trim() }
  }

  async function toggleCaptionsTwice() {
    const first = captionButton()
    if (!first || !['closed_caption', 'closed_caption_off'].includes(first.icon)) return
    first.button.click()
    const flipped = first.icon === 'closed_caption' ? 'closed_caption_off' : 'closed_caption'
    await new Promise((resolve) => setTimeout(resolve, 500))
    for (let i = 0; i < 10; i++) {
      const next = captionButton()
      if (next?.icon === flipped) {
        next.button.click()
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }

  function checkSilence() {
    if (!session || lastPacketAt === null || speakingAt === null) return
    const now = Date.now()
    const silent = now - lastPacketAt
    if (silent < SILENCE_MS || now - speakingAt > SPEAKING_RECENT_MS) return
    if (recoveries >= RECOVERY_LIMIT) {
      if (escalated) return
      escalated = true
      lastPacketAt = now
      toggleCaptionsTwice().catch(() => {})
      return
    }
    recoveries++
    stats.recoveries++
    trace({ r: 'recovery', n: Math.round(silent / 1000) })
    lastPacketAt = now
    if (usable(captionPeer) && captionPeer.connectionState === 'connected') openCaptionPair(captionPeer)
  }

  function selectListboxLanguage(listbox) {
    const code = guard.desired?.code
    if (!code) return
    const option = Array.from(listbox.children).find((node) => node.getAttribute('data-value') === code)
    option?.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }))
  }

  function watchLanguageMenu() {
    if (typeof MutationObserver !== 'function' || !document.body) return
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === 1 && node.matches?.(LANGUAGE_LISTBOX)) selectListboxLanguage(node)
        }
      }
    }).observe(document.body, { childList: true, subtree: true })
  }
  if (typeof document !== 'undefined' && document.addEventListener) {
    if (document.body) watchLanguageMenu()
    else document.addEventListener('DOMContentLoaded', watchLanguageMenu, { once: true })
  }

  function stopSession() {
    trace({ r: 'stop' })
    flushUtterances()
    for (const timer of [statsTimer, flushTimer, silenceTimer, speechTimer, local.timer]) clearInterval(timer)
    clearTimeout(waitTimer)
    if (languageWaiter) clearTimeout(languageWaiter.timer)
    languageWaiter = null
    statsTimer = flushTimer = silenceTimer = speechTimer = waitTimer = local.timer = null
    stopLocalLane()
    local.probe.remaining = 0
    local.probe.silence = 0
    session = null
  }

  window.addEventListener('message', (event) => {
    const data = event.data
    if (event.source !== window || event.origin !== origin || data?.bridge !== 'rekapin-meet-control-v1') return
    if (data.type === 'start' && typeof data.session === 'string') {
      if (session) stopSession()
      session = data.session
      captionLog.length = 0
      sessionStart = Date.now()
      trace({ r: 'start', tail: String(data.language ?? ''), n: peers.size })
      const autoMode = data.language === 'auto'
      const wanted = LANGUAGES[data.language] ?? ''
      const resumeAuto = autoMode && auto.enabled && Boolean(language)
      auto.enabled = autoMode
      language = wanted || (resumeAuto ? language : FALLBACK_LANGUAGE)
      guard.advise(language)
      languageAt = 0
      lastPacketAt = null
      speakingAt = null
      recoveries = 0
      escalated = false
      resetStats()
      pendingUtterances.clear()
      statsTimer = setInterval(reportStats, STATS_MS)
      flushTimer = setInterval(flushUtterances, FLUSH_MS)
      silenceTimer = setInterval(checkSilence, SILENCE_CHECK_MS)
      speechTimer = setInterval(scanSpeech, SPEECH_SCAN_MS)
      local.timer = setInterval(scanLocal, LOCAL_SCAN_MS)
      scanLocal()
      startCaptions()
      sendLanguage()
      emit('ready', { peers: peerCount, captions: Boolean(Original) })
      emitRoster()
      if (streamOwner.size) emit('devices', { devices: [...streamOwner].map(([streamId, deviceId]) => ({ streamId, deviceId })) })
      reportStats()
    } else if (data.type === 'stop' && data.session === session) {
      stopSession()
    } else if (data.type === 'switchLanguage' && data.session === session && typeof data.language === 'string') {
      switchLanguage(data.language, 'user')
    }
  })
})()

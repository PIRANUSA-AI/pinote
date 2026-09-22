// Runs in MAIN at document_start. No DOM name inference or audio correlation.
(() => {
  if (window.__rekapinMeetInstalled) return
  window.__rekapinMeetInstalled = true
  const protocol = globalThis.RekapinMeetProtocol
  const origin = location.origin
  const registry = new Map()
  const seen = new WeakSet()
  let session = null
  let peerCount = 0
  let pending = 0
  let queue = Promise.resolve()
  let lastError = 0
  function emit(type, data = {}) {
    if (type === 'error') {
      if (Date.now() - lastError < 5000) return
      lastError = Date.now()
    }
    if (session) window.postMessage({ bridge: 'rekapin-meet-v1', session, type, ...data }, origin)
  }
  function applyUsers(users) {
    for (const user of users) registry.set(user.id, user)
    while (registry.size > 2000) registry.delete(registry.keys().next().value)
    emit('roster', { users: [...registry.values()] })
  }
  function observe(channel) {
    if (seen.has(channel)) return
    seen.add(channel)
    if (!['collections', 'captions', 'captions_v2'].includes(channel.label)) return
    channel.addEventListener('message', (event) => {
      const capturedSession = session
      if (!capturedSession && channel.label !== 'collections') return
      if (pending >= 100) { emit('error', { message: 'Data Meet terlalu padat; sebagian transkrip tidak tertangkap.' }); return }
      pending++
      queue = queue.then(async () => {
        const bytes = await protocol.packet(event.data, channel.label === 'collections')
        if (channel.label === 'collections') applyUsers(protocol.roster(bytes))
        else if (session && session === capturedSession) {
          emit('caption', { caption: protocol.caption(bytes, channel.label === 'captions_v2'), at: Date.now() })
        }
      }).catch(() => emit('error', { message: 'Format data Meet belum dikenali. Identitas tidak akan ditebak.' }))
        .finally(() => { pending-- })
    })
  }
  const Original = window.RTCPeerConnection
  if (Original) {
    window.RTCPeerConnection = new Proxy(Original, {
      construct(target, args, newTarget) {
        const peer = Reflect.construct(target, args, newTarget)
        peerCount++
        peer.addEventListener('datachannel', (event) => observe(event.channel))
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
      }).catch(() => emit('error', { message: 'Daftar identitas Meet belum terbaca.' }))
    }
    return response
  }
  window.addEventListener('message', (event) => {
    const data = event.data
    if (event.source !== window || event.origin !== origin || data?.bridge !== 'rekapin-meet-control-v1') return
    if (data.type === 'start' && typeof data.session === 'string') {
      session = data.session
      emit('ready', { peers: peerCount })
      emit('roster', { users: [...registry.values()] })
    } else if (data.type === 'stop' && data.session === session) session = null
  })
})()

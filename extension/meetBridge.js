(() => {
  let session = null
  let style = null
  let timer = null
  let enabledByUs = false
  let pendingStart = null
  const send = (payload) => chrome.runtime.sendMessage({ target: 'service', type: 'meetNative', session, ...payload }).catch(() => {})
  const control = (type, id = session) => window.postMessage({ bridge: 'rekapin-meet-control-v1', type, session: id }, location.origin)
  function captionButton(turnOn) {
    return [...document.querySelectorAll('button[aria-label], [role="button"][aria-label]')].find((button) => {
      const label = button.getAttribute('aria-label') ?? ''
      const off = /turn off|nonaktifkan|matikan|disable/i.test(label)
      return /caption|subtitle|teks|takarir/i.test(label)
        && (turnOn ? !off && /turn on|aktifkan|nyalakan|hidupkan|enable/i.test(label) : off)
    })
  }
  function enable() {
    const button = captionButton(true)
    if (button) { button.click(); enabledByUs = true }
  }
  function stop() {
    control('stop')
    session = null
    clearInterval(timer)
    timer = null
    style?.remove()
    style = null
    if (enabledByUs) captionButton(false)?.click()
    enabledByUs = false
  }
  window.addEventListener('message', (event) => {
    const data = event.data
    if (event.source !== window || event.origin !== location.origin || data?.bridge !== 'rekapin-meet-v1' || !session || data.session !== session) return
    if (data.type === 'ready') {
      pendingStart?.({ ok: data.peers > 0, error: data.peers > 0 ? null : 'Muat ulang tab Meet setelah memperbarui extension, lalu masuk rapat dan mulai lagi.' })
      pendingStart = null
      if (!data.peers) { stop(); return }
    }
    if (['roster', 'caption', 'error'].includes(data.type)) send({ event: data.type, users: data.users, caption: data.caption, at: data.at, message: data.message })
  })
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.target !== 'meetBridge') return
    if (message.type === 'stop') { stop(); respond({ ok: true }); return }
    if (message.type !== 'start') return
    stop()
    session = message.session
    const current = session
    pendingStart = respond
    style = document.createElement('style')
    // Keep native rendering alive while hiding the known caption rows. Text and
    // identity are read from data channels, never from these elements.
    style.textContent = '.nMcdL, [class*="caption" i] [class*="row" i] { visibility: hidden !important; }'
    document.documentElement.appendChild(style)
    control('start')
    enable()
    let attempts = 0
    timer = setInterval(() => {
      if (++attempts <= 5 && !enabledByUs) enable()
      if (attempts === 5 && !captionButton(false)) send({ event: 'error', message: 'Caption Meet belum aktif. Aktifkan caption dalam bahasa rapat; tampilan caption akan disembunyikan oleh Rekapin.' })
    }, 1000)
    setTimeout(() => {
      if (session !== current || !pendingStart) return
      pendingStart({ ok: false, error: 'Hook Meet belum terpasang. Muat ulang tab Meet setelah memperbarui extension.' })
      pendingStart = null
      stop()
    }, 2000)
    return true
  })
  // Service-worker restoration and pause/stop must not leave collection enabled.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.liveState || !session) return
    const state = changes.liveState.newValue
    if (!state || state.sessionId !== session || !['starting', 'recording'].includes(state.status) || state.paused) stop()
  })
})()

const params = new URLSearchParams(location.search)
const returnTab = Number(params.get('returnTab'))
const statusNode = document.getElementById('permissionStatus')

async function closeSelf() {
  if (Number.isInteger(returnTab) && returnTab > 0) {
    await chrome.tabs.update(returnTab, { active: true }).catch(() => {})
  }
  const current = await chrome.tabs.getCurrent()
  if (current?.id) await chrome.tabs.remove(current.id)
}

async function request() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    stream.getTracks().forEach((track) => track.stop())
    statusNode.textContent = 'Mikrofon siap. Kembali ke rapat dan tekan Mulai Rekapin.'
    await chrome.runtime.sendMessage({ target: 'panel', type: 'micPermission', granted: true }).catch(() => {})
    setTimeout(closeSelf, 900)
  } catch {
    statusNode.textContent = 'Izin mikrofon ditolak. Klik ikon di kiri address bar, ubah Mikrofon menjadi Izinkan, lalu muat ulang halaman ini.'
    await chrome.runtime.sendMessage({ target: 'panel', type: 'micPermission', granted: false }).catch(() => {})
  }
}

request()

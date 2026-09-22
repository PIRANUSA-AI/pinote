// Run after the backend build: node scripts/verifyMeetIdentity.mjs
// Synthetic wire fixtures: exercise protocol behavior, not a live Meet claim.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { deflateSync } from 'node:zlib'
import { applyMeetEvent, nativeTranscript } from '../extension/meetTranscript.js'
import { nativeSegments, nativeTranscriptSchema } from '../backend/dist/lib/nativeTranscript.js'

const context = vm.createContext({ Uint8Array, TextDecoder, Blob, Response, DecompressionStream })
vm.runInContext(readFileSync(new URL('../extension/meetProtocol.js', import.meta.url), 'utf8'), context)
const protocol = context.RekapinMeetProtocol
const cat = (...parts) => Uint8Array.from(parts.flatMap((p) => [...p]))
function vint(value) {
  let n = BigInt(value); const out = []
  do { let b = Number(n & 127n); n >>= 7n; if (n) b |= 128; out.push(b) } while (n)
  return Uint8Array.from(out)
}
const integer = (id, n) => cat(vint(id * 8), vint(n))
const field = (id, bytes) => cat(vint(id * 8 + 2), vint(bytes.length), bytes)
const string = (id, text) => field(id, new TextEncoder().encode(text))
const user = (id, name) => field(2, cat(string(1, id), string(2, name), integer(4, 1)))
const roster = cat(...Array.from({ length: 6 }, (_, i) => user(`device-${i}`, i < 2 ? 'Yoel' : `Pembicara ${i}`)))
const sync = field(2, field(2, roster))
const collection = field(1, field(2, field(13, field(1, roster))))
const v1 = (device, id, version, text, final = false) => field(1, cat(string(1, device), integer(2, id), integer(3, version), integer(4, final ? 1 : 0), string(6, text)))
const v2 = field(1, cat(integer(1, '9007199254740993'), integer(2, 9), field(3, cat(integer(2, 1), string(3, 'Halo dari versi dua'), string(6, 'device-5')))))

assert.equal(protocol.roster(sync, true).length, 6)
assert.equal(protocol.roster(await protocol.packet(deflateSync(collection), true)).length, 6)
assert.equal(protocol.caption(v2, true).id, '9007199254740993', '64-bit IDs must retain precision')
assert.equal(protocol.caption(v2, true).deviceId, 'device-5')
assert.throws(() => protocol.caption(Uint8Array.from([10, 255, 255])))
assert.throws(() => protocol.caption(field(1, string(6, 'No participant'))))
assert.throws(() => protocol.roster(Uint8Array.from([15])))
await assert.rejects(() => protocol.packet(new Uint8Array(2 * 1024 * 1024 + 1)))
await assert.rejects(() => protocol.packet(deflateSync(new Uint8Array(2 * 1024 * 1024 + 1)), true))

const state = { lines: [], startedAt: Date.now() - 10000, pausedTotalMs: 0, meetParticipants: {} }
for (let i = 0; i < 6; i++) {
  applyMeetEvent(state, { event: 'caption', caption: protocol.caption(v1(`device-${i}`, i + 1, 1, `Kalimat milik ${i}`)) })
}
assert.equal(state.lines.length, 6)
assert.ok(state.lines.every((l) => !l.identityResolved), 'Never infer absent names')
applyMeetEvent(state, { event: 'roster', users: protocol.roster(sync, true) })
assert.ok(state.lines.every((l) => l.identityResolved), 'Late roster resolves by ID')
assert.equal(state.lines[0].participantId, 'device-0')
assert.equal(state.lines[1].participantId, 'device-1', 'Equal names do not merge identities')
applyMeetEvent(state, { event: 'caption', caption: protocol.caption(v1('device-0', 1, 3, 'Revisi final', true)) })
applyMeetEvent(state, { event: 'caption', caption: protocol.caption(v1('device-0', 1, 2, 'Revisi lama')) })
assert.equal(state.lines.length, 6)
assert.equal(state.lines[0].text, 'Revisi final')
applyMeetEvent(state, { event: 'caption', caption: protocol.caption(v1('new-device', 1, 1, 'Peserta masuk ulang')) })
assert.equal(state.lines.length, 7, 'Rejoined ID never inherits a different account name')
assert.equal(state.lines[6].identityResolved, false)
applyMeetEvent(state, { event: 'roster', users: [{ id: 'device-0', name: 'Yoel Baru' }] })
assert.equal(state.lines[0].speaker, 'Yoel Baru')
assert.equal(state.lines[1].speaker, 'Yoel')
state.lines[0].frozen = true
assert.equal(applyMeetEvent(state, { event: 'caption', caption: protocol.caption(v1('device-0', 1, 4, 'Speech while paused', true)) }), false)
assert.equal(state.lines[0].text, 'Revisi final')
const native = nativeTranscript(state)
assert.equal(nativeTranscriptSchema.safeParse(native).success, true)
assert.equal(nativeTranscriptSchema.safeParse([{ ...native[0], end: -1 }]).success, false)
assert.equal(nativeTranscriptSchema.safeParse([{ ...native[0], eventId: 'NaN' }]).success, false)
const segments = nativeSegments(native)
assert.equal(segments.length, 7)
assert.ok(segments.every((s) => s.provenance === 'meet-native' && s.participantId))
const twins = nativeSegments([{ ...native[0], name: 'Nama sama' }, { ...native[1], name: 'Nama sama' }])
assert.notEqual(twins[0].speaker, twins[1].speaker)
assert.equal(nativeSegments([...native, { ...native[0], version: '0', text: 'Old' }])[0].text, 'Revisi final')

// MAIN-world integration: originals remain usable, ordered packets resolve to
// the same registry, stopped/previous sessions do not emit caption data.
const listeners = new Map(), messages = []
class Channel extends EventTarget { constructor(label) { super(); this.label = label } }
class Peer extends EventTarget { createDataChannel(label) { return new Channel(label) } }
const page = vm.createContext({
  ...context, Uint8Array, TextDecoder, Blob, Response, DecompressionStream, Date, Promise,
  location: { origin: 'https://meet.google.com' }, RTCPeerConnection: Peer,
  fetch: async () => ({ url: 'https://example.com', untouched: true }),
  addEventListener: (type, handler) => listeners.set(type, handler),
  postMessage: (message) => messages.push(message),
})
page.window = page
page.RekapinMeetProtocol = protocol
vm.runInContext(readFileSync(new URL('../extension/meetPage.js', import.meta.url), 'utf8'), page)
const peer = new page.RTCPeerConnection()
assert.ok(peer instanceof Peer)
const collectionChannel = peer.createDataChannel('collections'), captionChannel = peer.createDataChannel('captions')
const control = (type, session) => vm.runInContext(`window._control(${JSON.stringify({ bridge: 'rekapin-meet-control-v1', type, session })})`, page)
page._listener = listeners.get('message')
vm.runInContext('window._control = data => window._listener({ source: window, origin: location.origin, data })', page)
control('start', 'session-1')
assert.equal(messages[0].type, 'ready')
assert.equal(messages[0].peers, 1)
collectionChannel.dispatchEvent(new MessageEvent('message', { data: deflateSync(collection) }))
captionChannel.dispatchEvent(new MessageEvent('message', { data: v1('device-3', 100, 1, 'Native event') }))
await new Promise((resolve) => setTimeout(resolve, 50))
assert.ok(messages.some((m) => m.type === 'roster' && m.users.length === 6))
assert.ok(messages.some((m) => m.type === 'caption' && m.caption.deviceId === 'device-3'))
const count = messages.filter((m) => m.type === 'caption').length
control('stop', 'session-1')
captionChannel.dispatchEvent(new MessageEvent('message', { data: v1('device-3', 101, 1, 'Stopped') }))
await new Promise((resolve) => setTimeout(resolve, 10))
assert.equal(messages.filter((m) => m.type === 'caption').length, count)
assert.equal((await page.fetch('https://example.com')).untouched, true)

// Isolated bridge: Indonesian "Nonaktifkan" must not match "Aktifkan".
// Stop restores only CC that Rekapin enabled; existing user CC stays enabled.
let ccOn = false, clicks = 0, bridgeHandler, storageHandler, bridgeMessageHandler
const styles = [], scheduled = [], responses = []
const button = { getAttribute: () => ccOn ? 'Nonaktifkan teks otomatis' : 'Aktifkan teks otomatis', click: () => { ccOn = !ccOn; clicks++ } }
const bridge = vm.createContext({
  location: { origin: 'https://meet.google.com' },
  document: {
    querySelectorAll: () => [button],
    createElement: () => ({ textContent: '', remove() { this.removed = true } }),
    documentElement: { appendChild: (style) => styles.push(style) },
  },
  chrome: {
    runtime: { sendMessage: async () => {}, onMessage: { addListener: (fn) => { bridgeHandler = fn } } },
    storage: { onChanged: { addListener: (fn) => { storageHandler = fn } } },
  },
  addEventListener: (type, fn) => { bridgeMessageHandler = fn },
  postMessage: () => {}, setInterval: (fn) => { scheduled.push(fn); return 1 }, clearInterval: () => {}, setTimeout: () => {},
})
bridge.window = bridge
vm.runInContext(readFileSync(new URL('../extension/meetBridge.js', import.meta.url), 'utf8'), bridge)
bridgeHandler({ target: 'meetBridge', type: 'start', session: 'bridge-1' }, {}, (response) => responses.push(response))
assert.equal(ccOn, true)
scheduled[0]()
assert.equal(clicks, 1, 'Do not turn CC off when Nonaktifkan includes aktifkan')
storageHandler({ liveState: { newValue: { status: 'recording', sessionId: 'bridge-1', paused: true } } }, 'local')
assert.equal(ccOn, false)
assert.equal(styles[0].removed, true)
ccOn = true
bridgeHandler({ target: 'meetBridge', type: 'start', session: 'bridge-2' }, {}, () => {})
bridgeHandler({ target: 'meetBridge', type: 'stop' }, {}, () => {})
assert.equal(ccOn, true, 'Preserve CC that was already enabled by the user')

// Service boundary: other tabs, frames, sessions, and legacy guesses cannot
// write to a native Meet transcript, including while paused.
const noopEvent = { addListener() {} }
const service = vm.createContext({
  applyMeetEvent, nativeTranscript, Date, URL, crypto: globalThis.crypto,
  chrome: {
    sidePanel: { setPanelBehavior: async () => {} },
    storage: { local: { remove: async () => {}, get: async () => ({}), set: async () => {} }, onChanged: noopEvent },
    contextMenus: { onClicked: noopEvent }, commands: { onCommand: noopEvent },
    runtime: { onInstalled: noopEvent, onMessage: noopEvent, sendMessage: async () => {} },
  },
})
vm.runInContext(readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8').replace(/^import .*\r?\n/gm, ''), service)
await vm.runInContext('ready', service)
vm.runInContext("Object.assign(state, { status: 'recording', source: 'meet', tabId: 42, sessionId: 'native-test', startedAt: Date.now(), lines: [] })", service)
service.testMessage = { type: 'meetNative', session: 'native-test', event: 'caption', caption: protocol.caption(v1('device-1', 1, 1, 'Test boundary')) }
assert.equal((await vm.runInContext('handleServiceMessage(testMessage, { tab: { id: 99 }, frameId: 0 })', service)).ok, false)
assert.equal((await vm.runInContext('handleServiceMessage(testMessage, { tab: { id: 42 }, frameId: 1 })', service)).ok, false)
assert.equal((await vm.runInContext("handleServiceMessage({ ...testMessage, session: 'old' }, { tab: { id: 42 }, frameId: 0 })", service)).ok, false)
assert.equal((await vm.runInContext('handleServiceMessage(testMessage, { tab: { id: 42 }, frameId: 0 })', service)).ok, true)
assert.equal(vm.runInContext('state.lines.length', service), 1)
assert.equal((await vm.runInContext("handleServiceMessage({ type: 'speaker', name: 'Wrong' }, { tab: { id: 42 } })", service)).ok, false)
vm.runInContext('state.paused = true', service)
assert.equal((await vm.runInContext('handleServiceMessage(testMessage, { tab: { id: 42 }, frameId: 0 })', service)).ok, false)
console.log('PASS: native Meet protocol, six participants, late identity, duplicates, revisions, malformed packets, upload schema, and page-hook lifecycle (synthetic fixtures).')

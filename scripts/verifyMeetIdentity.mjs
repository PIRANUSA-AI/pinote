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
const output = (type, streamId, deviceId, disabled = 0) => field(2, cat(integer(2, type), string(4, streamId), string(6, deviceId), field(10, integer(1, disabled))))
const roster = cat(...Array.from({ length: 6 }, (_, i) => user(`device-${i}`, i < 2 ? 'Yoel' : `Pembicara ${i}`)))
const sync = field(2, field(2, roster))
const deviceWrapper = field(3, cat(output(1, '5001', 'device-3'), output(2, '6001', 'device-3'), output(1, '5002', 'device-4', 1)))
const collection = field(1, field(2, cat(deviceWrapper, field(13, field(1, roster)))))

assert.equal(protocol.roster(sync, true).length, 6)
assert.equal(protocol.roster(await protocol.packet(deflateSync(collection), true)).length, 6)
const devices = protocol.devices(collection)
assert.equal(devices.length, 2, 'Only audio outputs map a stream to a device')
assert.deepEqual([...devices.map((d) => `${d.streamId}:${d.deviceId}:${d.disabled}`)], ['5001:device-3:false', '5002:device-4:true'])
assert.equal(protocol.devices(field(1, field(2, cat(field(13, field(1, roster)))))).length, 0)
assert.throws(() => protocol.roster(Uint8Array.from([15])))
assert.throws(() => protocol.devices(Uint8Array.from([15])))
const brokenName = field(2, cat(string(1, 'device-x'), field(2, Uint8Array.from([255, 254]))))
assert.equal(protocol.roster(field(1, field(2, field(13, field(1, cat(brokenName, user('device-ok', 'Nama Sah'))))))).length, 1)
assert.equal(protocol.roster(await protocol.packet(new Uint8Array(0), true)).length, 0)
await assert.rejects(() => protocol.packet(new Uint8Array(2 * 1024 * 1024 + 1)))
await assert.rejects(() => protocol.packet(deflateSync(new Uint8Array(2 * 1024 * 1024 + 1)), true))

const state = { lines: [], startedAt: Date.now() - 10000, pausedTotalMs: 0, meetParticipants: {} }
for (let i = 0; i < 6; i++) {
  assert.equal(applyMeetEvent(state, { event: 'laneFinal', participantId: `device-${i}`, text: `Kalimat milik ${i}`, startedAt: Date.now() - 2000 }), true)
}
assert.equal(state.lines.length, 6)
assert.ok(state.lines.every((l) => !l.identityResolved), 'Never infer absent names')
applyMeetEvent(state, { event: 'roster', users: protocol.roster(sync, true) })
assert.ok(state.lines.every((l) => l.identityResolved), 'Late roster resolves by ID')
assert.equal(state.lines[0].participantId, 'device-0')
assert.equal(state.lines[1].participantId, 'device-1', 'Equal names do not merge identities')
applyMeetEvent(state, { event: 'laneFinal', participantId: 'csrc:5001', text: 'Suara dari jalur', startedAt: Date.now() - 1000 })
assert.equal(state.lines[6].identityResolved, false, 'Unmapped stream stays unknown')
applyMeetEvent(state, { event: 'devices', devices })
assert.equal(state.lines[6].participantId, 'device-3', 'Stream mapping resolves late')
assert.equal(state.lines[6].speaker, 'Pembicara 3')
applyMeetEvent(state, { event: 'laneFinal', participantId: 'local', name: 'Yoel Ganteng', text: 'Suara saya sendiri' })
applyMeetEvent(state, { event: 'roster', users: [{ id: 'device-0', name: 'Yoel Baru' }] })
assert.equal(state.lines[0].speaker, 'Yoel Baru')
assert.equal(state.lines[1].speaker, 'Yoel')
assert.equal(state.lines[7].speaker, 'Yoel Ganteng', 'Local microphone keeps the account name')
assert.equal(applyMeetEvent(state, { event: 'laneFinal', participantId: '', text: 'Tanpa id' }), false)
assert.equal(applyMeetEvent(state, { event: 'laneFinal', participantId: 'device-1', text: '   ' }), false)
assert.ok(state.lines.every((l) => l.startSec <= l.endSec))
const native = nativeTranscript(state)
assert.equal(nativeTranscriptSchema.safeParse(native).success, true)
assert.equal(nativeTranscriptSchema.safeParse([{ ...native[0], end: -1 }]).success, false)
const segments = nativeSegments(native)
assert.equal(segments.length, 8)
assert.ok(segments.every((s) => s.provenance === 'meet-native' && s.participantId))
const twins = nativeSegments([{ ...native[0], name: 'Nama sama' }, { ...native[1], name: 'Nama sama' }])
assert.notEqual(twins[0].speaker, twins[1].speaker)

let clock = 1_000_000
const listeners = new Map(), messages = []
class Channel extends EventTarget { constructor(label) { super(); this.label = label } }
function frame(value) {
  return { numberOfFrames: 4800, sampleRate: 48000, copyTo: (dest) => dest.fill(value), close() {} }
}
function fakeReceiver(frames) {
  let index = 0
  let cancelled = false
  const reader = {
    read: async () => {
      if (cancelled) return { done: true }
      if (index < frames.length) {
        clock += 100
        return { value: frames[index++], done: false }
      }
      return new Promise(() => {})
    },
    cancel: async () => { cancelled = true },
  }
  return {
    track: { kind: 'audio', readyState: 'live', reader, addEventListener() {} },
    getContributingSources: () => [{ source: 5001, audioLevel: 0.5 }],
  }
}
const receiver = fakeReceiver([...Array(3).fill(frame(0.2)), ...Array(8).fill(frame(0))])
class Peer extends EventTarget {
  createDataChannel(label) { return new Channel(label) }
  getReceivers() { return [receiver] }
}
class FakeProcessor { constructor({ track }) { this.readable = { getReader: () => track.reader } } }
const page = vm.createContext({
  ...context, Blob, Response, DecompressionStream, Promise, MediaStreamTrackProcessor: FakeProcessor,
  Date: { now: () => clock },
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
const collectionChannel = peer.createDataChannel('collections')
collectionChannel.dispatchEvent(new MessageEvent('message', { data: deflateSync(collection) }))
await new Promise((resolve) => setTimeout(resolve, 50))
page._listener = listeners.get('message')
vm.runInContext('window._control = data => window._listener({ source: window, origin: location.origin, data })', page)
const control = (type, session) => vm.runInContext(`window._control(${JSON.stringify({ bridge: 'rekapin-meet-control-v1', type, session })})`, page)
control('start', 'session-1')
await new Promise((resolve) => setTimeout(resolve, 50))
const ready = messages.find((m) => m.type === 'ready')
assert.equal(ready.peers, 1)
assert.equal(ready.lanes, 1)
assert.equal(ready.processor, true)
assert.ok(messages.some((m) => m.type === 'roster' && m.users.length === 6))
assert.ok(messages.some((m) => m.type === 'devices' && m.devices.some((d) => d.streamId === '5001' && d.deviceId === 'device-3')))
const lanes = messages.filter((m) => m.type === 'lane')
assert.equal(lanes.length, 10, 'Speech plus the silence tail is streamed, then streaming stops')
assert.ok(lanes.every((m) => m.owner === 'device-3' && m.pcm.byteLength === 4800 && m.session === 'session-1'))
assert.equal(messages.filter((m) => m.type === 'laneFlush').length, 1)
control('stop', 'session-1')
const afterStop = messages.length
await new Promise((resolve) => setTimeout(resolve, 20))
assert.equal(messages.length, afterStop, 'Nothing is emitted after stop')
assert.equal((await page.fetch('https://example.com')).untouched, true)

const responses = [], portMessages = [], controls = [], timers = []
let bridgeHandler, storageHandler, bridgeMessageHandler
const port = { postMessage: (m) => portMessages.push(m), disconnect() {}, onDisconnect: { addListener() {} } }
const bridge = vm.createContext({
  location: { origin: 'https://meet.google.com' },
  btoa,
  chrome: {
    runtime: {
      sendMessage: async () => {},
      connect: () => port,
      onMessage: { addListener: (fn) => { bridgeHandler = fn } },
    },
    storage: { onChanged: { addListener: (fn) => { storageHandler = fn } } },
  },
  addEventListener: (type, fn) => { bridgeMessageHandler = fn },
  postMessage: (message) => controls.push(message),
  setTimeout: (fn) => { timers.push(fn); return timers.length },
  clearTimeout: () => {},
})
bridge.window = bridge
vm.runInContext(readFileSync(new URL('../extension/meetBridge.js', import.meta.url), 'utf8'), bridge)
bridge._deliver = (data) => bridgeMessageHandler(data)
const fromPage = (data) => {
  bridge._payload = { bridge: 'rekapin-meet-v1', ...data }
  vm.runInContext('_deliver({ source: window, origin: location.origin, data: _payload })', bridge)
}
assert.equal(bridgeHandler({ target: 'meetBridge', type: 'start', session: 'b1' }, {}, (r) => responses.push(r)), true)
assert.equal(controls.at(-1).type, 'start')
fromPage({ session: 'b1', type: 'ready', peers: 1, processor: true })
assert.equal(responses[0].ok, true)
assert.equal(responses[0].error, null)
fromPage({ session: 'b1', type: 'lane', lane: 1, owner: 'device-3', startedAt: 5, pcm: new Int16Array(2400).buffer })
assert.equal(portMessages[0].type, 'lane')
assert.equal(portMessages[0].owner, 'device-3')
assert.equal(typeof portMessages[0].pcm, 'string')
fromPage({ session: 'b1', type: 'lane', lane: 1, owner: 'device-3', startedAt: 5, pcm: new ArrayBuffer(70000) })
assert.equal(portMessages.length, 1, 'Oversized chunks are dropped')
fromPage({ session: 'other', type: 'lane', lane: 1, owner: 'x', startedAt: 5, pcm: new Int16Array(10).buffer })
assert.equal(portMessages.length, 1, 'Other sessions are ignored')
bridgeHandler({ target: 'meetBridge', type: 'stop' }, {}, () => {})
fromPage({ session: 'b1', type: 'laneFlush', lane: 1 })
assert.equal(portMessages.at(-1).type, 'laneFlush', 'The final flush still reaches the recorder while draining')
bridgeHandler({ target: 'meetBridge', type: 'start', session: 'b2' }, {}, (r) => responses.push(r))
fromPage({ session: 'b2', type: 'ready', peers: 1, processor: false })
assert.equal(responses[1].ok, false)
bridgeHandler({ target: 'meetBridge', type: 'start', session: 'b3' }, {}, (r) => responses.push(r))
fromPage({ session: 'b3', type: 'ready', peers: 1, processor: true })
storageHandler({ liveState: { newValue: { status: 'recording', sessionId: 'b3', paused: true } } }, 'local')
assert.equal(controls.at(-1).type, 'stop', 'Pause stops the page hook')

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
service.rosterMessage = { type: 'meetNative', session: 'native-test', event: 'roster', users: protocol.roster(sync, true) }
assert.equal((await vm.runInContext('handleServiceMessage(rosterMessage, { tab: { id: 99 }, frameId: 0 })', service)).ok, false)
assert.equal((await vm.runInContext('handleServiceMessage(rosterMessage, { tab: { id: 42 }, frameId: 1 })', service)).ok, false)
assert.equal((await vm.runInContext("handleServiceMessage({ ...rosterMessage, session: 'old' }, { tab: { id: 42 }, frameId: 0 })", service)).ok, false)
assert.equal((await vm.runInContext('handleServiceMessage(rosterMessage, { tab: { id: 42 }, frameId: 0 })', service)).ok, true)
service.injected = { type: 'meetNative', session: 'native-test', event: 'laneFinal', participantId: 'device-2', text: 'Disuntik halaman' }
await vm.runInContext('handleServiceMessage(injected, { tab: { id: 42 }, frameId: 0 })', service)
assert.equal(vm.runInContext('state.lines.length', service), 0, 'The page cannot write transcript lines')
vm.runInContext("handleOffscreenEvent({ type: 'laneFinal', participantId: 'device-3', text: 'Dari jalur audio', startedAt: Date.now() - 1500 })", service)
assert.equal(vm.runInContext('state.lines.length', service), 1)
assert.equal(vm.runInContext('state.lines[0].speaker', service), 'Pembicara 3')
vm.runInContext("handleOffscreenEvent({ type: 'liveFinal', text: 'Dari mikrofon' })", service)
assert.equal(vm.runInContext('state.lines[1].participantId', service), 'local')
assert.equal(vm.runInContext('state.lines[1].identityResolved', service), true)
assert.equal((await vm.runInContext("handleServiceMessage({ type: 'speaker', name: 'Wrong' }, { tab: { id: 42 } })", service)).ok, false)
vm.runInContext('state.paused = true', service)
assert.equal((await vm.runInContext('handleServiceMessage(rosterMessage, { tab: { id: 42 }, frameId: 0 })', service)).ok, false)
vm.runInContext("state.paused = false; state.status = 'uploading'", service)
vm.runInContext("handleOffscreenEvent({ type: 'laneFinal', participantId: 'device-3', text: 'Terlambat' })", service)
assert.equal(vm.runInContext('state.lines.length', service), 2, 'Lines never arrive outside recording')
console.log('PASS: Meet audio lanes, stream to account mapping, late identity, duplicate names, local microphone, bridge draining, upload schema, and service boundaries (synthetic fixtures).')

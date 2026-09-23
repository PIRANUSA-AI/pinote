import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { deflateSync } from 'node:zlib'
import { applyMeetEvent, claimSelfVoice, nativeTranscript } from '../extension/meetTranscript.js'
import { nativeSegments, nativeTranscriptSchema } from '../backend/dist/lib/nativeTranscript.js'

const context = vm.createContext({ Uint8Array, TextDecoder, TextEncoder, Blob, Response, DecompressionStream })
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

function v2Packet(utteranceId, version, deviceId, text) {
  return field(1, cat(integer(1, utteranceId), integer(2, version), field(3, cat(string(3, text), string(4, 'id-ID'), string(6, deviceId)))))
}
function legacyPacket(deviceId, messageId, version, text) {
  return field(1, cat(string(1, deviceId), integer(2, messageId), integer(3, version), string(6, text), integer(8, 41)))
}

let clock = 1_000_000
const listeners = new Map(), messages = []
class Channel extends EventTarget {
  constructor(label, options) {
    super()
    this.label = label
    this.options = options
    this.readyState = 'open'
    this.sent = []
  }
  send(data) { this.sent.push(data) }
  close() { this.readyState = 'closed' }
}
let peerReceivers = []
let peerSenders = []
class Peer extends EventTarget {
  constructor() { super(); this.connectionState = 'connected'; this.channels = [] }
  getReceivers() { return peerReceivers }
  getSenders() { return peerSenders }
  createDataChannel(label, options) {
    const channel = new Channel(label, options)
    this.channels.push(channel)
    return channel
  }
}
class Storage {
  getItem(key) { return Object.hasOwn(this, key) ? this[key] : null }
  setItem(key, value) { this[key] = String(value) }
}
const SETTINGS = 'rt_g3jartmcups-529862513'
const localStorage = new Storage()
localStorage.setItem(SETTINGS, JSON.stringify([null, null, 1]))
const storedLanguage = () => JSON.parse(localStorage[SETTINGS])[2]
let speechLevel = 0
peerReceivers = [{ track: { kind: 'audio' }, getSynchronizationSources: () => [{ audioLevel: speechLevel }] }]
function controlledReader() {
  const queue = []
  let waiter = null
  let cancelled = false
  return {
    push(value) {
      if (waiter) {
        const resolve = waiter
        waiter = null
        resolve({ value, done: false })
      } else queue.push(value)
    },
    read() {
      if (cancelled) return Promise.resolve({ done: true })
      if (queue.length) return Promise.resolve({ value: queue.shift(), done: false })
      return new Promise((resolve) => { waiter = resolve })
    },
    async cancel() {
      cancelled = true
      if (waiter) waiter({ done: true })
    },
  }
}
const frame = (value) => ({ numberOfFrames: 4800, sampleRate: 48000, copyTo: (dest) => dest.fill(value), close() {} })
class FakeProcessor { constructor({ track }) { this.readable = { getReader: () => track.reader } } }
const intervals = []
const page = vm.createContext({
  ...context, Blob, Response, DecompressionStream, Promise, ArrayBuffer, EventTarget, BigInt, Storage, localStorage,
  MediaStreamTrackProcessor: FakeProcessor,
  document: { querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: null },
  Date: { now: () => clock },
  setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length },
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  location: { origin: 'https://meet.google.com', pathname: '/abc-defg-hij' },
  RTCPeerConnection: Peer,
  RTCDataChannel: Channel,
  fetch: async () => ({ url: 'https://example.com', untouched: true }),
  addEventListener: (type, handler) => listeners.set(type, handler),
  postMessage: (message) => messages.push(message),
})
page.window = page
page.RekapinMeetProtocol = protocol
vm.runInContext(readFileSync(new URL('../extension/languageDetect.js', import.meta.url), 'utf8'), page)
vm.runInContext(readFileSync(new URL('../extension/meetPage.js', import.meta.url), 'utf8'), page)
const tick = () => new Promise((resolve) => setTimeout(resolve, 20))
const flush = () => intervals.filter((i) => i.ms === 500).at(-1).fn()
const utterances = (session) => messages.filter((m) => m.type === 'utterances' && m.session === session).flatMap((m) => m.utterances)

const peer = new page.RTCPeerConnection()
assert.ok(peer instanceof Peer)
const collectionChannel = peer.createDataChannel('collections')
collectionChannel.dispatchEvent(new MessageEvent('message', { data: deflateSync(collection) }))
const mediaSession = peer.createDataChannel('media-session')
mediaSession.send(protocol.languageCommand(5, 'en-US'))
mediaSession.send(protocol.languageAck(3))
await tick()
page._listener = listeners.get('message')
vm.runInContext('window._control = data => window._listener({ source: window, origin: location.origin, data })', page)
const control = (type, session, language) => vm.runInContext(`window._control(${JSON.stringify({ bridge: 'rekapin-meet-control-v1', type, session, language })})`, page)
control('start', 'session-1', 'id')
await tick()
const ready = messages.find((m) => m.type === 'ready')
assert.equal(ready.peers, 1)
assert.equal(ready.captions, true)
assert.ok(messages.some((m) => m.type === 'roster' && m.users.length === 6))
assert.ok(messages.some((m) => m.type === 'devices' && m.devices.some((d) => d.streamId === '5001' && d.deviceId === 'device-3')))

const captionsV2 = peer.channels.find((c) => c.label === 'captions_v2')
const captionsLegacy = peer.channels.find((c) => c.label === 'captions')
assert.ok(captionsV2 && captionsLegacy, 'Starting opens both Meet caption channels on the collections connection')
assert.equal(captionsV2.options.ordered, true)
assert.equal(captionsV2.options.maxRetransmits, 10)
const languageSent = mediaSession.sent.slice(2).map((d) => [...d])
assert.deepEqual(languageSent[0], [...protocol.languageCommand(6, 'id-ID')], 'The caption language follows the next Meet op')
assert.deepEqual(languageSent[1], [...protocol.languageAck(4)])
assert.deepEqual(languageSent[2], [...protocol.languageAck(5)])

class StalledBlob extends Blob {
  slice() { return { arrayBuffer: () => new Promise(() => {}) } }
}
collectionChannel.dispatchEvent(new MessageEvent('message', { data: new StalledBlob([Uint8Array.from([1])]) }))
captionsV2.dispatchEvent(new MessageEvent('message', { data: v2Packet(7, 1, 'device-3', 'Halo').buffer }))
assert.deepEqual([...captionsV2.sent[0]], [...protocol.captionAck('7', '1')], 'Captions are acknowledged inside the message handler, before any queue runs')
await tick()
clock += 300
captionsV2.dispatchEvent(new MessageEvent('message', { data: v2Packet(7, 2, 'device-3', 'Halo semua').buffer }))
captionsV2.dispatchEvent(new MessageEvent('message', { data: v2Packet(7, 1, 'device-3', 'Halo lama').buffer }))
await tick()
flush()
let batch = utterances('session-1')
assert.equal(batch.length, 1, 'Revisions of one utterance collapse into one event per flush')
assert.equal(batch[0].text, 'Halo semua')
assert.equal(batch[0].version, '2')
assert.equal(batch[0].eventId, '7')
assert.equal(batch[0].participantId, 'device-3')
assert.equal(batch[0].source, 'meet')
assert.equal(batch[0].meetingId, 'abc-defg-hij')
assert.equal(batch[0].timestamp, 1_000_000, 'The line starts when the utterance was first heard')
assert.equal(captionsV2.sent.length, 3, 'Every revision is acknowledged even while a collections packet is stuck')

captionsLegacy.dispatchEvent(new MessageEvent('message', { data: legacyPacket('device-0', 11, 1, 'Suara saya ikut').buffer }))
const remote = new Channel('captions')
peer.dispatchEvent(Object.assign(new Event('datachannel'), { channel: remote }))
remote.dispatchEvent(new MessageEvent('message', { data: v2Packet(9, 1, 'device-4', 'Dari channel Meet').buffer }))
await tick()
flush()
batch = utterances('session-1')
assert.ok(batch.some((u) => u.participantId === 'device-0' && u.text === 'Suara saya ikut'), 'Your own voice arrives like every other participant')
assert.equal(remote.sent.length, 0, 'Channels Meet opened itself are never acknowledged by us')

const latestStats = () => {
  intervals.filter((i) => i.ms === 2000).at(-1).fn()
  return messages.filter((m) => m.type === 'stats').at(-1).stats
}
const early = latestStats()
assert.ok(early.revisions > 1, 'Revisions per utterance are measured')
assert.ok(early.ackLagMs < 50, 'Ack lag is measured and stays tiny')
const sendsBefore = early.languageSends
assert.ok(sendsBefore >= 1)
await page.fetch('https://meet.google.com/$rpc/google.rtc.meetings.v1.MediaSessionService/UpdateMediaSession', { body: '\n\x05en-US\x12' })
const afterUpdate = latestStats()
assert.equal(afterUpdate.meetLanguage, 'en-US', 'The language Meet reports is recorded')
assert.equal(afterUpdate.languageSends, sendsBefore, 'A Meet language report never triggers another language command')
const before = latestStats()
captionsV2.dispatchEvent(new MessageEvent('message', { data: integer(2, 1).buffer }))
await tick()
const diag = latestStats()
assert.equal(diag.control, before.control + 1, 'Packets without an utterance count as Meet control traffic')
assert.equal(diag.rejected, before.rejected, 'Control traffic is never reported as rejected')

const loosePacket = cat(Uint8Array.from([1, 2, 3]), new TextEncoder().encode('spaces/s/devices/9'), Uint8Array.from([16, 5, 24, 2, 32, 1, 45, 0, 128, 63, 0, 0]), new TextEncoder().encode('Kalimat format lama'), Uint8Array.from([64, 41, 72]))
captionsLegacy.dispatchEvent(new MessageEvent('message', { data: loosePacket.buffer }))
await tick()
flush()
const looseLine = utterances('session-1').find((u) => u.participantId === 'spaces/s/devices/9')
assert.equal(looseLine?.text, 'Kalimat format lama', 'Old Meet caption bytes are read by the byte pattern fallback')
assert.equal(looseLine.eventId, '5')
assert.equal(looseLine.version, '2')

assert.equal(latestStats().languageState, 'menunggu', 'The language command waits for Meet to answer')
mediaSession.dispatchEvent(new MessageEvent('message', { data: new Uint8Array(120).fill(1).buffer }))
await tick()
assert.equal(latestStats().languageState, 'ok', 'A Meet answer confirms the caption language')

assert.equal(storedLanguage(), 41, 'The chosen language is written into Meet caption settings')
localStorage.setItem(SETTINGS, JSON.stringify([null, null, 1]))
assert.equal(storedLanguage(), 41, 'Meet writing its default language back is undone')
localStorage[SETTINGS] = JSON.stringify([null, null, 1])
assert.equal(JSON.parse(localStorage.getItem(SETTINGS))[2], 41, 'Meet reading its settings sees the chosen language')
const beforeRewrite = mediaSession.sent.length
mediaSession.send(protocol.languageCommand(20, 'en-US'))
assert.deepEqual([...mediaSession.sent.at(-1)], [...protocol.languageCommand(20, 'id-ID')], 'A Meet command back to its default language is rewritten')
assert.equal(mediaSession.sent.length, beforeRewrite + 1)

const chatChannel = peer.createDataChannel('meet_messages')
const chatPacket = field(1, field(2, field(13, field(4, field(2, cat(string(2, 'spaces/s/devices/3'), integer(3, 1700000000000), field(5, string(1, 'Link dokumennya di sini'))))))))
chatChannel.dispatchEvent(new MessageEvent('message', { data: chatPacket.buffer }))
await tick()
flush()
const chat = utterances('session-1').find((u) => u.kind === 'chat')
assert.equal(chat?.text, 'Link dokumennya di sini', 'Meet chat messages are captured')
assert.equal(chat.participantId, 'spaces/s/devices/3')
assert.equal(chat.eventId, '1700000000000')

const pairsBefore = peer.channels.filter((c) => c.label === 'captions_v2').length
speechLevel = 0.5
clock += 61000
intervals.filter((i) => i.ms === 1000).at(-1).fn()
intervals.filter((i) => i.ms === 10000).at(-1).fn()
assert.equal(peer.channels.filter((c) => c.label === 'captions_v2').length, pairsBefore + 1, 'Silent captions while people talk reopen the caption channels')
assert.equal(latestStats().recoveries, 1)
speechLevel = 0
clock += 61000
intervals.filter((i) => i.ms === 1000).at(-1).fn()
intervals.filter((i) => i.ms === 10000).at(-1).fn()
assert.equal(peer.channels.filter((c) => c.label === 'captions_v2').length, pairsBefore + 1, 'Nobody talking means silence is expected')

localStorage.setItem(SETTINGS, JSON.stringify([null, null, 5]))
assert.equal(latestStats().language, 'fr-FR', 'Picking another language inside Meet is adopted')
assert.equal(storedLanguage(), 5)

const pairsBeforePeer = peer.channels.filter((c) => c.label === 'captions_v2').length
const secondPeer = new page.RTCPeerConnection()
secondPeer.createDataChannel('collections')
assert.equal(captionsV2.readyState, 'open', 'A new Meet connection never closes caption channels that are working')
assert.equal(secondPeer.channels.filter((c) => c.label === 'captions_v2').length, 0, 'A new Meet connection does not get extra caption channels while ours are open')
assert.equal(peer.channels.filter((c) => c.label === 'captions_v2').length, pairsBeforePeer)
assert.ok(vm.runInContext('window.__rekapinCaptionLog', page).some((e) => e.r === 'peer'), 'Connection changes are traced')
assert.ok(vm.runInContext('window.__rekapinCaptionLog', page).some((e) => e.c === 'v2' && e.r === 'ok' && e.id === '7'), 'Raw captions are traced')

control('stop', 'session-1')
assert.equal(captionsV2.readyState, 'open', 'Stopping keeps caption channels open like the reference')
const afterStop = messages.length
const acksBefore = captionsV2.sent.length
captionsV2.dispatchEvent(new MessageEvent('message', { data: v2Packet(8, 1, 'device-3', 'Terlambat').buffer }))
await tick()
flush()
assert.equal(messages.length, afterStop, 'Nothing is emitted after stop')
assert.equal(captionsV2.sent.length, acksBefore + 1, 'Captions are still acknowledged between sessions')
assert.equal((await page.fetch('https://example.com')).untouched, true)

const micTrack = { kind: 'audio', readyState: 'live', enabled: true, muted: false, reader: controlledReader() }
peerSenders = [{ track: micTrack, getParameters: () => ({ encodings: [{ active: true }] }) }]
const pairsAtStop = peer.channels.filter((c) => c.label === 'captions_v2').length
const sentAtStop = mediaSession.sent.length
control('start', 'session-2', 'auto')
await tick()
assert.equal(peer.channels.filter((c) => c.label === 'captions_v2').length, pairsAtStop, 'A new session reuses the caption channels that are still open')
const commands = () => mediaSession.sent.map((d) => protocol.outgoingLanguage(d)).filter(Boolean)
assert.equal(mediaSession.sent.slice(sentAtStop).map((d) => protocol.outgoingLanguage(d)).find(Boolean), 'id-ID', 'Auto starts in Indonesian and still sends the caption config Meet needs')
assert.equal(latestStats().autoLanguage, true)
localStorage.setItem(SETTINGS, JSON.stringify([null, null, 1]))
assert.equal(storedLanguage(), 41, 'Auto keeps Meet on the language it picked')

const say = (id, device, text) => captionsV2.dispatchEvent(new MessageEvent('message', { data: v2Packet(id, 1, device, text).buffer }))
const suggestions = () => messages.filter((m) => m.type === 'languageSuggestion' && m.session === 'session-2').map((m) => `${m.code}:${m.reason}`)
say(20, 'device-3', 'dibuka kembali cerita rakyat ini tuh mencatat syarat yang diajukan')
say(21, 'device-3', 'seorang putri untuk menolak pinangan pangeran yang kuat dan juga')
assert.deepEqual(suggestions(), [], 'Indonesian speech raises no suggestion')
say(30, 'device-4', 'halo interaction following the meeting for ten minutes and I think that')
assert.deepEqual(suggestions(), [], 'One English sentence is not enough evidence')
say(31, 'device-4', 'this is another test from the extension and we will see how it works')
assert.deepEqual(suggestions(), ['en-US:evidence'], 'Two English sentences from one speaker suggest English')
assert.equal(latestStats().languageSwitches, 0, 'A suggestion never changes Meet by itself')
assert.equal(commands().at(-1), 'id-ID')
say(34, 'device-4', 'and one more sentence in English to make sure it keeps going on')
say(35, 'device-4', 'the same person is still talking in English about the project')
assert.equal(suggestions().length, 1, 'The same suggestion is not repeated within a short time')
control('switchLanguage', 'session-2', 'en-US')
assert.equal(commands().at(-1), 'en-US', 'Pressing the button tells Meet to switch')
assert.equal(latestStats().languageSwitches, 1)
assert.equal(latestStats().languageReason, 'user')
assert.equal(storedLanguage(), 1, 'Meet caption settings follow the switch')
say(22, 'device-3', 'iya')
assert.deepEqual(suggestions().at(-1), 'id-ID:memory', 'A known Indonesian speaker brings back an Indonesian suggestion on their first caption')

const allLanes = () => messages.filter((m) => m.type === 'lane' && m.session === 'session-2')
const lanes = () => allLanes().filter((m) => m.owner === 'local')
const probes = () => allLanes().filter((m) => m.owner === 'probe')
for (let i = 0; i < 3; i++) micTrack.reader.push(frame(0.2))
await tick()
assert.equal(lanes().length, 3, 'Your microphone as sent by Meet streams to Deepgram')
assert.ok(lanes().every((m) => m.language === 'en-US' && m.engine === undefined && m.pcm.byteLength === 4800), 'Deepgram hears your voice in the active caption language')
assert.equal(probes().length, 3, 'The start of your sentence is also sampled for language identification')
assert.ok(probes().every((m) => m.engine === 'qwen' && m.language === 'auto' && m.lane === 9001), 'Only the identifier sample goes to Qwen')
assert.equal(latestStats().localMic, true)
for (const id of [40, 41, 42]) say(id, 'device-0', `kalimat saya sendiri nomor ${id} yang cukup panjang`)
await tick()
const selfRoster = messages.filter((m) => m.type === 'roster' && m.session === 'session-2').at(-1)
assert.equal(selfRoster.selfId, 'device-0', 'The device whose captions match your own voice is recognised as you')
control('switchLanguage', 'session-2', 'ja-JP')
assert.equal(commands().at(-1), 'ja-JP', 'A chosen language switches Meet captions for everyone')
control('switchLanguage', 'session-2', 'ko-KR')
assert.equal(commands().at(-1), 'ko-KR', 'Every button press is honoured right away')
micTrack.enabled = false
intervals.filter((i) => i.ms === 250).at(-1).fn()
for (let i = 0; i < 2; i++) micTrack.reader.push(frame(0.2))
await tick()
assert.equal(lanes().length, 3, 'Muting in Meet stops your Deepgram audio immediately')
assert.ok(messages.some((m) => m.type === 'laneFlush' && m.session === 'session-2'), 'The sentence before muting is finished')
assert.equal(latestStats().localMic, false)
control('stop', 'session-2')
peerSenders = []

const responses = [], portMessages = [], controls = [], timers = []
let bridgeHandler, storageHandler, bridgeMessageHandler
const port = { postMessage: (m) => portMessages.push(m), disconnect() {}, onDisconnect: { addListener() {} } }
const bridge = vm.createContext({
  location: { origin: 'https://meet.google.com' },
  btoa,
  chrome: {
    runtime: {
      id: 'cncnbeehgiacjoimfoapiijccfifcoha',
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
assert.equal(bridgeHandler({ target: 'meetBridge', type: 'start', session: 'b1', language: 'id' }, {}, (r) => responses.push(r)), true)
assert.equal(controls.at(-1).type, 'start')
assert.equal(controls.at(-1).language, 'id', 'The chosen language reaches the page hook')
fromPage({ session: 'b1', type: 'ready', peers: 1, captions: true })
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
fromPage({ session: 'b2', type: 'ready', peers: 1, captions: false })
assert.equal(responses[1].ok, false)
bridgeHandler({ target: 'meetBridge', type: 'start', session: 'b3' }, {}, (r) => responses.push(r))
fromPage({ session: 'b3', type: 'ready', peers: 1, captions: true })
storageHandler({ liveState: { newValue: { status: 'recording', sessionId: 'b3', paused: true } } }, 'local')
assert.equal(controls.at(-1).type, 'stop', 'Pause stops the page hook')

bridgeHandler({ target: 'meetBridge', type: 'start', session: 'b4' }, {}, (r) => responses.push(r))
fromPage({ session: 'b4', type: 'ready', peers: 1, captions: true })
bridge.chrome.runtime.id = undefined
bridge.chrome.runtime.sendMessage = () => { throw new Error('Extension context invalidated.') }
assert.doesNotThrow(() => fromPage({ session: 'b4', type: 'stats', stats: { frames: 1 } }), 'An invalidated extension never throws inside Meet')
assert.equal(controls.at(-1).type, 'stop', 'An invalidated extension stops the page hook')
const beforeDead = controls.length
assert.doesNotThrow(() => fromPage({ session: 'b4', type: 'stats', stats: { frames: 2 } }))
assert.equal(controls.length, beforeDead, 'After shutdown the bridge stays silent')

const noopEvent = { addListener() {} }
const service = vm.createContext({
  applyMeetEvent, claimSelfVoice, nativeTranscript, Date, URL, crypto: globalThis.crypto,
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
vm.runInContext("handleOffscreenEvent({ type: 'laneFinal', participantId: 'local', text: 'Dari jalur keluar Meet' })", service)
assert.equal(vm.runInContext('state.lines[1].participantId', service), 'local')
assert.equal(vm.runInContext('state.lines[1].identityResolved', service), true)
assert.equal(vm.runInContext('state.lines[1].speaker', service), vm.runInContext('selfName', service))
assert.equal((await vm.runInContext("handleServiceMessage({ type: 'speaker', name: 'Wrong' }, { tab: { id: 42 } })", service)).ok, false)
vm.runInContext('state.paused = true', service)
assert.equal((await vm.runInContext('handleServiceMessage(rosterMessage, { tab: { id: 42 }, frameId: 0 })', service)).ok, false)
vm.runInContext("state.paused = false; state.status = 'uploading'", service)
vm.runInContext("handleOffscreenEvent({ type: 'laneFinal', participantId: 'device-3', text: 'Terlambat' })", service)
assert.equal(vm.runInContext('state.lines.length', service), 2, 'Lines never arrive outside recording')
console.log('PASS: Meet caption channels for every participant, caption acks, language command, revisions, stream to account mapping, late identity, duplicate names, bridge draining, upload schema, and service boundaries (synthetic fixtures).')

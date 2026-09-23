import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { applyMeetEvent, applyUtterance, nativeTranscript } from '../extension/meetTranscript.js'
import { nativeSegments, nativeTranscriptSchema } from '../backend/dist/lib/nativeTranscript.js'

const base = { source: 'meet', meetingId: 'abc-defg-hij', participantId: 'spaces/s/devices/1', eventId: '10', version: '1', text: 'Halo', timestamp: Date.now() - 3000 }
const fresh = () => ({ source: 'meet', lines: [], startedAt: Date.now() - 10000, pausedTotalMs: 0, meetParticipants: {} })

let state = fresh()
assert.equal(applyUtterance(state, base), true)
assert.equal(state.lines.length, 1)
assert.equal(state.lines[0].identityResolved, false, 'No name is guessed without identity data')
assert.equal(applyUtterance(state, base), false, 'An identical revision is a duplicate')
assert.equal(applyUtterance(state, { ...base, version: '2', text: 'Halo semua' }), true)
assert.equal(state.lines.length, 1, 'A newer version revises the same line')
assert.equal(state.lines[0].text, 'Halo semua')
assert.equal(state.lines[0].version, '2')
assert.equal(applyUtterance(state, { ...base, version: '1', text: 'Halo lama' }), false, 'Older versions never overwrite newer text')
assert.equal(state.lines[0].text, 'Halo semua')
assert.equal(applyUtterance(state, { ...base, version: '2', text: 'Halo semua', isFinal: true }), true, 'Finalizing the same version is a change')
assert.equal(state.lines[0].final, true)
assert.equal(applyUtterance(state, { ...base, version: '3', text: 'Halo semua lagi', isFinal: false }), true)
assert.equal(state.lines[0].final, true, 'A final line stays final')
assert.equal(applyUtterance(state, { ...base, version: '18446744073709551615', text: 'Versi besar' }), true, 'Versions compare as 64 bit integers')
assert.equal(applyUtterance(state, { ...base, version: '99', text: 'Tidak boleh' }), false)

assert.equal(applyUtterance(state, { ...base, participantId: 'spaces/s/devices/2', text: 'Orang lain' }), true)
assert.equal(state.lines.length, 2, 'The same event id from another participant is a separate line')
assert.equal(applyUtterance(state, { ...base, participantId: undefined, deviceId: 'spaces/s/devices/3', eventId: '11', text: 'Dari device' }), true)
assert.equal(state.lines[2].participantId, 'spaces/s/devices/3', 'deviceId stands in when participantId is absent')

applyMeetEvent(state, { event: 'roster', users: [{ id: 'spaces/s/devices/1', name: 'Rina' }, { id: 'spaces/s/devices/2', name: 'Budi' }] })
assert.equal(state.lines[0].speaker, 'Rina', 'Late roster resolves identity by id')
assert.equal(state.lines[1].speaker, 'Budi')
assert.equal(applyUtterance(state, { ...base, eventId: '12', speakerName: 'Nama Langsung', text: 'Dengan nama' }), true)
assert.equal(state.lines.at(-1).speaker, 'Nama Langsung', 'A supplied speaker name is kept')
applyMeetEvent(state, { event: 'roster', users: [{ id: 'spaces/s/devices/1', name: 'Rina Baru' }] })
assert.equal(state.lines.at(-1).speaker, 'Nama Langsung', 'A supplied name is not overwritten by roster updates')
assert.equal(state.lines[0].speaker, 'Rina Baru')

const count = state.lines.length
const rejected = [
  { ...base, source: 'zoom', eventId: '50' },
  { ...base, source: undefined, eventId: '51' },
  { ...base, meetingId: 'zzz-zzzz-zzz', eventId: '52' },
  { ...base, meetingId: '', eventId: '53' },
  { ...base, eventId: 'abc' },
  { ...base, eventId: '1'.repeat(21) },
  { ...base, eventId: '54', version: '-1' },
  { ...base, eventId: '55', participantId: '', deviceId: '' },
  { ...base, eventId: '56', text: '   ' },
  { ...base, eventId: '57', text: 'x'.repeat(10001) },
  { ...base, eventId: '58', text: 42 },
  null,
  'string',
]
for (const item of rejected) assert.equal(applyUtterance(state, item), false)
assert.equal(state.lines.length, count, 'Malformed, foreign provider, and foreign meeting events are ignored')

const future = applyUtterance(state, { ...base, eventId: '60', timestamp: Date.now() + 60000, text: 'Masa depan' })
assert.equal(future, true)
assert.ok(state.lines.at(-1).at <= Date.now(), 'Timestamps never land in the future')
assert.equal(applyUtterance(state, { ...base, eventId: '61', timestamp: 'bad', text: 'Tanpa waktu' }), true)
assert.ok(state.lines.every((l) => l.startSec <= l.endSec))

for (const line of state.lines) line.frozen = true
const beforeResume = state.lines.length
const frozenText = state.lines[0].text
assert.equal(applyUtterance(state, { ...base, version: '1', text: 'Setelah jeda' }), true)
assert.equal(state.lines.length, beforeResume + 1, 'After a pause the utterance continues on a new line')
assert.equal(state.lines[0].text, frozenText, 'Frozen lines are never revised')
assert.equal(state.lines.at(-1).text, 'Setelah jeda')

assert.equal(applyUtterance({ ...fresh(), source: 'zoom' }, { ...base, source: 'zoom' }), true, 'Isolation follows the active session source')
assert.equal(applyUtterance({ ...fresh(), startedAt: null }, base), false, 'Nothing is stored outside a session')

const native = nativeTranscript(state)
assert.equal(nativeTranscriptSchema.safeParse(native).success, true, 'Upload payload matches the backend schema')
const segments = nativeSegments(native)
assert.ok(segments.every((s) => s.provenance === 'meet-native'))
const eventTen = native.filter((l) => l.participantId === 'spaces/s/devices/1' && l.eventId === '10')
assert.equal(eventTen.length, 2, 'The frozen line and its continuation are both uploaded')
const kept = segments.filter((s) => s.participantId === 'spaces/s/devices/1' && ['Versi besar', 'Setelah jeda'].includes(s.text))
assert.deepEqual(kept.map((s) => s.text), ['Versi besar'], 'Backend keeps only the highest version per participant and event')

const noopEvent = { addListener() {} }
const service = vm.createContext({
  applyMeetEvent, applyUtterance, nativeTranscript, Date, URL, crypto: globalThis.crypto,
  chrome: {
    sidePanel: { setPanelBehavior: async () => {} },
    storage: { local: { remove: async () => {}, get: async () => ({}), set: async () => {} }, onChanged: noopEvent },
    contextMenus: { onClicked: noopEvent }, commands: { onCommand: noopEvent },
    runtime: { onInstalled: noopEvent, onMessage: noopEvent, sendMessage: async () => {} },
  },
})
vm.runInContext(readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8').replace(/^import .*\r?\n/gm, ''), service)
await vm.runInContext('ready', service)
vm.runInContext("Object.assign(state, { status: 'recording', source: 'meet', tabId: 42, sessionId: 's1', startedAt: Date.now(), lines: [] })", service)
service.batch = { type: 'meetNative', session: 's1', event: 'utterances', utterances: [base, { ...base, version: '2', text: 'Halo dua' }, { bad: true }] }
const run = (code) => vm.runInContext(code, service)
assert.equal((await run('handleServiceMessage(batch, { tab: { id: 42 }, frameId: 0 })')).ok, true)
assert.equal(run('state.lines.length'), 1)
assert.equal(run('state.lines[0].text'), 'Halo dua')
assert.equal((await run('handleServiceMessage(batch, { tab: { id: 7 }, frameId: 0 })')).ok, false, 'Other tabs are ignored')
assert.equal((await run('handleServiceMessage(batch, { tab: { id: 42 }, frameId: 2 })')).ok, false, 'Subframes are ignored')
assert.equal((await run("handleServiceMessage({ ...batch, session: 'old' }, { tab: { id: 42 }, frameId: 0 })")).ok, false, 'Stale sessions are ignored')
assert.equal((await run("handleServiceMessage({ ...batch, utterances: 'x' }, { tab: { id: 42 }, frameId: 0 })")).ok, false)
run("state.source = 'zoom'")
assert.equal((await run('handleServiceMessage(batch, { tab: { id: 42 }, frameId: 0 })')).ok, false, 'Non Meet sessions never take Meet events')
run("state.source = 'meet'; state.paused = true")
assert.equal((await run('handleServiceMessage(batch, { tab: { id: 42 }, frameId: 0 })')).ok, false, 'Paused sessions take nothing')
run('reset()')
assert.equal(run('state.utteranceMeeting'), null, 'Reset clears the meeting binding')
assert.equal(run('state.lines.length'), 0)
run("Object.assign(state, { status: 'recording', source: 'meet', tabId: 42, sessionId: 's2', startedAt: Date.now(), lines: [] })")
service.other = { type: 'meetNative', session: 's2', event: 'utterances', utterances: [{ ...base, meetingId: 'new-meet-ing' }] }
await run('handleServiceMessage(other, { tab: { id: 42 }, frameId: 0 })')
assert.equal(run('state.lines.length'), 1, 'A new session binds to its own meeting')

let sent = []
let bridgeHandler, bridgeMessageHandler
const bridge = vm.createContext({
  location: { origin: 'https://meet.google.com' }, btoa,
  chrome: {
    runtime: {
      id: 'cncnbeehgiacjoimfoapiijccfifcoha',
      sendMessage: async (m) => { sent.push(m) },
      connect: () => ({ postMessage() {}, disconnect() {}, onDisconnect: { addListener() {} } }),
      onMessage: { addListener: (fn) => { bridgeHandler = fn } },
    },
    storage: { onChanged: { addListener() {} } },
  },
  addEventListener: (type, fn) => { bridgeMessageHandler = fn },
  postMessage() {},
  setTimeout: () => 0, clearTimeout: () => {},
})
bridge.window = bridge
vm.runInContext(readFileSync(new URL('../extension/meetBridge.js', import.meta.url), 'utf8'), bridge)
bridge._deliver = (data) => bridgeMessageHandler(data)
const fromPage = (data) => {
  bridge._payload = { bridge: 'rekapin-meet-v1', ...data }
  vm.runInContext('_deliver({ source: window, origin: location.origin, data: _payload })', bridge)
}
bridgeHandler({ target: 'meetBridge', type: 'start', session: 'b1' }, {}, () => {})
fromPage({ session: 'b1', type: 'ready', peers: 1, processor: true })
fromPage({ session: 'b1', type: 'utterances', utterances: [{ ...base, text: 'y'.repeat(20000), extra: 'drop', isFinal: 'yes' }, null, ...Array(300).fill(base)] })
const forwarded = sent.find((m) => m.event === 'utterances')
assert.ok(forwarded, 'The bridge forwards utterance batches')
assert.equal(forwarded.session, 'b1')
assert.equal(forwarded.utterances.length, 199, 'Batches are capped and invalid entries dropped')
assert.equal(forwarded.utterances[0].text.length, 10000)
assert.equal(forwarded.utterances[0].extra, undefined, 'Unknown fields are stripped')
assert.equal(forwarded.utterances[0].isFinal, false, 'Only a real boolean true is final')
sent = []
fromPage({ session: 'other', type: 'utterances', utterances: [base] })
assert.equal(sent.length, 0, 'Other sessions are ignored by the bridge')

console.log('PASS: provider neutral utterance ingestion, version revisions, duplicates, identity, meeting and provider isolation, service boundaries, and bridge sanitizing (synthetic fixtures).')

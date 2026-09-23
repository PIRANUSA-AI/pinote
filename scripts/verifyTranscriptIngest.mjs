import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { applyMeetEvent, applyUtterance, claimSelfVoice, nativeTranscript } from '../extension/meetTranscript.js'
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

const chatState = fresh()
assert.equal(applyUtterance(chatState, { ...base, kind: 'chat', eventId: '10', version: '0', text: 'Ini link notulen' }), true)
assert.equal(applyUtterance(chatState, { ...base, eventId: '10', text: 'Halo' }), true, 'A chat and a caption with the same id stay separate')
assert.equal(chatState.lines.length, 2)
assert.equal(chatState.lines[0].text, 'Ini link notulen', 'Chat text is stored as written so the panel can show a badge')
assert.equal(chatState.lines[0].chat, true)
assert.equal(nativeTranscript(chatState)[0].text, 'Chat: Ini link notulen', 'The upload still marks chat for the backend')
assert.equal(applyUtterance(chatState, { ...base, kind: 'chat', eventId: '10', version: '0', text: 'Ini link notulen' }), false, 'A chat seen twice is stored once')

const selfState = { ...fresh(), meetSelfName: 'Yoel' }
applyMeetEvent(selfState, { event: 'roster', users: [], selfId: 'spaces/s/devices/9' })
assert.equal(selfState.meetSelfId, 'spaces/s/devices/9')
applyUtterance(selfState, { ...base, participantId: 'spaces/s/devices/9', text: 'Saya sendiri' })
assert.equal(selfState.lines[0].speaker, 'Yoel', 'Your own device falls back to your account name')

const native = nativeTranscript(state)
assert.equal(nativeTranscriptSchema.safeParse(native).success, true, 'Upload payload matches the backend schema')
const segments = nativeSegments(native)
assert.ok(segments.every((s) => s.provenance === 'meet-native'))
const eventTen = native.filter((l) => l.participantId === 'spaces/s/devices/1' && l.eventId === '10')
assert.equal(eventTen.length, 2, 'The frozen line and its continuation are both uploaded')
const kept = segments.filter((s) => s.participantId === 'spaces/s/devices/1' && ['Versi besar', 'Setelah jeda'].includes(s.text))
assert.deepEqual(kept.map((s) => s.text), ['Versi besar'], 'Backend keeps only the highest version per participant and event')

const noopEvent = { addListener() {} }
const tabMessages = []
const service = vm.createContext({
  applyMeetEvent, applyUtterance, claimSelfVoice, nativeTranscript, Date, URL, crypto: globalThis.crypto, setTimeout, clearTimeout,
  chrome: {
    tabs: { sendMessage: async (tabId, message) => { tabMessages.push({ tabId, message }) } },
    sidePanel: { setPanelBehavior: async () => {} },
    storage: { local: { remove: async () => {}, get: async () => ({}), set: async () => { storageWrites++ } }, onChanged: noopEvent },
    contextMenus: { onClicked: noopEvent }, commands: { onCommand: noopEvent },
    runtime: { onInstalled: noopEvent, onMessage: noopEvent, sendMessage: async () => {} },
  },
})
let storageWrites = 0
vm.runInContext(readFileSync(new URL('../extension/languageDetect.js', import.meta.url), 'utf8'), service)
vm.runInContext(readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8').replace(/^import .*\r?\n/gm, ''), service)
await vm.runInContext('ready', service)
vm.runInContext("Object.assign(state, { status: 'recording', source: 'meet', tabId: 42, sessionId: 's1', startedAt: Date.now(), lines: [] })", service)
service.batch = { type: 'meetNative', session: 's1', event: 'utterances', utterances: [base, { ...base, version: '2', text: 'Halo dua' }, { bad: true }] }
const run = (code) => vm.runInContext(code, service)
await new Promise((resolve) => setTimeout(resolve, 350))
storageWrites = 0
for (let i = 1; i <= 20; i++) {
  service.burst = { type: 'meetNative', session: 's1', event: 'utterances', utterances: [{ ...base, eventId: '900', version: String(i), text: `Revisi ${i}` }] }
  await run('handleServiceMessage(burst, { tab: { id: 42 }, frameId: 0 })')
}
assert.equal(storageWrites, 0, 'A burst of revisions is not written one by one')
await new Promise((resolve) => setTimeout(resolve, 350))
assert.equal(storageWrites, 1, 'The burst lands as one write')
assert.equal(run("state.lines.find((l) => l.captionId === '900').text"), 'Revisi 20', 'The batched write carries the latest revision')
run("state.lines = []; broadcast()")
assert.equal(storageWrites, 2, 'Urgent broadcasts still write immediately')
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
run("state.paused = false; state.lines = []; state.meetSelfId = 'spaces/s/devices/9'; state.meetStats = { localMic: true }; state.laneStats = null")
service.selfBatch = { type: 'meetNative', session: 's1', event: 'utterances', utterances: [
  { ...base, participantId: 'spaces/s/devices/9', eventId: '70', text: 'Dari CC saya' },
  { ...base, kind: 'chat', participantId: 'spaces/s/devices/9', eventId: '71', version: '0', text: 'Chat saya' },
  { ...base, participantId: 'spaces/s/devices/5', eventId: '72', text: 'Dari CC orang lain' },
] }
await run('handleServiceMessage(selfBatch, { tab: { id: 42 }, frameId: 0 })')
assert.deepEqual([...run('state.lines.map((l) => l.text)')], ['Chat saya', 'Dari CC orang lain'], 'With your mic on, Deepgram replaces Meet captions of your own voice, but chat and others stay')
run("state.laneStats = { sockets: 0, errors: 1, errorAt: Date.now() }")
await run("handleServiceMessage({ ...selfBatch, utterances: [{ ...selfBatch.utterances[0], eventId: '73', text: 'CC cadangan' }] }, { tab: { id: 42 }, frameId: 0 })")
assert.ok(run("state.lines.some((l) => l.text === 'CC cadangan')"), 'When Deepgram fails, Meet captions of your voice come back')
run("state.laneStats = null; state.meetStats = { localMic: false }")
await run("handleServiceMessage({ ...selfBatch, utterances: [{ ...selfBatch.utterances[0], eventId: '74', text: 'Mic mati' }] }, { tab: { id: 42 }, frameId: 0 })")
assert.ok(run("state.lines.some((l) => l.text === 'Mic mati')"), 'With your mic off, Meet captions are used')
run("handleOffscreenEvent({ type: 'laneFinal', participantId: 'local', text: 'Dari Deepgram', startedAt: Date.now() - 1000 })")
const deepgramLine = run("state.lines.find((l) => l.text === 'Dari Deepgram')")
assert.equal(deepgramLine.participantId, 'spaces/s/devices/9', 'Deepgram lines carry your Meet device, so names and blocks line up')

run("Object.assign(state, { lines: [], meetSelfId: null, selfSuppressed: [], meetStats: { localMic: true }, laneStats: null, meetParticipants: { 'spaces/s/devices/8': { name: 'Yoel Andreas', parentId: '' } } })")
run("handleOffscreenEvent({ type: 'laneFinal', participantId: 'local', text: 'Halo semua ini tes pertama', startedAt: Date.now() - 9000 })")
assert.equal(run("state.lines.at(-1).participantId"), 'local', 'Before your device is known, Deepgram lines use your account')
service.echoBatch = { type: 'meetNative', session: 's1', event: 'utterances', utterances: [
  { ...base, participantId: 'spaces/s/devices/8', eventId: '80', version: '3', text: 'oke deh udah udah cukup sih udah cukup thank you', timestamp: Date.now() - 4000 },
  { ...base, participantId: 'spaces/s/devices/5', eventId: '81', version: '1', text: 'aman oke sip lanjut aja', timestamp: Date.now() - 3000 },
] }
await run('handleServiceMessage(echoBatch, { tab: { id: 42 }, frameId: 0 })')
assert.equal(run('state.lines.length'), 3)
run("handleOffscreenEvent({ type: 'laneFinal', participantId: 'local', text: 'Oke deh, udah udah cukup sih, udah cukup. Thank you thank you.', startedAt: Date.now() - 5000 })")
assert.equal(run('state.meetSelfId'), 'spaces/s/devices/8', 'The Meet caption that matches your Deepgram words reveals your device')
assert.deepEqual([...run("state.lines.map((l) => l.participantId + ':' + l.text.slice(0, 12))")], [
  'spaces/s/devices/8:Halo semua i',
  'spaces/s/devices/5:aman oke sip',
  'spaces/s/devices/8:Oke deh, uda',
], 'The duplicate Meet caption is removed, and earlier Deepgram lines move to your device')
assert.equal(run('state.lines[0].speaker'), 'Yoel Andreas', 'Your lines take your Meet name')
await run("handleServiceMessage({ ...echoBatch, utterances: [{ ...echoBatch.utterances[0], version: '4', text: 'oke deh udah udah cukup sih udah cukup thank you thank you' }] }, { tab: { id: 42 }, frameId: 0 })")
assert.equal(run('state.lines.length'), 3, 'Later revisions of a removed caption never come back')

const switches = () => tabMessages.filter((m) => m.message.type === 'switchLanguage').map((m) => m.message.code)
const japanese = 'その朝の空はまだ少し曇っていたけれど、空気はひんやりと気持ちよかった。'
service.japanese = japanese
const linesBefore = run('state.lines.length')
run("state.meetStats = { autoLanguage: false, language: 'id-ID', localMic: true }")
run("handleOffscreenEvent({ type: 'languageProbe', text: japanese }); handleOffscreenEvent({ type: 'languageProbe', text: japanese })")
assert.equal(run('state.languageSuggestion'), null, 'Without auto language nothing is suggested')
run("state.meetStats = { autoLanguage: true, language: 'id-ID', localMic: true }; state.voiceLanguages = {}")
run("handleOffscreenEvent({ type: 'languageProbe', text: 'जायें' })")
run("handleOffscreenEvent({ type: 'languageProbe', text: japanese })")
assert.equal(run('state.languageSuggestion'), null, 'One sample, or samples that disagree, suggest nothing')
run("handleOffscreenEvent({ type: 'languageProbe', text: japanese })")
assert.equal(run('state.languageSuggestion.code'), 'ja-JP', 'Two Qwen samples that agree suggest Japanese')
assert.equal(run('state.languageSuggestion.source'), 'voice')
assert.equal(run('state.lines.length'), linesBefore, 'Identifier samples never become transcript lines')
run("state.languageSuggestion = null; state.dismissedLanguages = {}; state.voiceLanguages = {}")
service.mandarin = '那天早上天空还有点阴沉但空气很清爽一个小孩慢慢走向学校'
run("handleOffscreenEvent({ type: 'languageProbe', source: 'participants', text: mandarin })")
run("handleOffscreenEvent({ type: 'languageProbe', source: 'voice', text: japanese })")
assert.equal(run('state.languageSuggestion'), null, 'Evidence from your voice and from other participants is never mixed')
run("handleOffscreenEvent({ type: 'languageProbe', source: 'participants', text: mandarin })")
assert.equal(run('state.languageSuggestion.code'), 'cmn-Hans-CN', 'Two samples of Mandarin from other participants suggest Mandarin')
assert.equal(run('state.languageSuggestion.source'), 'participants')
run("state.languageSuggestion = { code: 'ja-JP', source: 'voice', at: Date.now() }")
assert.equal(switches().length, 0, 'A suggestion alone never changes Meet')
assert.equal((await run("handleServiceMessage({ type: 'switchLanguage', code: 'ja-JP' }, { tab: { id: 42 } })")).ok, false, 'Only the panel can accept a suggestion')
await run("handleServiceMessage({ type: 'switchLanguage', code: 'ja-JP' }, {})")
assert.deepEqual(switches(), ['ja-JP'], 'Accepting the suggestion tells the Meet tab to switch')
assert.equal(tabMessages.at(-1).tabId, 42)
assert.equal(run('state.languageSuggestion'), null)
service.captionOffer = { type: 'meetNative', session: 's1', event: 'languageSuggestion', code: 'en-US', reason: 'evidence' }
await run('handleServiceMessage(captionOffer, { tab: { id: 42 }, frameId: 0 })')
assert.equal(run('state.languageSuggestion.code'), 'en-US', 'Caption evidence from the page is offered too')
await run("handleServiceMessage({ type: 'dismissLanguage', code: 'en-US' }, {})")
assert.equal(run('state.languageSuggestion'), null)
await run('handleServiceMessage(captionOffer, { tab: { id: 42 }, frameId: 0 })')
assert.equal(run('state.languageSuggestion'), null, 'A dismissed language stays quiet for a while')
run("applyMeetStats({ autoLanguage: true, language: 'id-ID' }); state.languageSuggestion = { code: 'id-ID' }; applyMeetStats({ autoLanguage: true, language: 'id-ID' })")
assert.equal(run('state.languageSuggestion'), null, 'A suggestion disappears once Meet already uses that language')

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
fromPage({ session: 'b1', type: 'ready', peers: 1, captions: true })
fromPage({ session: 'b1', type: 'utterances', utterances: [{ ...base, text: 'y'.repeat(20000), extra: 'drop', isFinal: 'yes' }, null, ...Array(300).fill(base)] })
const forwarded = sent.find((m) => m.event === 'utterances')
assert.ok(forwarded, 'The bridge forwards utterance batches')
assert.equal(forwarded.session, 'b1')
assert.equal(forwarded.utterances.length, 199, 'Batches are capped and invalid entries dropped')
assert.equal(forwarded.utterances[0].text.length, 10000)
assert.equal(forwarded.utterances[0].extra, undefined, 'Unknown fields are stripped')
assert.equal(forwarded.utterances[0].isFinal, false, 'Only a real boolean true is final')
const controlsSent = []
bridge.postMessage = (message) => controlsSent.push(message)
let switchReply = null
bridgeHandler({ target: 'meetBridge', type: 'switchLanguage', code: 'ja-JP' }, {}, (reply) => { switchReply = reply })
assert.equal(switchReply.ok, true)
assert.equal(controlsSent.at(-1).type, 'switchLanguage', 'The bridge forwards a language switch to the page')
assert.equal(controlsSent.at(-1).language, 'ja-JP')
bridgeHandler({ target: 'meetBridge', type: 'switchLanguage', code: 'x;alert(1)' }, {}, (reply) => { switchReply = reply })
assert.equal(switchReply.ok, false, 'Malformed language codes are refused')
sent = []
fromPage({ session: 'b1', type: 'utterances', utterances: [{ ...base, kind: 'chat' }, { ...base, kind: 'evil' }] })
const kinds = sent.find((m) => m.event === 'utterances').utterances.map((u) => u.kind)
assert.deepEqual(kinds, ['chat', undefined], 'Only the chat kind passes the bridge')
sent = []
fromPage({ session: 'b1', type: 'roster', users: [], selfId: 'spaces/s/devices/9' })
assert.equal(sent.find((m) => m.event === 'roster').selfId, 'spaces/s/devices/9', 'The bridge forwards your own device id')
sent = []
fromPage({ session: 'other', type: 'utterances', utterances: [base] })
assert.equal(sent.length, 0, 'Other sessions are ignored by the bridge')

console.log('PASS: provider neutral utterance ingestion, version revisions, duplicates, identity, meeting and provider isolation, service boundaries, and bridge sanitizing (synthetic fixtures).')

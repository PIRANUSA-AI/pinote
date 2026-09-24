import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { applyMeetEvent, applyUtterance, claimSelfVoice, nativeTranscript } from '../extension/meetTranscript.js'
import { combineLines } from '../extension/transcriptBlocks.js'

const trackerContext = vm.createContext({})
vm.runInContext(readFileSync(new URL('../extension/captionTracker.js', import.meta.url), 'utf8'), trackerContext)
const { createCaptionTracker, isRevision, scrollOverlap } = trackerContext.RekapinCaptions

let clock = 1000
const tracker = createCaptionTracker({ now: () => clock, firstId: 500 })
const texts = (events) => Array.from(events, (e) => `${e.eventId}/${e.version}${e.isFinal ? 'F' : ''}:${e.text}`)

assert.deepEqual(texts(tracker.observe('a', 'Kosong.')), ['501/1:Kosong.'])
clock += 300
assert.deepEqual(texts(tracker.observe('a', 'Kosong. Satu.')), ['501/2:Kosong. Satu.'], 'Growing text is a revision of the same sentence')
clock += 300
assert.deepEqual(texts(tracker.observe('a', 'Kosong. Satu. Juni.')), ['501/3:Kosong. Satu. Juni.'])
assert.equal(tracker.observe('a', 'Kosong. Satu. Juni.').length, 0, 'An unchanged caption sends nothing')
clock += 300
assert.deepEqual(texts(tracker.observe('a', 'Kosong. Satu. Juli.')), ['501/4:Kosong. Satu. Juli.'], 'A corrected last word is a revision')

clock += 300
assert.deepEqual(texts(tracker.observe('a', 'Satu. Juli. Kita mulai rapatnya.')), ['501/5:Kosong. Satu. Juli. Kita mulai rapatnya.'], 'A scrolled caption keeps the words that left the box')
clock += 300
assert.deepEqual(texts(tracker.observe('a', 'Juli. Kita mulai rapatnya sekarang ya.')), ['501/6:Kosong. Satu. Juli. Kita mulai rapatnya sekarang ya.'])

clock += 300
assert.deepEqual(texts(tracker.observe('b', 'Halo semua.')), ['502/1:Halo semua.'], 'Another speaker opens their own sentence')
clock += 300
assert.deepEqual(texts(tracker.observe('a', 'Oke berikutnya soal anggaran.')), [
  '501/7F:Kosong. Satu. Juli. Kita mulai rapatnya sekarang ya.',
  '503/1:Oke berikutnya soal anggaran.',
], 'Unrelated text from the same speaker closes the old sentence and starts a new one')

clock += 2600
assert.deepEqual(texts(tracker.flush()), ['502/2F:Halo semua.', '503/2F:Oke berikutnya soal anggaran.'], 'Idle sentences are closed')
assert.equal(tracker.flush().length, 0)
assert.equal(tracker.observe('a', '   ').length, 0, 'Empty captions are ignored')
assert.equal(tracker.observe('', 'teks').length, 0, 'Captions without a speaker are ignored')

const long = createCaptionTracker({ now: () => clock, firstId: 0 })
let window = Array.from({ length: 12 }, (_, i) => `kata${i}`)
long.observe('a', window.join(' '))
let emitted = []
for (let i = 12; i < 400; i++) {
  window = [...window.slice(1), `kata${i}`]
  emitted.push(...long.observe('a', window.join(' ')))
}
emitted.push(...long.flush(true))
const finals = emitted.filter((e) => e.isFinal)
assert.ok(finals.length >= 2, 'A very long monologue is split into several lines')
const spoken = finals.map((e) => e.text).join(' ').split(' ')
assert.equal(new Set(spoken).size, spoken.length, 'Splitting a long monologue never repeats words')
assert.ok(spoken.at(-1) === 'kata399', 'The last words are kept')

assert.equal(isRevision('Halo semua apa kabar', 'Halo semua apa kabarnya'), true)
assert.equal(isRevision('Halo semua', 'Selamat pagi'), false)
assert.equal(scrollOverlap('satu dua tiga empat lima', 'tiga empat lima enam'), 3)
assert.equal(scrollOverlap('satu dua', 'dua tiga'), 0, 'Short overlaps are not trusted')

const noopEvent = { addListener() {} }
const service = vm.createContext({
  applyMeetEvent, applyUtterance, claimSelfVoice, nativeTranscript, Date, URL, crypto: globalThis.crypto, setTimeout, clearTimeout,
  chrome: {
    tabs: { sendMessage: async () => {} },
    sidePanel: { setPanelBehavior: async () => {} },
    storage: { local: { remove: async () => {}, get: async () => ({}), set: async () => {} }, onChanged: noopEvent },
    contextMenus: { onClicked: noopEvent }, commands: { onCommand: noopEvent },
    runtime: { onInstalled: noopEvent, onMessage: noopEvent, sendMessage: async () => {} },
  },
})
vm.runInContext(readFileSync(new URL('../extension/languageDetect.js', import.meta.url), 'utf8'), service)
vm.runInContext(readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8').replace(/^import .*\r?\n/gm, ''), service)
await vm.runInContext('ready', service)
const run = (code) => vm.runInContext(code, service)
const send = async (message, tabId = 42) => {
  service.message = { type: 'captionFeed', ...message }
  service.sender = { tab: { id: tabId }, frameId: 3 }
  return run('handleServiceMessage(message, sender)')
}

run("Object.assign(state, { status: 'recording', source: 'zoom', tabId: 42, startedAt: Date.now() - 60000, lines: [] })")
const utterance = (eventId, version, text, participantId = 'caption:avatar:yoel', isFinal = false) => ({ meetingId: '81234567890', eventId, version, participantId, text, isFinal, timestamp: Date.now() })

assert.equal((await send({ event: 'roster', users: [{ id: 'caption:avatar:yoel', name: 'Pembicara 1', status: 'placeholder' }] })).ok, true)
assert.equal((await send({ event: 'utterances', utterances: [utterance('1', '1', 'Kosong.'), utterance('1', '2', 'Kosong. Satu.')] })).ok, true)
assert.equal(run('state.lines.length'), 1, 'Revisions from Zoom captions update one line')
assert.equal(run('state.lines[0].text'), 'Kosong. Satu.')
assert.equal(run('state.lines[0].speaker'), 'Pembicara 1', 'Unknown speakers get a stable placeholder name')
assert.equal(run('state.attendance.length'), 0, 'Placeholders are not listed as attendees')

await send({ event: 'roster', users: [{ id: 'caption:avatar:yoel', name: 'Yoel Andreas', status: '1' }] })
assert.equal(run('state.lines[0].speaker'), 'Yoel Andreas', 'Earlier lines take the real name once it is found')
assert.equal(JSON.stringify(run('state.attendance')), '["Yoel Andreas"]')

await send({ event: 'utterances', utterances: [utterance('2', '1', 'Halo dari Budi.', 'caption:avatar:budi')] })
assert.equal(run('state.lines.length'), 2)

run("handleOffscreenEvent({ type: 'liveFinal', text: 'teks dari audio tab', speakerSource: 'tab' })")
assert.equal(run('state.lines.length'), 2, 'While captions flow, audio transcription does not add duplicate lines')
run("state.captionAt = Date.now() - 60000")
run("handleOffscreenEvent({ type: 'liveFinal', text: 'teks dari audio tab', speakerSource: 'tab' })")
assert.equal(run('state.lines.length'), 3, 'When captions stop, audio transcription takes over again')

assert.equal((await send({ event: 'utterances', utterances: [utterance('9', '1', 'dari tab lain')] }, 7)).ok, false, 'Other tabs are ignored')
assert.equal((await send({ event: 'utterances', utterances: [utterance('9', '1', 'palsu', 'spaces/x/devices/1')] })).ok, true)
assert.equal(run('state.lines.length'), 3, 'Only caption participant ids are accepted from caption pages')
assert.equal((await send({ event: 'roster', users: [{ id: 'spaces/x', name: 'Palsu' }] })).ok, true)
assert.ok(!JSON.stringify(run('state.attendance')).includes('Palsu'))
run("state.source = 'meet'")
assert.equal((await send({ event: 'utterances', utterances: [utterance('9', '1', 'meet')] })).ok, false, 'Meet sessions do not take page captions')
run("state.source = 'zoom'; state.paused = true")
assert.equal((await send({ event: 'utterances', utterances: [utterance('9', '1', 'jeda')] })).ok, false, 'Paused sessions take nothing')

const blocks = combineLines(run('state.lines'))
assert.ok(blocks.length >= 2)

console.log('PASS: page caption tracking with revisions, scrolling, long monologues, placeholders, late names, and the service caption feed (synthetic fixtures).')

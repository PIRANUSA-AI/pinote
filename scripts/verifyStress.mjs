import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { performance } from 'node:perf_hooks'
import { applyMeetEvent, applyUtterance, claimSelfVoice, nativeTranscript } from '../extension/meetTranscript.js'
import { combineLines } from '../extension/transcriptBlocks.js'
import { findActions } from '../extension/actionItems.js'
import { talkTime } from '../extension/talkTime.js'
import { transcriptMarkdown } from '../extension/transcriptMarkdown.js'

const PARTICIPANTS = 40
const EVENTS_EACH = 300
const REVISIONS = 3
const WORDS = ['kita', 'perlu', 'cek', 'laporan', 'minggu', 'ini', 'soal', 'anggaran', 'dan', 'jadwal', 'rilis', 'tolong', 'kirim', 'besok', 'oke', 'setuju']

let writes = 0
let largestWrite = 0
let panelUpdates = 0
const noopEvent = { addListener() {} }
const service = vm.createContext({
  applyMeetEvent, applyUtterance, claimSelfVoice, nativeTranscript, Date, URL, crypto: globalThis.crypto, setTimeout, clearTimeout,
  chrome: {
    tabs: { sendMessage: async () => {} },
    sidePanel: { setPanelBehavior: async () => {} },
    storage: {
      local: {
        remove: async () => {},
        get: async () => ({}),
        set: async (value) => {
          writes++
          largestWrite = Math.max(largestWrite, JSON.stringify(value).length)
        },
      },
      onChanged: noopEvent,
    },
    contextMenus: { onClicked: noopEvent }, commands: { onCommand: noopEvent },
    runtime: { onInstalled: noopEvent, onMessage: noopEvent, sendMessage: async (message) => { if (message?.target === 'panel') panelUpdates++ } },
  },
})
vm.runInContext(readFileSync(new URL('../extension/languageDetect.js', import.meta.url), 'utf8'), service)
vm.runInContext(readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8').replace(/^import .*\r?\n/gm, ''), service)
await vm.runInContext('ready', service)
vm.runInContext("Object.assign(state, { status: 'recording', source: 'meet', tabId: 42, sessionId: 's1', startedAt: Date.now() - 3600000, lines: [] })", service)

const sentence = (seed, length) => Array.from({ length }, (_, i) => WORDS[(seed * 7 + i * 3) % WORDS.length]).join(' ')
const sender = { tab: { id: 42 }, frameId: 0 }
const expected = new Map()
let batches = 0
const started = performance.now()
for (let round = 0; round < EVENTS_EACH; round++) {
  const utterances = []
  for (let p = 0; p < PARTICIPANTS; p++) {
    const eventId = String(round + 1)
    for (let v = 1; v <= REVISIONS; v++) {
      const text = `${sentence(round + p, 4 + v * 3)}.`
      utterances.push({
        source: 'meet', meetingId: 'abc', eventId, version: String(v), deviceId: `spaces/s/devices/${p}`,
        participantId: `spaces/s/devices/${p}`, speakerName: `Peserta ${p}`, text, language: 'id-ID',
        isFinal: v === REVISIONS, timestamp: Date.now(),
      })
      expected.set(`${p}|${eventId}`, text)
    }
  }
  for (let i = 0; i < utterances.length; i += 200) {
    service.batch = { type: 'meetNative', session: 's1', event: 'utterances', utterances: utterances.slice(i, i + 200) }
    service.sender = sender
    await vm.runInContext('handleServiceMessage(batch, sender)', service)
    batches++
  }
}
const ingestMs = performance.now() - started

const lines = vm.runInContext('state.lines.slice()', service)
assert.equal(lines.length, PARTICIPANTS * EVENTS_EACH, 'Every utterance ends up as exactly one line')
const wrong = lines.filter((line) => expected.get(`${line.participantId.split('/').at(-1)}|${line.captionId}`) !== line.text)
assert.equal(wrong.length, 0, 'Every line holds its latest revision')
assert.ok(lines.every((line) => line.speaker?.startsWith('Peserta ')), 'Every line keeps its speaker')
assert.ok(ingestMs < 8000, `Ingesting ${lines.length} lines stays fast (took ${Math.round(ingestMs)} ms)`)

await new Promise((resolve) => setTimeout(resolve, 2200))
writes = 0
panelUpdates = 0
const liveStarted = performance.now()
for (let i = 0; i < 60; i++) {
  service.batch = { type: 'meetNative', session: 's1', event: 'utterances', utterances: [{
    source: 'meet', meetingId: 'abc', eventId: String(EVENTS_EACH + 1), version: String(i + 1), deviceId: 'spaces/s/devices/0',
    participantId: 'spaces/s/devices/0', speakerName: 'Peserta 0', text: sentence(i, 12), language: 'id-ID', isFinal: false, timestamp: Date.now(),
  }] }
  await vm.runInContext('handleServiceMessage(batch, sender)', service)
  await new Promise((resolve) => setTimeout(resolve, 50))
}
const liveSeconds = (performance.now() - liveStarted) / 1000
assert.ok(panelUpdates <= Math.ceil(liveSeconds / 0.3) + 1, `The panel gets at most one update per 300 ms (${panelUpdates} in ${liveSeconds.toFixed(1)} s)`)
assert.ok(writes <= Math.ceil(liveSeconds / 2) + 1, `Storage is written at most once per 2 s (${writes} in ${liveSeconds.toFixed(1)} s)`)

const time = (fn) => {
  const t = performance.now()
  const result = fn()
  return [result, performance.now() - t]
}
const [entries, combineMs] = time(() => combineLines(lines))
const [, firstActionMs] = time(() => findActions(entries))
const [actions, actionMs] = time(() => findActions(entries))
const [talk, talkMs] = time(() => talkTime(lines))
const [markdown, markdownMs] = time(() => transcriptMarkdown({ entries, startedAt: Date.now() - 3600000, source: 'meet', talk, actions, attendance: [], durationMs: 3600000 }))
const [payload, payloadMs] = time(() => nativeTranscript(vm.runInContext('state', service)))

const PANEL_BUDGET_MS = 150
assert.ok(entries.length > 0 && entries.length <= lines.length)
assert.ok(actions.length > 0, 'Action items are found in a long meeting')
assert.equal(talk.length, 5)
assert.equal(payload.length, lines.length + 1, 'The upload carries every line')
assert.ok(firstActionMs < 400, `The first action scan of a long meeting is bounded (${firstActionMs.toFixed(1)} ms)`)
assert.ok(combineMs + actionMs + talkMs < PANEL_BUDGET_MS, `Per update panel work stays under ${PANEL_BUDGET_MS} ms (combine ${combineMs.toFixed(1)}, actions ${actionMs.toFixed(1)}, talk ${talkMs.toFixed(1)})`)
assert.ok(markdownMs < 500, `Markdown export of a long meeting is quick (${markdownMs.toFixed(1)} ms)`)

console.log(`STATS lines=${lines.length} batches=${batches} ingest=${Math.round(ingestMs)}ms liveWrites=${writes} livePanel=${panelUpdates} largestWrite=${(largestWrite / 1e6).toFixed(2)}MB combine=${combineMs.toFixed(1)}ms actionsFirst=${firstActionMs.toFixed(1)}ms actions=${actionMs.toFixed(1)}ms talk=${talkMs.toFixed(1)}ms markdown=${markdownMs.toFixed(1)}ms (${(markdown.length / 1e6).toFixed(2)}MB) payload=${payloadMs.toFixed(1)}ms`)
console.log('PASS: 40 participants, 12,000 lines with revisions: nothing lost, writes coalesced, panel work within budget (synthetic fixtures).')

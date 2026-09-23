import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

let clock = 1_000_000
const sockets = []
const reports = []
class FakeSocket {
  static OPEN = 1
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    this.listeners = {}
    sockets.push(this)
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn) }
  emit(type, event) {
    if (type === 'open') this.readyState = 1
    for (const fn of this.listeners[type] ?? []) fn(event)
  }
  send(data) { this.sent.push(data) }
  close() { this.readyState = 3 }
}
const noop = { addListener() {} }
const context = vm.createContext({
  Date: { now: () => clock },
  URL, Int16Array, ArrayBuffer, JSON, Math, Number, String, Map, Promise, atob, btoa,
  WebSocket: FakeSocket,
  setTimeout: () => 0,
  clearTimeout: () => {},
  chrome: { runtime: { onConnect: noop, onMessage: noop, sendMessage: async (m) => { reports.push(m) }, getURL: (p) => p } },
})
vm.runInContext(readFileSync(new URL('../extension/offscreen.js', import.meta.url), 'utf8'), context)

const frame = (value) => new Int16Array(1600).fill(value).buffer
const current = vm.runInContext(`({
  source: 'meet', language: 'auto', apiBase: 'http://localhost:3000', lanes: new Map(), paused: false, stopping: false,
  tabProbe: { startedAt: 0, lastAt: 0, loudAt: 0 }, laneFinals: 0, laneErrors: 0, laneLastError: '',
})`, context)
context.current = current
const sample = (value) => {
  context.buffer = frame(value)
  vm.runInContext('sampleParticipants(current, buffer)', context)
}
const probeSocket = () => sockets.find((s) => s.url.endsWith('/live'))
const audioSent = () => probeSocket()?.sent.filter((d) => typeof d !== 'string') ?? []

sample(0)
assert.equal(sockets.length, 0, 'Silence from other participants sends nothing')
sample(8000)
assert.equal(sockets.length, 1, 'When someone starts talking a Qwen identifier socket opens')
probeSocket().emit('open')
const start = JSON.parse(probeSocket().sent[0])
assert.equal(start.type, 'start')
assert.equal(start.engine, 'qwen')
assert.equal(start.language, 'auto')
assert.ok(probeSocket().sent.some((d) => typeof d === 'string' && JSON.parse(d).type === 'owner' && JSON.parse(d).tag.startsWith('participants|')), 'Samples are tagged as other participants')
for (let i = 0; i < 80; i++) {
  clock += 66
  sample(8000)
}
const sentDuringSpeech = audioSent().length
assert.ok(sentDuringSpeech >= 60 && sentDuringSpeech <= 82, 'About four seconds of speech plus a silent tail are sampled, then sampling stops')
const tail = audioSent().slice(-5).map((d) => new Int16Array(d).every((v) => v === 0))
assert.ok(tail.some(Boolean), 'The sample ends with silence so Qwen closes the sentence')
clock += 66
sample(8000)
assert.equal(audioSent().length, sentDuringSpeech, 'Nothing more is sent while the same speech continues')
for (let i = 0; i < 20; i++) {
  clock += 66
  sample(0)
}
clock += 1000
sample(8000)
assert.equal(audioSent().length, sentDuringSpeech, 'A new sentence within 15 seconds is not sampled again')
clock += 15000
for (let i = 0; i < 15; i++) {
  clock += 66
  sample(0)
}
sample(8000)
assert.ok(audioSent().length > sentDuringSpeech, 'After the gap the next sentence is sampled')

current.language = 'id'
const before = audioSent().length
clock += 20000
for (let i = 0; i < 15; i++) {
  clock += 66
  sample(0)
}
sample(8000)
assert.equal(audioSent().length, before, 'Only Auto language samples other participants')

probeSocket().emit('message', { data: JSON.stringify({ type: 'final', tag: 'participants|1', text: '你好' }) })
const probeReport = reports.find((r) => r.type === 'languageProbe')
assert.equal(probeReport.source, 'participants', 'Qwen results from the tab are reported as other participants')
assert.equal(reports.filter((r) => r.type === 'laneFinal').length, 0, 'Identifier results never become transcript lines')

console.log('PASS: other participants are sampled from the Meet tab for language identification, four seconds per sentence start, at most every 15 seconds, only in Auto (synthetic fixtures).')

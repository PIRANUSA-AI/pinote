import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { applyMeetEvent, applyUtterance, claimSelfVoice, nativeTranscript } from '../extension/meetTranscript.js'

function fakeIndexedDb() {
  const databases = new Map()
  const later = (fn) => setTimeout(fn, 0)

  function request(tx, produce) {
    const req = { result: undefined, onsuccess: null, onerror: null }
    tx.pending++
    later(() => {
      req.result = produce()
      req.onsuccess?.()
      tx.pending--
      tx.settle()
    })
    return req
  }

  function makeStore(tx, data) {
    return {
      put(value) { return request(tx, () => { data.rows.set(value[data.keyPath], structuredClone(value)); return value[data.keyPath] }) },
      add(value) { return request(tx, () => { const key = ++data.next; data.rows.set(key, value); return key }) },
      get(key) { return request(tx, () => data.rows.get(key)) },
      delete(key) { return request(tx, () => { data.rows.delete(key) }) },
      getAll() { return request(tx, () => [...data.rows.values()]) },
      index(name) {
        const field = data.indexes[name]
        const matching = (key) => [...data.rows].filter(([, row]) => row[field] === key).sort((a, b) => a[0] - b[0])
        return {
          getAll(key) { return request(tx, () => matching(key).map(([, row]) => row)) },
          openKeyCursor(range) {
            const keys = matching(range.only).map(([primary]) => primary)
            const req = { result: null, onsuccess: null }
            let position = 0
            const step = () => {
              tx.pending++
              later(() => {
                req.result = position < keys.length ? { primaryKey: keys[position++], continue: step } : null
                req.onsuccess?.()
                tx.pending--
                tx.settle()
              })
            }
            step()
            return req
          },
        }
      },
    }
  }

  return {
    open(name) {
      const req = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null }
      later(() => {
        const fresh = !databases.has(name)
        if (fresh) databases.set(name, new Map())
        const stores = databases.get(name)
        const db = {
          createObjectStore(storeName, options = {}) {
            const data = { rows: new Map(), keyPath: options.keyPath, next: 0, indexes: {} }
            stores.set(storeName, data)
            return { createIndex(indexName, field) { data.indexes[indexName] = field } }
          },
          transaction(names) {
            const tx = {
              pending: 0, done: false, oncomplete: null, onerror: null, onabort: null,
              settle() { later(() => { if (!tx.done && tx.pending === 0) { tx.done = true; tx.oncomplete?.() } }) },
              objectStore(storeName) { return makeStore(tx, stores.get(storeName)) },
            }
            tx.settle()
            return tx
          },
        }
        req.result = db
        if (fresh) req.onupgradeneeded?.()
        req.onsuccess?.()
      })
      return req
    },
  }
}

const store = vm.createContext({ indexedDB: fakeIndexedDb(), IDBKeyRange: { only: (value) => ({ only: value }) }, Date, structuredClone, setTimeout })
vm.runInContext(readFileSync(new URL('../extension/recoveryStore.js', import.meta.url), 'utf8'), store)
const recovery = store.RekapinRecovery

await recovery.begin({ id: 'a', mime: 'audio/webm', source: 'meet', language: 'id', skipInsights: false, apiBase: 'http://api' })
await recovery.begin({ id: 'b', mime: 'audio/webm', source: 'zoom', language: 'en', skipInsights: true, apiBase: 'http://api' })
await Promise.all(['satu', 'dua', 'tiga'].map((part) => recovery.append('a', part)))
await recovery.append('b', 'lain')

const loaded = await recovery.load('a')
assert.deepEqual(loaded.chunks, ['satu', 'dua', 'tiga'], 'Chunks come back in the order they were recorded')
assert.equal(loaded.source, 'meet')
assert.equal(typeof loaded.createdAt, 'number')
assert.equal(await recovery.load('nothing'), null, 'An unknown recording loads as nothing')
assert.equal(await recovery.load(undefined), null)

await recovery.drop('a')
assert.equal(await recovery.load('a'), null, 'A dropped recording is gone')
assert.deepEqual((await recovery.load('b')).chunks, ['lain'], 'Dropping one recording keeps the others')

const realNow = Date.now
store.Date = { now: () => realNow() + 4 * 24 * 60 * 60 * 1000 }
await recovery.prune(['b'])
assert.ok(await recovery.load('b'), 'Prune keeps the recording it was told to keep')
await recovery.prune([])
assert.equal(await recovery.load('b'), null, 'Recordings older than three days are pruned')
store.Date = Date

const noopEvent = { addListener() {} }
const offscreenMessages = []
let offscreenReply = { ok: true }
const service = vm.createContext({
  applyMeetEvent, applyUtterance, claimSelfVoice, nativeTranscript, Date, URL, crypto: globalThis.crypto, setTimeout, clearTimeout,
  readConfig: async () => ({ apiBase: 'http://api' }),
  chrome: {
    tabs: { sendMessage: async () => {} },
    sidePanel: { setPanelBehavior: async () => {} },
    offscreen: { hasDocument: async () => true, createDocument: async () => {}, closeDocument: async () => {} },
    storage: { local: { remove: async () => {}, get: async () => ({}), set: async () => {} }, onChanged: noopEvent },
    contextMenus: { onClicked: noopEvent }, commands: { onCommand: noopEvent },
    runtime: {
      onInstalled: noopEvent, onMessage: noopEvent,
      sendMessage: async (message) => {
        if (message.target !== 'offscreen') return undefined
        offscreenMessages.push(message)
        return offscreenReply
      },
    },
  },
})
vm.runInContext(readFileSync(new URL('../extension/languageDetect.js', import.meta.url), 'utf8'), service)
vm.runInContext(readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8').replace(/^import .*\r?\n/gm, ''), service)
await vm.runInContext('ready', service)
const run = (code) => vm.runInContext(code, service)

run("Object.assign(state, { status: 'starting', source: 'meet', startedAt: Date.now(), lines: [] })")
run("handleOffscreenEvent({ type: 'captureStarted', recoveryId: 'rec1' })")
assert.equal(run('state.recoveryId'), 'rec1', 'The recording id is remembered while starting')
run("state.status = 'recording'")
run("handleOffscreenEvent({ type: 'captureStarted', recoveryId: 'other' })")
assert.equal(run('state.recoveryId'), 'rec1', 'A late start report cannot replace the id of a running session')

run("Object.assign(state, { status: 'interrupted', attendance: ['Rina'] })")
const blocked = await run("handleServiceMessage({ type: 'start', tabId: 1, source: 'meet' })")
assert.equal(blocked.ok, false, 'A new session cannot start over an interrupted recording that still has audio')
assert.equal(offscreenMessages.length, 0)

offscreenReply = { ok: false, error: 'sibuk' }
const busy = await run("handleServiceMessage({ type: 'recoverUpload' })")
assert.equal(busy.ok, false)
assert.equal(run('state.recoveryId'), 'rec1', 'A temporary failure keeps the stored audio for another try')
assert.equal(run('state.status'), 'interrupted')

offscreenReply = { ok: true }
const sent = await run("handleServiceMessage({ type: 'recoverUpload' })")
assert.equal(sent.ok, true)
assert.equal(run('state.status'), 'uploading', 'Sending the stored audio moves the panel to uploading')
const recoverCall = offscreenMessages.at(-1)
assert.equal(recoverCall.type, 'recoverUpload')
assert.equal(recoverCall.recoveryId, 'rec1')
assert.equal(JSON.stringify(recoverCall.attendance), '["Rina"]')
assert.ok(Array.isArray(recoverCall.nativeTranscript), 'Meet recoveries carry the transcript captured so far')

run("handleOffscreenEvent({ type: 'uploadStatus', status: 'done', jobId: 'job9' })")
assert.equal(run('state.status'), 'done')
assert.equal(run('state.recoveryId'), null, 'A delivered recording forgets its stored audio')

run("Object.assign(state, { status: 'interrupted', recoveryId: 'rec2' })")
offscreenReply = { ok: false, missing: true, error: 'tidak tersimpan' }
await run("handleServiceMessage({ type: 'recoverUpload' })")
assert.equal(run('state.recoveryId'), null, 'Missing audio is forgotten so the panel stops offering to send it')
assert.equal(run('state.error'), 'tidak tersimpan')

console.log('PASS: recording recovery store ordering, isolation, pruning, and the service recover flow (synthetic fixtures).')

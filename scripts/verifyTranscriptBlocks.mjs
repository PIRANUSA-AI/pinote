import assert from 'node:assert/strict'
import { canJoinText, combineLines } from '../extension/transcriptBlocks.js'
import { nativeSegments } from '../backend/dist/lib/nativeTranscript.js'

const yoel = 'spaces/s/devices/1'
const other = 'spaces/s/devices/2'
const pieces = [
  [0, 'Halo testing.'],
  [16, 'arsitekturnya gue bayangin user pilih kandidat bahasa yang mungkin muncul di'],
  [21, 'meeting ya Misalnya Indonesia Inggris sama Mandarin dan defaultnya tetap bahasa'],
  [26, 'Indonesia dan setiap caption masuk kemungkinan bahasanya untuk Mandarin ada'],
  [31, 'sinyal tabrakan yang kuat karena script bisa dideteksi langsung sedangkan'],
  [39, 'Inggris'],
]
const line = (sec, text, participantId = yoel, extra = {}) => ({
  at: 1_000_000 + sec * 1000, endAt: 1_000_000 + sec * 1000 + 4000, participantId, speaker: participantId === yoel ? 'Yoel' : 'Rina',
  provenance: 'meet-native', text, ...extra,
})

const blocks = combineLines(pieces.map(([sec, text]) => line(sec, text)))
assert.equal(blocks.length, 2, 'A long reading becomes one block after the opening greeting')
assert.equal(blocks[0].text, 'Halo testing.')
assert.ok(blocks[1].text.startsWith('arsitekturnya gue bayangin') && blocks[1].text.endsWith('sedangkan Inggris'))
assert.equal(blocks[1].speaker, 'Yoel')
assert.equal(blocks[1].at, 1_016_000, 'A block starts at its first piece')

assert.equal(combineLines([line(0, 'satu'), line(11, 'dua')]).length, 2, 'A gap of 10 seconds or more starts a new block')
assert.equal(combineLines([line(0, 'satu'), line(5, 'dua', other)]).length, 2, 'Another speaker starts a new block')
assert.equal(combineLines([line(0, 'satu'), line(3, 'Link', yoel, { chat: true })]).length, 2, 'Chat never merges with speech')
assert.equal(combineLines([line(0, 'satu', yoel, { provenance: undefined }), line(3, 'dua', yoel, { provenance: undefined })]).length, 2, 'Only Meet native lines are merged')

const words = (n) => Array.from({ length: n }, (_, i) => `kata${i}`).join(' ')
assert.equal(canJoinText('tanpa titik', 'apa saja'), true, 'An open sentence always continues')
assert.equal(canJoinText(`${words(30)}.`, 'lanjut'), true, 'A short finished block takes an open piece')
assert.equal(canJoinText(`${words(40)}.`, 'lanjut'), false, 'A long finished block does not take an open piece')
assert.equal(canJoinText(`${words(40)}.`, `${words(30)}.`), true, 'Two finished sentences join under 75 words')
assert.equal(canJoinText(`${words(50)}.`, `${words(30)}.`), false, 'Two finished sentences stop at 75 words')

const native = pieces.map(([sec, text], i) => ({ participantId: yoel, name: 'Yoel', text, start: sec, end: sec + 4, eventId: String(i + 1), version: '3' }))
native.push({ participantId: yoel, name: 'Yoel', text: 'Chat: ini linknya', start: 41, end: 41, eventId: '99', version: '0' })
native.push({ participantId: other, name: 'Rina', text: 'Oke siap', start: 42, end: 44, eventId: '7', version: '1' })
const segments = nativeSegments(native)
assert.deepEqual(segments.map((s) => s.speaker), ['Yoel', 'Yoel', 'Yoel', 'Rina'], 'The final transcript is merged the same way')
assert.equal(segments[1].start, '0:16')
assert.equal(segments[1].end, '0:43', 'A merged segment ends where its last piece ends')
assert.equal(segments[2].text, 'Chat: ini linknya', 'Chat stays its own segment')

console.log('PASS: Meet caption pieces merge per speaker like the reference (10 second gap, sentence and word limits, chat kept apart) in the panel and the final transcript (synthetic fixtures).')

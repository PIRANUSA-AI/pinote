import assert from 'node:assert/strict'
import { actionSentences, findActions } from '../extension/actionItems.js'

const tasks = [
  'Nanti saya kirim laporannya hari Jumat.',
  'Tolong cek lagi dokumen proposalnya ya.',
  'Jangan lupa update progress di board sebelum rapat besok.',
  'Budi, kamu yang bikin presentasinya ya.',
  'Pak Andi tolong kabari klien soal jadwalnya.',
  'Deadline revisi desainnya minggu depan.',
  'Gue bakal beresin bug login nanti malam.',
  "I'll send the invoice tomorrow.",
  'Can you prepare the draft by Friday?',
  'Kita perlu jadwalkan ulang demo sama tim sales.',
]
for (const sentence of tasks) assert.equal(actionSentences(sentence).length, 1, `Should be a task: ${sentence}`)

const chatter = [
  'Halo semua, apa kabar?',
  'Iya setuju, kemarin juga begitu.',
  'Tadi malam hujan deras banget di rumah saya.',
  'Oke oke.',
  'Menurut saya desainnya sudah bagus kok.',
  'Terima kasih ya semuanya.',
  'Sebelum mulai, suaranya kedengeran kan?',
]
for (const sentence of chatter) assert.equal(actionSentences(sentence).length, 0, `Should not be a task: ${sentence}`)

const mixed = actionSentences('Oke jadi begitu ya. Nanti aku cek ulang angkanya besok pagi. Makasih semua!')
assert.deepEqual(mixed, ['Nanti aku cek ulang angkanya besok pagi.'], 'Only the task sentence is picked from a longer line')

assert.deepEqual(actionSentences(''), [])
assert.deepEqual(actionSentences(undefined), [])
assert.ok(actionSentences(`Tolong kirim ${'kata '.repeat(40)}besok.`)[0].length <= 240, 'Long sentences are shortened')

const entries = [
  { speaker: 'Rina', at: 1000, text: 'Halo semua.' },
  { speaker: 'Budi', at: 2000, text: 'Nanti saya kirim notulennya besok.' },
  null,
  { speaker: 'Rina', at: 3000, text: 'Tolong cek link ini ya, jangan lupa isi formnya hari ini.', chat: true },
]
const found = findActions(entries)
assert.equal(found.length, 2)
assert.equal(found[0].index, 1, 'Each task points back to its transcript line')
assert.equal(found[0].speaker, 'Budi')
assert.equal(found[1].index, 3, 'Tasks written in chat count too')
assert.equal(findActions(Array.from({ length: 50 }, () => ({ text: 'Tolong kirim laporannya besok.' })), 30).length, 30, 'Only the latest tasks are kept')
assert.deepEqual(findActions(undefined), [])

console.log('PASS: live action item detection for Indonesian and English sentences (synthetic fixtures).')

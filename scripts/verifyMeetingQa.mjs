import assert from 'node:assert/strict'

const { askMeeting, selectContext } = await import('../backend/dist/services/meetingQa.js')

const segment = (i, speaker, text) => ({ start: `00:${String(i).padStart(2, '0')}`, end: `00:${String(i + 1).padStart(2, '0')}`, speaker, text })
const short = [
  segment(0, '0', 'Halo semua, kita mulai.'),
  segment(1, '1', 'Anggaran kuartal ini naik sepuluh persen.'),
  segment(2, '0', 'Oke, Budi tolong kirim laporan anggaran hari Jumat.'),
]

let seen = null
const answer = await askMeeting({
  segments: short,
  question: 'Siapa yang kirim laporan anggaran?',
  speakerNames: { 0: 'Rina', 1: 'Budi' },
  title: 'Evaluasi Anggaran',
  complete: async (messages) => {
    seen = messages
    return { answer: 'Budi yang mengirim laporannya hari Jumat [2].', found: true, citations: [2, '1', 99, 2] }
  },
})
assert.ok(seen[1].content.includes('[2] 00:02 Rina: Oke, Budi tolong'), 'Segments are numbered and use renamed speakers')
assert.ok(seen[1].content.includes('Judul rapat: Evaluasi Anggaran'))
assert.equal(answer.answer, 'Budi yang mengirim laporannya hari Jumat.', 'Segment numbers are stripped from the answer text')
assert.deepEqual(answer.citations.map((c) => c.index), [2, 1], 'Citations are deduplicated and limited to segments that were actually sent')
assert.equal(answer.citations[0].speaker, 'Rina')
assert.equal(answer.found, true)

const missing = await askMeeting({ segments: short, question: 'Kapan liburan kantor?', complete: async () => ({ answer: 'Hal itu tidak dibahas di rapat ini.', found: false, citations: [] }) })
assert.equal(missing.found, false)
assert.equal(missing.citations.length, 0)

await assert.rejects(askMeeting({ segments: short, question: 'apa?', complete: async () => ({ nope: true }) }), /tidak valid/)

const long = Array.from({ length: 2000 }, (_, i) => segment(i % 60, String(i % 4), i === 1500 ? 'Kita putuskan vendor server pindah ke Jakarta mulai Oktober.' : `Obrolan umum nomor ${i} tentang hal lain yang panjang sekali supaya transkripnya besar.`))
const picked = selectContext(long, 'vendor server pindah kemana?', {}, 24000)
assert.ok(picked.includes(1500), 'The relevant segment of a long meeting is kept')
assert.ok(picked.includes(1498) && picked.includes(1502), 'Neighbors are kept for context')
assert.ok(picked.length < long.length, 'Long meetings are trimmed to fit')
assert.deepEqual(picked, [...picked].sort((a, b) => a - b), 'Selected segments stay in meeting order')
assert.equal(selectContext(short, 'apa saja').length, 3, 'Short meetings are sent whole')

console.log('PASS: meeting questions with numbered context, validated citations, and long meeting retrieval (synthetic fixtures).')

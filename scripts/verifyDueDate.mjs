import assert from 'node:assert/strict'

const { parseDue } = await import('../backend/dist/lib/dueDate.js')

const thursday = new Date('2026-09-24T03:42:00Z')
const cases = [
  ['hari ini', '2026-09-24'],
  ['EOD', '2026-09-24'],
  ['nanti sore', '2026-09-24'],
  ['besok', '2026-09-25'],
  ['Besok pagi jam 9', '2026-09-25'],
  ['lusa', '2026-09-26'],
  ['tomorrow', '2026-09-25'],
  ['Jumat', '2026-09-25'],
  ["Jum'at", '2026-09-25'],
  ['hari Senin', '2026-09-28'],
  ['Kamis', '2026-10-01'],
  ['Jumat depan', '2026-10-02'],
  ['next Monday', '2026-09-28'],
  ['minggu depan', '2026-10-01'],
  ['pekan depan', '2026-10-01'],
  ['akhir minggu', '2026-09-25'],
  ['akhir bulan', '2026-09-30'],
  ['2 hari lagi', '2026-09-26'],
  ['dalam 3 hari', '2026-09-27'],
  ['seminggu lagi', '2026-10-01'],
  ['2 minggu lagi', '2026-10-08'],
  ['sebulan lagi', '2026-10-24'],
  ['26 September', '2026-09-26'],
  ['30 Sep 2026', '2026-09-30'],
  ['5 Januari', '2027-01-05'],
  ['tanggal 30', '2026-09-30'],
  ['tanggal 3', '2026-10-03'],
  ['26/9', '2026-09-26'],
  ['1/10/2026', '2026-10-01'],
  ['2026-11-02', '2026-11-02'],
  ['bulan depan', '2026-10-24'],
]
for (const [text, expected] of cases) assert.equal(parseDue(text, thursday), expected, `"${text}" should be ${expected}`)

for (const text of ['secepatnya', 'ASAP', 'setelah rapat klien', '', null, undefined, 'jam 15.30', '31/2']) {
  assert.equal(parseDue(text, thursday), null, `"${text}" has no concrete date`)
}

const lateEvening = new Date('2026-09-24T18:30:00Z')
assert.equal(parseDue('besok', lateEvening), '2026-09-26', 'Dates follow Jakarta time, where 18.30 UTC is already Friday')
assert.equal(parseDue('besok', new Date('invalid')), null)

console.log('PASS: due text to calendar dates in Jakarta time for Indonesian and English phrases (synthetic fixtures).')

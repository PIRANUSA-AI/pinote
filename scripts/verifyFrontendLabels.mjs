import assert from 'node:assert/strict'

let segmentMarks
let dueStatus
try {
  ({ segmentMarks } = await import('../frontend/src/lib/highlights.ts'))
  ;({ dueStatus } = await import('../frontend/src/lib/due.ts'))
} catch (err) {
  if (err?.code !== 'ERR_UNKNOWN_FILE_EXTENSION') throw err
  console.log(`SKIP: Node ${process.versions.node} cannot load TypeScript directly, frontend label tests need Node 23.6 or newer.`)
  process.exit(0)
}

const has = (text, kind) => segmentMarks(text).has(kind)

for (const text of [
  'Oke jadi kita putuskan pakai vendor lokal.',
  'Berarti sudah disepakati ya, rilisnya Oktober.',
  'Keputusannya kita tunda dulu sampai data lengkap.',
  'Oke kita pakai desain yang kedua.',
  'Deal ya, harga segitu.',
  "We're going with the second option.",
]) assert.ok(has(text, 'decision'), `Decision: ${text}`)

for (const text of [
  'Tolong fix bug login hari ini.',
  'Saya belum setuju sih sebenarnya.',
  'Halo semua, apa kabar?',
]) assert.ok(!has(text, 'decision'), `Not a decision: ${text}`)

assert.ok(has('Jadi siapa yang pegang anggaran bulan depan?', 'question'))
assert.ok(!has('Oke?', 'question'), 'Short filler questions are not marked')
assert.ok(!has('Kita lanjut ke agenda berikutnya.', 'question'))

const now = new Date('2026-09-24T05:00:00Z')
assert.deepEqual(dueStatus('2026-09-24', 'hari ini', false, now), { label: 'Tenggat hari ini', tone: 'soon' })
assert.deepEqual(dueStatus('2026-09-25', 'besok', false, now), { label: 'Tenggat besok', tone: 'soon' })
assert.equal(dueStatus('2026-09-23', 'kemarin', false, now).label, 'Lewat sejak kemarin')
assert.equal(dueStatus('2026-09-20', null, false, now).label, 'Lewat 4 hari')
assert.equal(dueStatus('2026-09-20', null, false, now).tone, 'overdue')
assert.ok(dueStatus('2026-09-28', 'Senin', false, now).label.startsWith('Tenggat Senin'), 'This week shows the weekday')
assert.equal(dueStatus('2026-09-20', null, true, now).tone, 'done', 'Finished tasks are never shown as late')
assert.deepEqual(dueStatus(null, 'secepatnya', false, now), { label: 'Tenggat: secepatnya', tone: 'normal' }, 'Text without a date is shown as said')
assert.equal(dueStatus(null, '  ', false, now), null)
assert.equal(dueStatus('2026-09-24', null, false, new Date('2026-09-24T17:30:00Z')).label, 'Lewat sejak kemarin', 'Today follows Jakarta time')

console.log('PASS: transcript decision and question marks, and due labels in Jakarta time (synthetic fixtures).')

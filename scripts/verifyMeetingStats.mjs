import assert from 'node:assert/strict'

const { aggregateMeetingStats } = await import('../backend/dist/lib/meetingStats.js')

const seg = (speaker, start, end) => ({ speaker, start, end, text: 'x' })
const stats = aggregateMeetingStats(
  [
    { segments: [seg('0', '00:00', '01:00'), seg('1', '01:00', '01:30'), seg('Rina', '01:30', '02:00')], speakerNames: { 0: 'Rina Sari', 1: 'Budi' } },
    { segments: [seg('Rina Sari', '00:00', '00:30'), seg('Pembicara 2', '00:30', '05:00'), seg('Peserta', '05:00', '06:00'), seg('Budi', '06:00', '1:00:00')], speakerNames: {} },
  ],
  [
    { owner: 'Budi', done: false },
    { owner: 'budi', done: true },
    { owner: 'Rina Sari', done: false },
    { owner: 'Unassigned', done: false },
  ],
)

assert.equal(stats.meetings, 2)
const rina = stats.speakers.find((s) => s.name === 'Rina Sari')
assert.equal(rina.seconds, 90, 'Renamed diarization labels count under the real name, across meetings')
assert.equal(rina.meetings, 2)
const budi = stats.speakers.find((s) => s.name === 'Budi')
assert.equal(budi.seconds, 30 + 180, 'A single runaway segment is capped')
assert.ok(!stats.speakers.some((s) => /Pembicara|Peserta|^\d+$/.test(s.name)), 'Placeholder labels are not counted as people')
assert.equal(stats.speakers.reduce((sum, s) => sum + s.share, 0) >= 99, true)
assert.deepEqual(stats.owners.map((o) => [o.name, o.open, o.done]), [['Budi', 1, 1], ['Rina Sari', 1, 0]], 'Task owners are merged case insensitively and placeholders dropped')
assert.deepEqual(aggregateMeetingStats([], []), { meetings: 0, speakers: [], owners: [] })

console.log('PASS: meeting talk time and task owner statistics across meetings (synthetic fixtures).')

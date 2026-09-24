import assert from 'node:assert/strict'

const { applyLiveLines, cleanLiveLine, publicLiveView, LIVE_SHARE_MAX_LINES } = await import('../backend/dist/lib/liveShare.js')

const line = (text, speaker = 'Rina') => ({ text, speaker, at: 1 })
let state = { userId: 'u', title: 'Sync', source: 'meet', startedAt: 'a', updatedAt: 'a', endedAt: null, base: 0, lines: [] }

state = applyLiveLines(state, 0, [line('satu'), line('dua')], 2)
assert.deepEqual(state.lines.map((l) => l.text), ['satu', 'dua'])
state = applyLiveLines(state, 1, [line('dua revisi'), line('tiga')], 3)
assert.deepEqual(state.lines.map((l) => l.text), ['satu', 'dua revisi', 'tiga'], 'Revised lines replace from the first change onward')
state = applyLiveLines(state, 0, [line('satu')], 3)
assert.deepEqual(state.lines.map((l) => l.text), ['satu', 'dua revisi', 'tiga'], 'A chunk that covers only part of the tail keeps the lines after it')
state = applyLiveLines(state, 0, [], 0)
assert.equal(state.lines.length, 0, 'A reset empties the shared transcript')

for (let i = 0; i < LIVE_SHARE_MAX_LINES + 50; i += 500) {
  const batch = Array.from({ length: Math.min(500, LIVE_SHARE_MAX_LINES + 50 - i) }, (_, k) => line(`baris ${i + k}`))
  state = applyLiveLines(state, i, batch, i + batch.length)
}
assert.equal(state.lines.length, LIVE_SHARE_MAX_LINES, 'Only the latest lines are kept')
assert.equal(state.base, 50)
assert.equal(state.lines[0].text, 'baris 50')
state = applyLiveLines(state, 10, [line('terlalu lama')], LIVE_SHARE_MAX_LINES + 50)
assert.equal(state.lines[0].text, 'baris 50', 'Changes to lines that were already dropped do not shift the rest')

const view = publicLiveView(state, LIVE_SHARE_MAX_LINES + 40)
assert.equal(view.from, LIVE_SHARE_MAX_LINES + 40)
assert.equal(view.lines.length, 10, 'Viewers only download lines they do not have yet')
assert.equal(view.total, LIVE_SHARE_MAX_LINES + 50)
assert.equal(publicLiveView(state, 0).from, 50, 'A viewer that is too far behind starts at the oldest kept line')
assert.ok(!('userId' in view), 'The owner id is never exposed to viewers')

assert.equal(cleanLiveLine({ text: '  ' }), null)
assert.equal(cleanLiveLine(null), null)
assert.deepEqual(cleanLiveLine({ text: ' halo ', speaker: 'Budi', at: 5, chat: true, extra: 'x' }), { text: 'halo', speaker: 'Budi', at: 5, chat: true })

console.log('PASS: live transcript sharing merge, trimming, viewer paging, and sanitizing (synthetic fixtures).')

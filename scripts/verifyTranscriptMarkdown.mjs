import assert from 'node:assert/strict'
import { escapeMarkdown, markdownClock, markdownFilename, transcriptMarkdown } from '../extension/transcriptMarkdown.js'

const startedAt = new Date(2026, 8, 24, 9, 30).getTime()
const entries = [
  { speaker: 'Rina', participantId: 'p1', at: startedAt + 5000, text: 'Halo semua.' },
  { speaker: 'Rina', participantId: 'p1', at: startedAt + 9000, text: 'Kita mulai ya.' },
  { speaker: 'Budi', participantId: 'p2', at: startedAt + 65000, text: '# bukan judul, *bukan tebal* dan <b>tag</b>' },
  { speaker: 'Budi', participantId: 'p2', at: startedAt + 70000, text: 'Ini link notulen', chat: true },
  { speaker: 'Rina', participantId: 'p1', at: startedAt + 3725000, text: '   ' },
]

const md = transcriptMarkdown({
  entries,
  startedAt,
  source: 'meet',
  attendance: ['Rina', 'Budi_Santoso'],
  talk: [{ name: 'Rina', seconds: 75, share: 60 }, { name: 'Budi', seconds: 50, share: 40 }],
  actions: [{ speaker: 'Budi', at: startedAt + 65000, text: 'Nanti saya kirim laporannya besok.' }],
  durationMs: 3725000,
})

assert.ok(md.startsWith('# Rapat Google Meet\n'), 'The title names the meeting type')
assert.ok(md.includes('* Durasi: 1:02:05'), 'Long meetings show hours')
assert.ok(md.includes('* Hadir: Rina, Budi\\_Santoso'), 'Names are escaped')
assert.ok(md.includes('* Rina: 1m 15d (60%)'), 'Talk time is listed')
assert.ok(md.includes('* [ ] Nanti saya kirim laporannya besok. (Budi, 01:05)'), 'Tasks become checkboxes with who and when')
assert.ok(md.includes('**Rina** · 00:05  \nHalo semua.  \nKita mulai ya.\n'), 'Lines from the same speaker stay under one name')
assert.equal(md.match(/\*\*Rina\*\*/g).length, 1, 'An empty trailing line does not open a new block')
assert.ok(md.includes('**Budi** · 01:05  \n\\# bukan judul, \\*bukan tebal\\* dan \\<b\\>tag\\</b\\>'), 'Transcript text cannot inject Markdown')
assert.ok(md.includes('**Budi** (chat) · 01:10  \nIni link notulen'), 'Chat after speech from the same person starts its own block')

const bare = transcriptMarkdown({ entries: [], startedAt: null, source: 'zoom', now: startedAt })
assert.ok(bare.startsWith('# Rapat Zoom'))
assert.ok(!bare.includes('## Tugas'), 'Empty sections are left out')
assert.ok(!bare.includes('## Waktu bicara'))
assert.ok(!bare.includes('Durasi'))

assert.equal(markdownClock(0), '00:00')
assert.equal(markdownClock(61000), '01:01')
assert.equal(escapeMarkdown('1. bukan daftar'), '1\\. bukan daftar')
assert.equal(escapeMarkdown('- bukan poin'), '\\- bukan poin')
assert.equal(markdownFilename(startedAt), 'rekapin_20260924_0930.md')

console.log('PASS: transcript Markdown export with grouping, sections, and escaping (synthetic fixtures).')

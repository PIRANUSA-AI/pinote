import assert from 'node:assert/strict'
import { talkTime } from '../extension/talkTime.js'
import { publicError } from '../backend/dist/lib/publicError.js'

const line = (speaker, startSec, endSec, text, extra = {}) => ({ speaker, startSec, endSec, text, identityResolved: true, ...extra })

const result = talkTime([
  line('Rina', 0, 30, 'satu dua tiga'),
  line('Budi', 30, 40, 'halo'),
  line('Rina', 40, 70, 'lagi'),
  line('Budi', 70, 70, Array(50).fill('kata').join(' ')),
  line('Chat', 0, 0, 'pesan', { chat: true }),
  line('Identitas belum tersedia', 0, 100, 'tanpa nama', { identityResolved: false }),
  line('Kosong', 0, 10, '   '),
  { speaker: 'Rusak', text: 7 },
  null,
])
assert.deepEqual(result.map((r) => r.name), ['Rina', 'Budi'], 'Chat, unresolved, empty, and malformed lines do not count')
assert.equal(result[0].seconds, 60)
assert.equal(result[1].seconds, 30, 'Short caption spans fall back to a word based estimate')
assert.equal(result[0].share + result[1].share, 100)
assert.equal(talkTime([line('Lama', 0, 10000, 'x')])[0].seconds, 120, 'A single stuck line is capped')
assert.deepEqual(talkTime([]), [])
assert.deepEqual(talkTime(undefined), [])
assert.equal(talkTime(Array.from({ length: 9 }, (_, i) => line(`P${i}`, 0, i + 1, 'a'))).length, 5, 'Only the top speakers are listed')

assert.equal(publicError('Deepgram failed (502): upstream', 'umum'), 'umum')
assert.equal(publicError('DEEPGRAM_API_KEY is required', 'umum'), 'umum')
assert.equal(publicError('OpenAI realtime menolak koneksi (401)', 'umum'), 'umum')
assert.equal(publicError('Qwen menolak koneksi (403)', 'umum'), 'umum')
assert.equal(publicError('GLM_API_KEY is required', 'umum'), 'umum')
assert.equal(publicError('   ', 'umum'), 'umum')
assert.equal(publicError('Batas durasi sesi realtime tercapai', 'umum'), 'umum')
assert.equal(publicError('Tidak ada transkrip Meet yang tertangkap.', 'umum'), 'Tidak ada transkrip Meet yang tertangkap.', 'Our own messages pass through')

console.log('PASS: talk time per speaker and public error filtering (synthetic fixtures).')

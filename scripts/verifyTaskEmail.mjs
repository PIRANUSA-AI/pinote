import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'

delete process.env.APP_URL
const { renderTaskDigest, fallbackMeetingTitle, meetingMoment, escapeHtml } = await import('../backend/dist/services/email.js')

const meetingAt = new Date('2026-09-24T03:42:00Z')
const many = renderTaskDigest({
  to: 'yoel@contrivent.com',
  assigneeName: 'Yoel Ganteng',
  meetingTitle: 'Evaluasi Fitur Extension Rekapin',
  meetingAt,
  jobId: 'job_123',
  tasks: [
    { taskTitle: 'Implementasikan mode fokus untuk panel rekaman', due: 'Jumat, 26 September' },
    { taskTitle: 'Simpan audio lokal untuk pemulihan <script>alert(1)</script>' },
    { taskTitle: 'Deteksi tugas & tandai di transkrip', due: '' },
  ],
})

assert.equal(many.subject, '3 tugas baru dari Evaluasi Fitur Extension Rekapin')
assert.ok(many.html.includes('Ada 3 tugas baru untukmu'))
assert.ok(many.html.includes('Halo Yoel, '), 'Greets by first name')
assert.ok(many.html.includes('Kamis, 24 September 2026, 10.42 WIB') || many.html.includes('Kamis, 24 September 2026, 10:42 WIB'), 'Meeting time is shown in Jakarta time')
assert.ok(many.html.includes('href="https://rekapin.contrivent.com/job/job_123"'), 'The button opens the meeting result')
assert.ok(many.html.includes('src="https://rekapin.contrivent.com/logo.png"'), 'Uses the ear logo')
assert.ok(!many.html.includes('<script>alert(1)</script>'), 'Task text cannot inject HTML')
assert.ok(many.html.includes('&lt;script&gt;'))
assert.ok(many.html.includes('Deteksi tugas &amp; tandai'))
assert.ok(many.html.includes('Tenggat Jumat, 26 September'))
assert.equal((many.html.match(/Tenggat /g) ?? []).length, 1, 'Empty due dates are not shown')
assert.ok(!/[–—]/.test(many.html + many.subject + many.text), 'No en or em dashes in the email')
assert.ok(!many.html.includes('π'), 'The old pi mark is gone')
assert.ok(many.text.includes('1. Implementasikan mode fokus untuk panel rekaman (tenggat Jumat, 26 September)'))
assert.ok(many.text.includes('Buka hasil rapat: https://rekapin.contrivent.com/job/job_123'))
assert.ok(!many.text.includes('\n\n\n'))

const one = renderTaskDigest({ to: 'a@b.c', tasks: [{ taskTitle: 'Kirim notulen' }], meetingAt: null })
assert.equal(one.subject, 'Tugas baru: Kirim notulen')
assert.ok(one.html.includes('Ada tugas baru untukmu'))
assert.ok(one.html.includes('Rapat tanpa judul'), 'Without a title or time the email still names the meeting')
assert.ok(one.html.includes('href="https://rekapin.contrivent.com/tugas"'), 'Without a job the button opens the task list')
assert.ok(one.html.includes('rapat <strong'), 'Without a name the sentence starts cleanly')

assert.equal(fallbackMeetingTitle(meetingAt), 'Rapat 24 September')
assert.equal(meetingMoment(new Date('invalid')), '')
assert.equal(escapeHtml(`"a" & 'b'`), '&quot;a&quot; &amp; &#39;b&#39;')

if (process.env.EMAIL_PREVIEW) writeFileSync(process.env.EMAIL_PREVIEW, many.html)
console.log('PASS: task email subject, copy, links, escaping, dates, and plain text version (synthetic fixtures).')

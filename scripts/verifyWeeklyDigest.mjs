import assert from 'node:assert/strict'

process.env.DATABASE_URL ??= 'postgres://offline@127.0.0.1:1/none'
delete process.env.APP_URL
const { weeklyWindow, splitTasks } = await import('../backend/dist/services/weeklyDigest.js')
const { renderWeeklyDigest } = await import('../backend/dist/services/email.js')

assert.deepEqual(weeklyWindow(new Date('2026-09-28T01:30:00Z')), { weekKey: '2026-09-28', today: '2026-09-28', weekEnd: '2026-10-04' }, 'Monday 08.30 in Jakarta is inside the window')
assert.ok(weeklyWindow(new Date('2026-09-28T02:59:00Z')), 'Monday 09.59 in Jakarta is still inside')
assert.equal(weeklyWindow(new Date('2026-09-28T03:00:00Z')), null, 'Monday 10.00 in Jakarta is too late')
assert.equal(weeklyWindow(new Date('2026-09-28T00:59:00Z')), null, 'Monday 07.59 in Jakarta is too early')
assert.equal(weeklyWindow(new Date('2026-09-27T01:30:00Z')), null, 'Sunday never sends')
assert.ok(weeklyWindow(new Date('2026-09-27T17:30:00Z')) === null, 'Late Sunday UTC is Monday 00.30 in Jakarta, before the window')

const tasks = [
  { task: 'Lama', dueOn: '2026-09-20', due: 'Minggu lalu', meetingTitle: 'Sync' },
  { task: 'Hari ini', dueOn: '2026-09-28', due: 'Senin', meetingTitle: null },
  { task: 'Minggu depan', dueOn: '2026-10-06', due: null, meetingTitle: null },
  { task: 'Tanpa tanggal', dueOn: null, due: 'secepatnya', meetingTitle: null },
]
const split = splitTasks(tasks, '2026-09-28', '2026-10-04')
assert.deepEqual(split.overdue.map((t) => t.task), ['Lama'])
assert.deepEqual(split.dueSoon.map((t) => t.task), ['Hari ini'])
assert.equal(split.otherOpen, 2)

const email = renderWeeklyDigest({
  to: 'a@b.c',
  name: 'Yoel Ganteng',
  ...split,
  meetings: [{ id: 'job1', title: 'Evaluasi <Fitur>', at: new Date('2026-09-24T03:42:00Z') }],
})
assert.equal(email.subject, '1 tugas lewat tenggat, 4 tugas terbuka minggu ini')
assert.ok(email.html.includes('Halo Yoel, '))
assert.ok(email.html.includes('Lewat tenggat (1)'))
assert.ok(email.html.includes('Jatuh tempo minggu ini (1)'))
assert.ok(email.html.includes('Evaluasi &lt;Fitur&gt;'), 'Meeting titles are escaped')
assert.ok(email.html.includes('href="https://rekapin.contrivent.com/job/job1"'))
assert.ok(email.html.includes('Ada 2 tugas terbuka lain'))
assert.ok(!/[–—]/.test(email.html + email.subject + email.text), 'No en or em dashes')
assert.ok(email.text.includes('Buka daftar tugas: https://rekapin.contrivent.com/tugas'))

assert.equal(renderWeeklyDigest({ to: 'a@b.c', overdue: [], dueSoon: [], otherOpen: 0, meetings: [] }), null, 'Nothing to say means no email')
const meetingsOnly = renderWeeklyDigest({ to: 'a@b.c', overdue: [], dueSoon: [], otherOpen: 0, meetings: [{ id: 'j', title: 'Rapat', at: new Date() }] })
assert.equal(meetingsOnly.subject, 'Rangkuman rapat minggu lalu')

console.log('PASS: weekly digest window in Jakarta time, task buckets, and email content (synthetic fixtures).')

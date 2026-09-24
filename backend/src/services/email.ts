import { Resend } from 'resend'

let client: Resend | null = null

function getClient() {
  if (client) return client
  const key = process.env.RESEND_API_KEY
  if (!key) {
    console.warn('Email disabled: set RESEND_API_KEY env var')
    return null
  }
  client = new Resend(key)
  return client
}

interface SendEmailInput {
  to: string
  subject: string
  html: string
  text: string
}

export async function sendEmail(input: SendEmailInput): Promise<void> {
  const c = getClient()
  if (!c) return

  const from = process.env.EMAIL_FROM ?? 'Rekapin <noreply@contrivent.com>'

  try {
    await c.emails.send({ from, to: input.to, subject: input.subject, html: input.html, text: input.text })
  } catch (err) {
    console.error('Email send failed:', err)
  }
}

export function appUrl(): string {
  return (process.env.APP_URL ?? 'https://rekapin.contrivent.com').replace(/\/+$/, '')
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function meetingMoment(at: Date | null | undefined): string {
  if (!at || Number.isNaN(at.getTime())) return ''
  const day = new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' }).format(at)
  const time = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Jakarta' }).format(at)
  return `${day}, ${time} WIB`
}

export function fallbackMeetingTitle(at: Date | null | undefined): string {
  if (!at || Number.isNaN(at.getTime())) return 'Rapat tanpa judul'
  const day = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'long', timeZone: 'Asia/Jakarta' }).format(at)
  return `Rapat ${day}`
}

const INK = '#0f172a'
const BODY = '#334155'
const MUTED = '#64748b'
const RULE = '#e2e8f0'
const ACCENT = '#1e1b4b'
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

interface DigestTask {
  taskTitle: string
  due?: string | null
}

export interface TaskDigestInput {
  to: string
  tasks: DigestTask[]
  meetingTitle?: string
  meetingAt?: Date | null
  assigneeName?: string
  jobId?: string
}

export function renderTaskDigest(input: TaskDigestInput): { subject: string; html: string; text: string } {
  const count = input.tasks.length
  const title = input.meetingTitle?.trim() || fallbackMeetingTitle(input.meetingAt)
  const when = meetingMoment(input.meetingAt)
  const name = input.assigneeName?.trim().split(/\s+/)[0] || ''
  const link = input.jobId ? `${appUrl()}/job/${encodeURIComponent(input.jobId)}` : `${appUrl()}/tugas`
  const action = input.jobId ? 'Buka hasil rapat' : 'Buka daftar tugas'

  const subject = count === 1 ? `Tugas baru: ${input.tasks[0]!.taskTitle}` : `${count} tugas baru dari ${title}`
  const heading = count === 1 ? 'Ada tugas baru untukmu' : `Ada ${count} tugas baru untukmu`
  const greeting = name ? `Halo ${name}, ` : ''
  const intro = `${greeting}rapat <strong style="color: ${INK}; font-weight: 600;">${escapeHtml(title)}</strong> menghasilkan ${count === 1 ? 'tugas' : 'beberapa tugas'} yang perlu kamu kerjakan.`
  const preview = count === 1 ? input.tasks[0]!.taskTitle : `${input.tasks[0]!.taskTitle} dan ${count - 1} tugas lainnya`

  const rows = input.tasks
    .map((task, index) => {
      const due = task.due?.trim()
      const border = index === 0 ? '' : `border-top: 1px solid ${RULE};`
      return `
          <tr>
            <td style="${border} padding: 14px 0; vertical-align: top; width: 28px;">
              <div style="width: 14px; height: 14px; margin-top: 3px; border: 1.5px solid #94a3b8; border-radius: 4px;"></div>
            </td>
            <td style="${border} padding: 14px 0; vertical-align: top;">
              <p style="margin: 0; font-size: 15px; line-height: 22px; font-weight: 600; color: ${INK};">${escapeHtml(task.taskTitle)}</p>
              ${due ? `<p style="margin: 4px 0 0; font-size: 13px; line-height: 18px; color: ${MUTED};">Tenggat ${escapeHtml(due)}</p>` : ''}
            </td>
          </tr>`
    })
    .join('')

  const html = `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin: 0; padding: 0; background: #ffffff; -webkit-text-size-adjust: 100%;">
  <div style="display: none; max-height: 0; overflow: hidden; opacity: 0; color: transparent;">${escapeHtml(preview)}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #ffffff;">
    <tr>
      <td align="left" style="padding: 40px 24px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 520px; font-family: ${FONT};">
          <tr>
            <td style="padding-bottom: 36px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="vertical-align: middle;"><img src="${appUrl()}/logo.png" width="28" height="28" alt="" style="display: block; width: 28px; height: 28px; border-radius: 6px;"></td>
                  <td style="vertical-align: middle; padding-left: 10px; font-size: 16px; font-weight: 700; letter-spacing: -0.01em; color: ${INK};">Rekapin</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td>
              <h1 style="margin: 0 0 12px; font-size: 24px; line-height: 30px; font-weight: 700; letter-spacing: -0.02em; color: ${INK};">${heading}</h1>
              <p style="margin: 0; font-size: 15px; line-height: 24px; color: ${BODY};">${intro}</p>
              ${when ? `<p style="margin: 6px 0 0; font-size: 13px; line-height: 20px; color: ${MUTED};">${escapeHtml(when)}</p>` : ''}
            </td>
          </tr>
          <tr>
            <td style="padding: 24px 0 8px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top: 1px solid ${RULE}; border-bottom: 1px solid ${RULE};">${rows}
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding: 24px 0 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="border-radius: 8px; background: ${ACCENT};">
                    <a href="${link}" style="display: inline-block; padding: 12px 22px; font-family: ${FONT}; font-size: 15px; line-height: 20px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 8px;">${action}</a>
                  </td>
                </tr>
              </table>
              <p style="margin: 14px 0 0; font-size: 13px; line-height: 20px; color: ${MUTED};">Ringkasan, transkrip, dan semua tugas dari rapat ini ada di sana.</p>
            </td>
          </tr>
          <tr>
            <td style="padding-top: 40px;">
              <p style="margin: 0; padding-top: 20px; border-top: 1px solid ${RULE}; font-size: 12px; line-height: 18px; color: ${MUTED};">Kamu menerima email ini karena kamu ditugaskan, atau ditambahkan sebagai CC, dalam rapat yang dicatat Rekapin.</p>
              <p style="margin: 8px 0 0; font-size: 12px; line-height: 18px; color: ${MUTED};">Rekapin by Contrivent</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

  const text = [
    `${name ? `Halo ${name}, ` : ''}${count === 1 ? 'ada tugas baru untukmu' : `ada ${count} tugas baru untukmu`} dari rapat ${title}.`,
    when,
    '',
    ...input.tasks.map((task, index) => `${index + 1}. ${task.taskTitle}${task.due?.trim() ? ` (tenggat ${task.due.trim()})` : ''}`),
    '',
    `${action}: ${link}`,
    '',
    'Kamu menerima email ini karena kamu ditugaskan, atau ditambahkan sebagai CC, dalam rapat yang dicatat Rekapin.',
    'Rekapin by Contrivent',
  ].filter((line, index, all) => line !== '' || all[index - 1] !== '').join('\n')

  return { subject, html, text }
}

export interface WeeklyTask {
  task: string
  dueOn: string | null
  due: string | null
  meetingTitle: string | null
}

export interface WeeklyDigestInput {
  to: string
  name?: string
  overdue: WeeklyTask[]
  dueSoon: WeeklyTask[]
  otherOpen: number
  meetings: { title: string; at: Date; id: string }[]
  now?: Date
}

function shortDay(dueOn: string): string {
  const [year, month, day] = dueOn.split('-').map(Number)
  return new Intl.DateTimeFormat('id-ID', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(year!, month! - 1, day!)))
}

function taskRows(tasks: WeeklyTask[], tone: string): string {
  return tasks
    .map((task, index) => {
      const border = index === 0 ? '' : `border-top: 1px solid ${RULE};`
      const meta = [task.dueOn ? shortDay(task.dueOn) : task.due, task.meetingTitle].filter(Boolean).join(' · ')
      return `
          <tr>
            <td style="${border} padding: 12px 0; vertical-align: top; width: 26px;">
              <div style="width: 13px; height: 13px; margin-top: 3px; border: 1.5px solid ${tone}; border-radius: 4px;"></div>
            </td>
            <td style="${border} padding: 12px 0; vertical-align: top;">
              <p style="margin: 0; font-size: 15px; line-height: 22px; font-weight: 600; color: ${INK};">${escapeHtml(task.task)}</p>
              ${meta ? `<p style="margin: 3px 0 0; font-size: 13px; line-height: 18px; color: ${MUTED};">${escapeHtml(meta)}</p>` : ''}
            </td>
          </tr>`
    })
    .join('')
}

function section(title: string, body: string): string {
  return `
          <tr>
            <td style="padding: 28px 0 0;">
              <p style="margin: 0 0 4px; font-size: 13px; line-height: 18px; font-weight: 700; color: ${INK};">${title}</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-bottom: 1px solid ${RULE};">${body}
              </table>
            </td>
          </tr>`
}

export function renderWeeklyDigest(input: WeeklyDigestInput): { subject: string; html: string; text: string } | null {
  const open = input.overdue.length + input.dueSoon.length + input.otherOpen
  if (open === 0 && input.meetings.length === 0) return null
  const name = input.name?.trim().split(/\s+/)[0] || ''
  const link = `${appUrl()}/tugas`
  const subject = input.overdue.length > 0
    ? `${input.overdue.length} tugas lewat tenggat, ${open} tugas terbuka minggu ini`
    : open > 0 ? `${open} tugas terbuka minggu ini` : `Rangkuman rapat minggu lalu`
  const heading = open > 0 ? `Minggu ini ada ${open} tugas terbuka` : 'Rangkuman minggu lalu'
  const intro = `${name ? `Halo ${escapeHtml(name)}, ` : ''}ini ringkasan tugas dan rapatmu dari Rekapin.`

  const meetingRows = input.meetings
    .slice(0, 8)
    .map((meeting, index) => {
      const border = index === 0 ? '' : `border-top: 1px solid ${RULE};`
      return `
          <tr>
            <td style="${border} padding: 11px 0;">
              <a href="${appUrl()}/job/${encodeURIComponent(meeting.id)}" style="font-size: 15px; line-height: 22px; font-weight: 600; color: ${INK}; text-decoration: none;">${escapeHtml(meeting.title)}</a>
              <p style="margin: 3px 0 0; font-size: 13px; line-height: 18px; color: ${MUTED};">${escapeHtml(meetingMoment(meeting.at))}</p>
            </td>
          </tr>`
    })
    .join('')

  const sections = [
    input.overdue.length > 0 ? section(`Lewat tenggat (${input.overdue.length})`, taskRows(input.overdue.slice(0, 10), '#e11d48')) : '',
    input.dueSoon.length > 0 ? section(`Jatuh tempo minggu ini (${input.dueSoon.length})`, taskRows(input.dueSoon.slice(0, 10), '#d97706')) : '',
    input.meetings.length > 0 ? section(`Rapat minggu lalu (${input.meetings.length})`, meetingRows) : '',
  ].join('')

  const extra = input.otherOpen > 0 ? `<p style="margin: 16px 0 0; font-size: 13px; line-height: 20px; color: ${MUTED};">Ada ${input.otherOpen} tugas terbuka lain tanpa tenggat dekat.</p>` : ''

  const html = `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin: 0; padding: 0; background: #ffffff;">
  <div style="display: none; max-height: 0; overflow: hidden; opacity: 0;">${escapeHtml(input.overdue[0]?.task ?? input.dueSoon[0]?.task ?? subject)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #ffffff;">
    <tr>
      <td align="left" style="padding: 40px 24px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 520px; font-family: ${FONT};">
          <tr>
            <td style="padding-bottom: 36px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="vertical-align: middle;"><img src="${appUrl()}/logo.png" width="28" height="28" alt="" style="display: block; width: 28px; height: 28px; border-radius: 6px;"></td>
                  <td style="vertical-align: middle; padding-left: 10px; font-size: 16px; font-weight: 700; color: ${INK};">Rekapin</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td>
              <h1 style="margin: 0 0 12px; font-size: 24px; line-height: 30px; font-weight: 700; letter-spacing: -0.02em; color: ${INK};">${heading}</h1>
              <p style="margin: 0; font-size: 15px; line-height: 24px; color: ${BODY};">${intro}</p>
            </td>
          </tr>${sections}
          <tr>
            <td style="padding: 28px 0 0;">
              ${extra}
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top: 20px;">
                <tr>
                  <td style="border-radius: 8px; background: ${ACCENT};">
                    <a href="${link}" style="display: inline-block; padding: 12px 22px; font-family: ${FONT}; font-size: 15px; line-height: 20px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 8px;">Buka daftar tugas</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding-top: 40px;">
              <p style="margin: 0; padding-top: 20px; border-top: 1px solid ${RULE}; font-size: 12px; line-height: 18px; color: ${MUTED};">Rangkuman ini dikirim setiap Senin pagi untuk akun Rekapin kamu.</p>
              <p style="margin: 8px 0 0; font-size: 12px; line-height: 18px; color: ${MUTED};">Rekapin by Contrivent</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

  const listText = (tasks: WeeklyTask[]) => tasks.slice(0, 10).map((task) => `* ${task.task}${task.dueOn ? ` (${shortDay(task.dueOn)})` : task.due ? ` (${task.due})` : ''}`)
  const text = [
    `${name ? `Halo ${name}, ` : ''}ini ringkasan tugas dan rapatmu dari Rekapin.`,
    ...(input.overdue.length > 0 ? ['', `Lewat tenggat (${input.overdue.length}):`, ...listText(input.overdue)] : []),
    ...(input.dueSoon.length > 0 ? ['', `Jatuh tempo minggu ini (${input.dueSoon.length}):`, ...listText(input.dueSoon)] : []),
    ...(input.meetings.length > 0 ? ['', `Rapat minggu lalu (${input.meetings.length}):`, ...input.meetings.slice(0, 8).map((m) => `* ${m.title}`)] : []),
    ...(input.otherOpen > 0 ? ['', `Ada ${input.otherOpen} tugas terbuka lain tanpa tenggat dekat.`] : []),
    '',
    `Buka daftar tugas: ${link}`,
  ].join('\n')

  return { subject, html, text }
}

export async function sendTaskDigest(input: TaskDigestInput): Promise<void> {
  if (input.tasks.length === 0) return
  const { subject, html, text } = renderTaskDigest(input)
  await sendEmail({ to: input.to, subject, html, text })
}

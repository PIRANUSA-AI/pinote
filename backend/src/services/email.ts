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

export async function sendTaskDigest(input: {
  to: string
  tasks: { taskTitle: string; due?: string | null }[]
  meetingTitle?: string
  assigneeName?: string
}): Promise<void> {
  const count = input.tasks.length
  const subject =
    count === 1
      ? `Tugas Baru: ${input.tasks[0].taskTitle}`
      : `${count} Tugas Baru${input.meetingTitle ? ` — ${input.meetingTitle}` : ''}`

  const taskRows = input.tasks
    .map((t, i) => {
      const due = t.due ? `<p style="margin: 6px 0 0; color: #64748B; font-size: 13px;">Tenggat: ${t.due}</p>` : ''
      return `<div style="background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px; padding: 14px 16px; margin-bottom: 10px;">
        <p style="margin: 0; font-weight: 600; font-size: 15px;">${i + 1}. ${t.taskTitle}</p>${due}
      </div>`
    })
    .join('')

  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
      <div style="background: linear-gradient(140deg, #1E1B4B, #312E81); border-radius: 12px; padding: 20px; text-align: center; margin-bottom: 24px;">
        <span style="font-size: 28px; font-family: serif; font-style: italic; color: #fff;">π</span>
        <span style="font-size: 18px; font-weight: 600; color: #fff; margin-left: 8px;">Rekapin</span>
      </div>
      <h2 style="font-size: 18px; margin: 0 0 8px;">Halo ${input.assigneeName || 'Sobat Rekapin'}</h2>
      <p style="color: #64748B; margin: 0 0 16px; line-height: 1.6;">Ada ${count} tugas baru yang menunggu kamu:</p>
      ${taskRows}
      ${input.meetingTitle ? `<p style="color: #64748B; font-size: 13px; margin: 8px 0 0;">Dari rapat: ${input.meetingTitle}</p>` : ''}
      <p style="color: #94A3B8; font-size: 12px; margin: 16px 0 0;">Buka dashboard Rekapin buat detailnya.</p>
    </div>
  `
  const text = `Halo ${input.assigneeName || 'Sobat Rekapin'},\n\nAda ${count} tugas baru yang menunggu kamu:\n${input.tasks
    .map((t, i) => `${i + 1}. ${t.taskTitle}${t.due ? ` (tenggat: ${t.due})` : ''}`)
    .join('\n')}${input.meetingTitle ? `\n\nDari rapat: ${input.meetingTitle}` : ''}\n\nBuka dashboard Rekapin buat detailnya.`

  await sendEmail({ to: input.to, subject, html, text })
}

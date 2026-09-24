import { formatTalk } from './talkTime.js'

const TITLES = { meet: 'Rapat Google Meet', zoom: 'Rapat Zoom', teams: 'Rapat Microsoft Teams', whatsapp: 'Panggilan WhatsApp' }

export function markdownClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, '0')
  const seconds = String(total % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`
}

export function escapeMarkdown(text) {
  return String(text ?? '')
    .replace(/([\\`*_[\]<>|])/g, '\\$1')
    .replace(/^(\s*)([#>+-])(\s)/gm, '$1\\$2$3')
    .replace(/^(\s*)(\d+)\.(\s)/gm, '$1$2\\.$3')
}

function sameSpeaker(previous, entry) {
  return Boolean(previous && entry)
    && (previous.speaker ?? '') === (entry.speaker ?? '')
    && previous.participantId === entry.participantId
    && Boolean(previous.chat) === Boolean(entry.chat)
}

export function transcriptMarkdown({ entries, startedAt, source, attendance, talk, actions, durationMs, now = Date.now() }) {
  const rows = (entries ?? []).filter((entry) => entry && typeof entry.text === 'string' && entry.text.trim())
  const stamp = (at) => (startedAt && at ? markdownClock(at - startedAt) : '')
  const out = [`# ${TITLES[source] ?? 'Rapat'}`, '']
  const when = new Date(startedAt || now)
  out.push(`* Tanggal: ${when.toLocaleString('id-ID', { dateStyle: 'long', timeStyle: 'short' })}`)
  if (durationMs > 0) out.push(`* Durasi: ${markdownClock(durationMs)}`)
  if (attendance?.length) out.push(`* Hadir: ${attendance.map(escapeMarkdown).join(', ')}`)

  if (talk?.length > 1) {
    out.push('', '## Waktu bicara', '')
    for (const item of talk) out.push(`* ${escapeMarkdown(item.name)}: ${formatTalk(item.seconds)} (${item.share}%)`)
  }

  if (actions?.length) {
    out.push('', '## Tugas yang terdengar', '')
    for (const item of actions) {
      const meta = [item.speaker, stamp(item.at)].filter(Boolean).join(', ')
      out.push(`* [ ] ${escapeMarkdown(item.text)}${meta ? ` (${escapeMarkdown(meta)})` : ''}`)
    }
  }

  out.push('', '## Transkrip')
  rows.forEach((entry, index) => {
    if (!sameSpeaker(rows[index - 1], entry)) {
      const time = stamp(entry.at)
      out.push('', `**${escapeMarkdown(entry.speaker || 'Rapat')}**${entry.chat ? ' (chat)' : ''}${time ? ` · ${time}` : ''}  `)
    }
    const next = rows[index + 1]
    out.push(`${escapeMarkdown(entry.text.trim())}${sameSpeaker(entry, next) ? '  ' : ''}`)
  })
  return `${out.join('\n')}\n`
}

export function markdownFilename(startedAt, now = Date.now()) {
  const date = new Date(startedAt || now)
  const pad = (value) => String(value).padStart(2, '0')
  return `rekapin_${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}.md`
}

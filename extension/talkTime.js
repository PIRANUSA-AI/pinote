const SECONDS_PER_WORD = 0.4
const MAX_LINE_SECONDS = 120

function lineSeconds(line) {
  const words = line.text.trim().split(/\s+/).filter(Boolean).length
  const measured = Number.isFinite(line.startSec) && Number.isFinite(line.endSec) ? line.endSec - line.startSec : 0
  return Math.min(MAX_LINE_SECONDS, Math.max(measured, words * SECONDS_PER_WORD))
}

export function formatTalk(seconds) {
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}m ${seconds % 60}d` : `${seconds}d`
}

export function talkTime(lines, limit = 5) {
  const totals = new Map()
  for (const line of lines ?? []) {
    if (!line || line.chat || typeof line.text !== 'string' || !line.text.trim()) continue
    if (typeof line.speaker !== 'string' || !line.speaker || line.identityResolved === false) continue
    totals.set(line.speaker, (totals.get(line.speaker) ?? 0) + lineSeconds(line))
  }
  const sum = [...totals.values()].reduce((a, b) => a + b, 0)
  if (!sum) return []
  return [...totals]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, seconds]) => ({ name, seconds: Math.round(seconds), share: Math.round((seconds / sum) * 100) }))
}

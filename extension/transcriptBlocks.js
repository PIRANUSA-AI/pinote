const JOIN_GAP_MS = 10000
const WORD_LIMIT = 75

const wordCount = (text) => text.split(' ').length

export function canJoinText(blockText, nextText) {
  if (!blockText.endsWith('.')) return true
  if (nextText.endsWith('.')) return wordCount(`${blockText} ${nextText}`) < WORD_LIMIT
  return wordCount(blockText) < WORD_LIMIT / 2
}

function joinable(block, line) {
  return block.native
    && line.provenance === 'meet-native'
    && !block.chat
    && !line.chat
    && block.participantId === line.participantId
    && block.speaker === (line.speaker ?? '')
    && Number.isFinite(line.at)
    && line.at - block.lastAt < JOIN_GAP_MS
    && canJoinText(block.text, line.text)
}

export function combineLines(lines) {
  const blocks = []
  for (const line of lines ?? []) {
    if (!line || typeof line.text !== 'string') continue
    const block = blocks[blocks.length - 1]
    if (block && joinable(block, line)) {
      block.text = `${block.text} ${line.text}`
      block.lastAt = line.at
      block.endAt = line.endAt ?? line.at
      continue
    }
    blocks.push({
      native: line.provenance === 'meet-native',
      chat: Boolean(line.chat),
      participantId: line.participantId,
      speaker: line.speaker ?? '',
      text: line.text,
      at: line.at,
      lastAt: line.at,
      endAt: line.endAt ?? line.at,
    })
  }
  return blocks.map((block) => ({ ...block, speaker: block.speaker || null }))
}

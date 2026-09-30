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
    && (block.speaker ?? '') === (line.speaker ?? '')
    && Number.isFinite(line.at)
    && line.at - block.lastAt < JOIN_GAP_MS
    && canJoinText(block.text, line.text)
}

function appendLines(blocks, lines, start) {
  for (let index = start; index < lines.length; index++) {
    const line = lines[index]
    if (!line || typeof line.text !== 'string') continue
    const block = blocks[blocks.length - 1]
    if (block && joinable(block, line)) {
      block.text = `${block.text} ${line.text}`
      block.lastAt = line.at
      block.endAt = line.endAt ?? line.at
      block.lastLine = index
      continue
    }
    blocks.push({
      native: line.provenance === 'meet-native',
      chat: Boolean(line.chat),
      participantId: line.participantId,
      speaker: line.speaker || null,
      text: line.text,
      at: line.at,
      lastAt: line.at,
      endAt: line.endAt ?? line.at,
      firstLine: index,
      lastLine: index,
    })
  }
  return blocks
}

export function combineLines(lines) {
  return appendLines([], lines ?? [], 0)
}

export function updateBlocks(blocks, lines, from) {
  const source = lines ?? []
  if (!Array.isArray(blocks) || !Number.isInteger(from) || from < 0) return { blocks: combineLines(source), firstChanged: 0 }
  let cut = blocks.length
  while (cut > 0 && blocks[cut - 1].lastLine >= from) cut--
  if (cut > 0) cut--
  const start = cut < blocks.length ? blocks[cut].firstLine : 0
  return { blocks: appendLines(blocks.slice(0, cut), source, start), firstChanged: cut }
}

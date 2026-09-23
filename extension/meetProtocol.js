(() => {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const LIMIT = 2 * 1024 * 1024
  function fields(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length > LIMIT) throw new Error('Invalid packet')
    let pos = 0
    const result = new Map()
    function integer() {
      let value = 0n
      for (let shift = 0n; shift < 70n; shift += 7n) {
        if (pos >= bytes.length) throw new Error('Truncated varint')
        const b = bytes[pos++]
        value |= BigInt(b & 127) << shift
        if (!(b & 128)) return value
      }
      throw new Error('Invalid varint')
    }
    while (pos < bytes.length) {
      const tag = Number(integer())
      const field = Math.floor(tag / 8), wire = tag % 8
      if (!field || !Number.isSafeInteger(tag)) throw new Error('Invalid tag')
      let value
      if (wire === 0) value = integer().toString()
      else {
        const size = wire === 2 ? Number(integer()) : wire === 1 ? 8 : wire === 5 ? 4 : -1
        if (size < 0 || !Number.isSafeInteger(size) || pos + size > bytes.length) throw new Error('Invalid field')
        value = bytes.slice(pos, pos + size)
        pos += size
      }
      const list = result.get(field) ?? []
      list.push({ wire, value })
      result.set(field, list)
    }
    return result
  }
  const bytesAt = (map, id) => map.get(id)?.find((f) => f.wire === 2)?.value
  const str = (map, id) => {
    const b = bytesAt(map, id)
    if (!b) return ''
    try { return decoder.decode(b) } catch { return '' }
  }
  const num = (map, id) => map.get(id)?.find((f) => f.wire === 0)?.value
  function nested(map, ...path) {
    for (const id of path) {
      const b = bytesAt(map, id)
      if (!b) return new Map()
      try { map = fields(b) } catch { return new Map() }
    }
    return map
  }
  function repeated(map, id, read) {
    const list = []
    for (const { wire, value } of map.get(id) ?? []) {
      if (wire !== 2) continue
      let entry
      try { entry = fields(value) } catch { continue }
      const item = read(entry)
      if (item) list.push(item)
    }
    return list
  }
  function users(map) {
    return repeated(map, 2, (u) => {
      const user = { id: str(u, 1), name: str(u, 2) || str(u, 29), parentId: str(u, 21), self: Boolean(str(u, 7)), status: num(u, 4) }
      return user.id && user.id.length <= 512 && user.name && user.name.length <= 120 ? user : null
    })
  }
  function roster(bytes, sync = false) {
    const root = fields(bytes)
    return users(sync ? nested(root, 2, 2) : nested(root, 1, 2, 13, 1))
  }
  function devices(bytes) {
    const root = fields(bytes)
    return repeated(nested(root, 1, 2, 3), 2, (d) => {
      const streamId = str(d, 4)
      const deviceId = str(d, 6)
      if (num(d, 2) !== '1' || !streamId || !deviceId || streamId.length > 64 || deviceId.length > 512) return null
      return { streamId, deviceId, disabled: num(nested(d, 10), 1) === '1' }
    })
  }
  async function expand(blob, format) {
    const reader = blob.stream().pipeThrough(new DecompressionStream(format)).getReader()
    const chunks = []; let size = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.length
        if (size > LIMIT) throw new Error('Expanded packet too large')
        chunks.push(part.value)
      }
    } finally { await reader.cancel().catch(() => {}) }
    const result = new Uint8Array(size); let offset = 0
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length }
    return result
  }
  const gzipAt = (bytes, at) => bytes.length > at + 2 && bytes[at] === 31 && bytes[at + 1] === 139 && bytes[at + 2] === 8
  async function packet(data, compressed = false) {
    const blob = data instanceof Blob ? data : new Blob([data])
    if (blob.size > LIMIT) throw new Error('Packet too large')
    if (!compressed) return new Uint8Array(await blob.arrayBuffer())
    const head = new Uint8Array(await blob.slice(0, 6).arrayBuffer())
    if (gzipAt(head, 0)) return expand(blob, 'gzip')
    if (gzipAt(head, 3)) return expand(blob.slice(3), 'gzip')
    for (const format of ['deflate', 'deflate-raw', 'gzip']) {
      try { return await expand(blob, format) } catch (err) {
        if (err?.message === 'Expanded packet too large') throw err
      }
    }
    return new Uint8Array(await blob.arrayBuffer())
  }
  async function unwrap(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length > LIMIT) throw new Error('Invalid packet')
    if (gzipAt(bytes, 0)) return expand(new Blob([bytes]), 'gzip')
    if (gzipAt(bytes, 3)) return expand(new Blob([bytes.subarray(3)]), 'gzip')
    return bytes
  }

  const DIGITS = /^\d{1,20}$/
  const counter = (value) => typeof value === 'string' && DIGITS.test(value) && value !== '0'
  function captionV2(bytes) {
    let root
    try { root = fields(bytes) } catch { return { kind: 'rejected', reason: 'decode' } }
    const utterance = nested(root, 1)
    if (!utterance.size) return { kind: 'rejected', reason: 'noUtterance' }
    const caption = nested(utterance, 3)
    const deviceId = str(caption, 6)
    if (!deviceId || deviceId.length > 512) return { kind: 'rejected', reason: 'noDevice' }
    const utteranceId = num(utterance, 1)
    if (!counter(utteranceId)) return { kind: 'rejected', reason: 'noUtteranceId' }
    const version = num(utterance, 2) ?? '0'
    if (!DIGITS.test(version)) return { kind: 'rejected', reason: 'badVersion' }
    return { kind: 'caption', utteranceId, version, deviceId, text: str(caption, 3), language: str(caption, 4).slice(0, 32) }
  }
  function captionLegacy(bytes) {
    let root
    try { root = fields(bytes) } catch { return { kind: 'rejected', reason: 'decode' } }
    if (root.get(2)?.some((f) => f.wire === 2)) return { kind: 'control' }
    const message = nested(root, 1)
    if (!message.size) return { kind: 'rejected', reason: 'noMessage' }
    const deviceId = str(message, 1)
    const utteranceId = num(message, 2)
    const version = num(message, 3)
    if (!deviceId || deviceId.length > 512) return { kind: 'rejected', reason: 'noDevice' }
    if (!counter(utteranceId)) return { kind: 'rejected', reason: 'noUtteranceId' }
    if (!counter(version)) return { kind: 'rejected', reason: 'badVersion' }
    if (num(message, 8) === undefined) return { kind: 'rejected', reason: 'noLanguage' }
    return { kind: 'caption', utteranceId, version, deviceId, text: str(message, 6), language: '' }
  }

  let encoder = null
  function varint(value) {
    let n = BigInt(value)
    if (n < 0n) n += 1n << 64n
    const out = []
    do {
      let b = Number(n & 127n)
      n >>= 7n
      if (n) b |= 128
      out.push(b)
    } while (n)
    return out
  }
  const numberField = (id, value) => [...varint(id * 8), ...varint(value)]
  const blockField = (id, bytes) => [...varint(id * 8 + 2), ...varint(bytes.length), ...bytes]
  const textField = (id, text) => blockField(id, [...(encoder ??= new TextEncoder()).encode(text)])
  function captionAck(utteranceId, version) {
    return Uint8Array.from(blockField(1, blockField(1, [...numberField(1, utteranceId), ...numberField(2, version), ...numberField(3, 1)])))
  }
  function languageCommand(op, code) {
    const config = blockField(9, [...textField(1, code), ...textField(2, code)])
    const update = [...blockField(1, config), ...blockField(2, textField(1, 'client_config.caption_config'))]
    return Uint8Array.from(blockField(1, blockField(2, [...numberField(1, op), ...blockField(3, update)])))
  }
  function languageAck(seq) {
    return Uint8Array.from(blockField(1, blockField(1, [...numberField(2, seq), ...numberField(3, 1)])))
  }
  function outgoingOp(bytes) {
    try {
      const op = num(nested(fields(bytes), 1, 2), 1)
      return op === undefined ? undefined : Number(op)
    } catch { return undefined }
  }
  function outgoingAck(bytes) {
    try {
      const ack = nested(fields(bytes), 1, 1)
      const seq = num(ack, 2)
      return seq === undefined || num(ack, 3) === undefined ? undefined : Number(seq)
    } catch { return undefined }
  }
  function outgoingLanguage(bytes) {
    try {
      const code = str(nested(fields(bytes), 1, 2, 3, 1, 9), 1)
      return code || undefined
    } catch { return undefined }
  }
  function incomingSeq(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes[0] !== 10) return undefined
    let pos = 1
    while (bytes[pos] >= 128) pos++
    pos++
    if (bytes[pos] !== 8) return undefined
    pos++
    while (bytes[pos] >= 128) pos++
    pos++
    if (bytes[pos] !== 34) return undefined
    pos++
    while (bytes[pos] >= 128) pos++
    pos++
    if (bytes[pos] !== 8) return undefined
    pos++
    return bytes[pos]
  }

  const loose = new TextDecoder()
  function find(bytes, pattern, from = 0, wildcard = -1) {
    for (let at = Math.max(0, from); at <= bytes.length - pattern.length; at++) {
      let match = true
      for (let i = 0; i < pattern.length; i++) {
        if (i !== wildcard && bytes[at + i] !== pattern[i]) { match = false; break }
      }
      if (match) return at
    }
    return -1
  }
  function captionLoose(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length > LIMIT) return null
    const start = bytes.indexOf(16) + 1
    let end = [[24, 0, 32, 1, 45, 0], [24, 0, 1, 32, 1, 45, 0], [24, 0, 45, 0], [24, 0, 1, 45, 0]]
      .map((pattern) => find(bytes, pattern, start, 1)).find((at) => at > -1) ?? -1
    let marker = null
    if (end === -1) {
      for (const pattern of [[24, 0, 32, 1, 50], [24, 0, 1, 32, 1, 50], [24, 0, 50], [24, 0, 1, 50]]) {
        const at = find(bytes, pattern, start, 1)
        if (at > -1) { marker = { index: at, length: pattern.length }; break }
      }
      if (!marker) return null
      end = marker.index
    }
    let id = 0
    const idBytes = bytes.slice(start, end)
    for (let i = 0; i < idBytes.length; i++) id += idBytes[i] * 256 ** i
    let body = marker ? bytes.slice(marker.index + marker.length + 1) : bytes.slice(find(bytes, [128, 63]) + 4)
    const tail = [[64, 0, 72], [64, 0, 80]].map((pattern) => find(body, pattern, 0, 1)).find((at) => at > -1) ?? -1
    if (tail === -1) return null
    body = body.slice(0, tail)
    const deviceId = loose.decode(bytes.slice(3, bytes.indexOf(16, 4))).trim()
    const text = loose.decode(body)
    const version = bytes[end + 1]
    if (!deviceId || deviceId.length > 512 || !text || !Number.isSafeInteger(id) || !Number.isInteger(version)) return null
    return { kind: 'caption', utteranceId: String(id), version: String(version), deviceId, text, language: '' }
  }

  const MESSAGES = [...'/messages/'].map((c) => c.charCodeAt(0))
  const SPACES = [...'spaces/'].map((c) => c.charCodeAt(0))
  function chatProto(map) {
    const deviceId = str(map, 2)
    const timestamp = num(map, 3)
    if (!deviceId.startsWith('spaces/') || deviceId.length > 512 || !timestamp) return null
    return { deviceId, messageId: timestamp, text: str(nested(map, 5), 1) }
  }
  function chatMessage(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length > LIMIT) return null
    let root = null
    try { root = fields(bytes) } catch {}
    if (root) {
      const wrapped = chatProto(nested(root, 1, 2, 13, 4, 2))
      if (wrapped) return wrapped
      const direct = chatProto(root)
      if (direct) return direct
    }
    try {
      const at = find(bytes, MESSAGES)
      if (at === -1) return null
      const idEnd = find(bytes, [18], at)
      if (idEnd === -1) return null
      const messageId = loose.decode(bytes.slice(at + MESSAGES.length, idEnd))
      const deviceStart = find(bytes, SPACES, idEnd)
      if (deviceStart === -1) return null
      const deviceEnd = find(bytes, [24], deviceStart)
      if (deviceEnd === -1) return null
      const deviceId = loose.decode(bytes.slice(deviceStart, deviceEnd))
      let textAt = find(bytes, [10], deviceStart) + 1
      if (textAt === 0) return null
      if (bytes[textAt - 1] === 10 && bytes[textAt + 1] === 8) textAt++
      const lengthEnd = bytes[textAt + 1] < 4 ? textAt + 2 : textAt + 1
      const lengthBytes = bytes.slice(textAt, lengthEnd)
      let size = 0
      for (let i = 0; i < lengthBytes.length; i++) size += 128 ** i * (i ? lengthBytes[i] - 1 : lengthBytes[i])
      const text = loose.decode(bytes.slice(lengthEnd, lengthEnd + size))
      if (!deviceId || deviceId.length > 512 || !messageId) return null
      return { deviceId, messageId, text }
    } catch { return null }
  }

  const LANGUAGE_IDS = Object.freeze({
    1: 'en-US', 2: 'es-MX', 3: 'es-ES', 4: 'pt-BR', 5: 'fr-FR', 6: 'de-DE', 7: 'it-IT', 8: 'nl-NL', 9: 'ja-JP', 10: 'ru-RU', 11: 'ko-KR',
    17: 'pt-PT', 18: 'hi-IN', 19: 'en-IN', 20: 'en-GB', 21: 'en-CA', 22: 'en-AU', 23: 'nl-BE', 24: 'sv-SE', 25: 'nb-NO', 34: 'cmn-Hans-CN',
    35: 'cmn-Hant-TW', 37: 'th-TH', 38: 'tr-TR', 39: 'pl-PL', 40: 'ro-RO', 41: 'id-ID', 42: 'vi-VN', 43: 'ms-MY', 44: 'uk-UA', 47: 'ar-EG',
    73: 'fr-CA', 74: 'xh-ZA', 75: 'nso-ZA', 76: 'st-ZA', 77: 'ss-latn-ZA', 79: 'tn-latn-ZA', 80: 'ts-ZA', 81: 'bg-BG', 82: 'km-KH', 83: 'rw-RW',
    84: 'ar-AE', 85: 'ar-x-LEVANT', 86: 'ar-x-MAGHREBI', 87: 'bn-BD', 88: 'gu-IN', 89: 'kn-IN', 90: 'ml-IN', 93: 'cs-CZ', 94: 'da-DK', 95: 'fi-FI',
    96: 'lo-LA', 97: 'sw', 98: 'af-ZA', 99: 'am-ET', 100: 'az-AZ', 101: 'el-GR', 102: 'en-PH', 103: 'eu-ES', 104: 'fa-IR', 105: 'he-IL', 106: 'hu-HU',
    108: 'jv-ID', 109: 'mn-MN', 112: 'sk-SK', 113: 'sq-AL', 114: 'ta-IN', 115: 'te-IN', 116: 'ur-PK', 117: 'uz-UZ', 118: 'zu-ZA', 119: 'et-EE',
    120: 'fil-PH', 121: 'is-IS', 122: 'ka-GE', 123: 'su-ID', 125: 'mk-MK', 126: 'my-MM', 127: 'ne-NP', 128: 'si-LK', 129: 'ca-ES', 130: 'gl-ES',
    131: 'lt-LT', 132: 'lv-LV', 133: 'sl-SI', 134: 'sr-RS', 137: 'hy-AM', 191: 'kk-KZ',
  })
  const LANGUAGE_CODES = new Map(Object.entries(LANGUAGE_IDS).map(([id, code]) => [code, Number(id)]))
  const languageId = (code) => LANGUAGE_CODES.get(code) ?? null
  const languageCode = (id) => (typeof id === 'number' && Object.hasOwn(LANGUAGE_IDS, id) ? LANGUAGE_IDS[id] : null)

  function skeleton(bytes, depth = 0) {
    let map
    try { map = fields(bytes) } catch { return `raw${bytes.length}` }
    const parts = []
    for (const [id, list] of [...map].sort((a, b) => a[0] - b[0])) {
      for (const { wire, value } of list) {
        if (wire !== 2) parts.push(`${id}:${wire === 0 ? 'v' : wire === 1 ? 'i64' : 'i32'}`)
        else parts.push(depth < 2 && value.length ? `${id}{${skeleton(value, depth + 1)}}` : `${id}:len${value.length}`)
      }
    }
    return parts.join(' ').slice(0, 240)
  }
  globalThis.RekapinMeetProtocol = Object.freeze({
    roster, devices, packet, unwrap, captionV2, captionLegacy, captionLoose, chatMessage, captionAck, languageCommand, languageAck,
    outgoingOp, outgoingAck, outgoingLanguage, incomingSeq, languageId, languageCode, skeleton,
  })
})()

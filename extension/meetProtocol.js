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
    roster, devices, packet, unwrap, captionV2, captionLegacy, captionAck, languageCommand, languageAck, outgoingOp, outgoingAck, skeleton,
  })
})()

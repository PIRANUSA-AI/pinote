// Private Meet wire format. See docs/MEET-SPEAKER-IDENTITY.md for provenance
// and compatibility limits. Unknown/truncated packets fail closed.
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
  const str = (map, id) => { const b = bytesAt(map, id); return b ? decoder.decode(b) : '' }
  const num = (map, id) => map.get(id)?.find((f) => f.wire === 0)?.value
  function nested(map, ...path) {
    for (const id of path) {
      const b = bytesAt(map, id)
      if (!b) return new Map()
      map = fields(b)
    }
    return map
  }
  function users(map) {
    return (map.get(2) ?? []).filter((f) => f.wire === 2).map(({ value }) => {
      const u = fields(value)
      return { id: str(u, 1), name: str(u, 2) || str(u, 29), parentId: str(u, 21), self: Boolean(str(u, 7)), status: num(u, 4) }
    }).filter((u) => u.id && u.id.length <= 512 && u.name && u.name.length <= 120)
  }
  function roster(bytes, sync = false) {
    const root = fields(bytes)
    return users(sync ? nested(root, 2, 2) : nested(root, 1, 2, 13, 1))
  }
  function caption(bytes, v2 = false) {
    const event = nested(fields(bytes), 1)
    const body = v2 ? nested(event, 3) : event
    const id = v2 ? num(event, 1) : num(event, 2)
    const version = (v2 ? num(event, 2) : num(event, 3)) ?? '0'
    const deviceId = str(body, v2 ? 6 : 1)
    const text = str(body, v2 ? 3 : 6)
    if (!id || !deviceId || deviceId.length > 512 || text.length > 10000) throw new Error('Unsupported caption')
    return { id, version, deviceId, text, final: num(body, v2 ? 2 : 4) === '1' }
  }
  async function packet(data, compressed = false) {
    const blob = data instanceof Blob ? data : new Blob([data])
    if (blob.size > LIMIT) throw new Error('Packet too large')
    if (!compressed) return new Uint8Array(await blob.arrayBuffer())
    const reader = blob.stream().pipeThrough(new DecompressionStream('deflate')).getReader()
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
  globalThis.RekapinMeetProtocol = Object.freeze({ roster, caption, packet })
})()

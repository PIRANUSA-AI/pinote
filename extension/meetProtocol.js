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
  async function packet(data, compressed = false) {
    const blob = data instanceof Blob ? data : new Blob([data])
    if (blob.size > LIMIT) throw new Error('Packet too large')
    if (!compressed) return new Uint8Array(await blob.arrayBuffer())
    for (const format of ['deflate', 'deflate-raw', 'gzip']) {
      try { return await expand(blob, format) } catch (err) {
        if (err?.message === 'Expanded packet too large') throw err
      }
    }
    return new Uint8Array(await blob.arrayBuffer())
  }
  globalThis.RekapinMeetProtocol = Object.freeze({ roster, devices, packet })
})()

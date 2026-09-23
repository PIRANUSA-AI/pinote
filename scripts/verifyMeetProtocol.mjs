import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { gzipSync } from 'node:zlib'

const context = vm.createContext({ Uint8Array, TextDecoder, TextEncoder, Blob, Response, DecompressionStream })
vm.runInContext(readFileSync(new URL('../extension/meetProtocol.js', import.meta.url), 'utf8'), context)
const protocol = context.RekapinMeetProtocol

const cat = (...parts) => Uint8Array.from(parts.flatMap((p) => [...p]))
function vint(value) {
  let n = BigInt(value)
  if (n < 0n) n += 1n << 64n
  const out = []
  do { let b = Number(n & 127n); n >>= 7n; if (n) b |= 128; out.push(b) } while (n)
  return Uint8Array.from(out)
}
const integer = (id, n) => cat(vint(id * 8), vint(n))
const field = (id, bytes) => cat(vint(id * 8 + 2), vint(bytes.length), bytes)
const string = (id, text) => field(id, new TextEncoder().encode(text))
const bytesOf = (value) => [...value]

const device = 'spaces/abc/devices/42'
function v2Packet({ utteranceId = 7, version = 3, deviceId = device, text = 'Halo semua', language = 'id-ID', extra = new Uint8Array(0) } = {}) {
  const caption = cat(
    text === null ? new Uint8Array(0) : string(3, text),
    language === null ? new Uint8Array(0) : string(4, language),
    deviceId === null ? new Uint8Array(0) : string(6, deviceId),
    extra,
  )
  const utterance = cat(
    utteranceId === null ? new Uint8Array(0) : integer(1, utteranceId),
    version === null ? new Uint8Array(0) : integer(2, version),
    field(3, caption),
  )
  return field(1, utterance)
}

const parsed = protocol.captionV2(v2Packet())
assert.equal(parsed.kind, 'caption')
assert.equal(parsed.utteranceId, '7')
assert.equal(parsed.version, '3')
assert.equal(parsed.deviceId, device)
assert.equal(parsed.text, 'Halo semua')
assert.equal(parsed.language, 'id-ID')

const unknownFields = protocol.captionV2(cat(v2Packet({ extra: cat(integer(9, 5), string(12, 'baru')) }), integer(15, 1)))
assert.equal(unknownFields.kind, 'caption', 'Unknown fields are tolerated')
assert.equal(unknownFields.text, 'Halo semua')

const big = protocol.captionV2(v2Packet({ utteranceId: '18446744073709551615', version: 1 }))
assert.equal(big.utteranceId, '18446744073709551615', 'Full 64 bit ids survive as decimal strings')

assert.equal(protocol.captionV2(v2Packet({ version: null })).version, '0', 'Missing version reads as zero')
assert.equal(protocol.captionV2(v2Packet({ text: null })).text, '', 'Missing text reads as empty')
assert.equal(protocol.captionV2(v2Packet({ language: 'x'.repeat(80) })).language.length, 32)

assert.deepEqual({ ...protocol.captionV2(Uint8Array.from([15])) }, { kind: 'rejected', reason: 'decode' })
assert.deepEqual({ ...protocol.captionV2(Uint8Array.from([10, 5, 1])) }, { kind: 'rejected', reason: 'decode' })
assert.equal(protocol.captionV2(new Uint8Array(0)).reason, 'noUtterance')
assert.equal(protocol.captionV2(integer(2, 1)).reason, 'noUtterance')
assert.equal(protocol.captionV2(v2Packet({ deviceId: null })).reason, 'noDevice')
assert.equal(protocol.captionV2(v2Packet({ deviceId: '' })).reason, 'noDevice')
assert.equal(protocol.captionV2(v2Packet({ deviceId: 'd'.repeat(513) })).reason, 'noDevice')
const badUtf8 = field(1, cat(integer(1, 7), field(3, field(6, Uint8Array.from([255, 254])))))
assert.equal(protocol.captionV2(badUtf8).reason, 'noDevice', 'Invalid UTF 8 device ids are rejected')
assert.equal(protocol.captionV2(v2Packet({ utteranceId: null })).reason, 'noUtteranceId')
assert.equal(protocol.captionV2(v2Packet({ utteranceId: 0 })).reason, 'noUtteranceId')
const stringId = field(1, cat(string(1, '7'), integer(2, 1), field(3, string(6, device))))
assert.equal(protocol.captionV2(stringId).reason, 'noUtteranceId', 'Wrong wire type for the id is rejected')

function legacyPacket({ deviceId = device, messageId = 11, version = 2, text = 'Kalimat lama', langId = 1 } = {}) {
  return field(1, cat(
    deviceId === null ? new Uint8Array(0) : string(1, deviceId),
    messageId === null ? new Uint8Array(0) : integer(2, messageId),
    version === null ? new Uint8Array(0) : integer(3, version),
    text === null ? new Uint8Array(0) : string(6, text),
    langId === null ? new Uint8Array(0) : integer(8, langId),
  ))
}
const legacy = protocol.captionLegacy(legacyPacket())
assert.equal(legacy.kind, 'caption')
assert.equal(legacy.utteranceId, '11')
assert.equal(legacy.version, '2')
assert.equal(legacy.deviceId, device)
assert.equal(legacy.text, 'Kalimat lama')
assert.equal(legacy.language, '')
assert.equal(protocol.captionLegacy(cat(legacyPacket(), string(2, 'x'))).kind, 'control', 'A string in field 2 marks a control packet')
assert.equal(protocol.captionLegacy(Uint8Array.from([15])).reason, 'decode')
assert.equal(protocol.captionLegacy(new Uint8Array(0)).reason, 'noMessage')
assert.equal(protocol.captionLegacy(legacyPacket({ deviceId: null })).reason, 'noDevice')
assert.equal(protocol.captionLegacy(legacyPacket({ messageId: 0 })).reason, 'noUtteranceId')
assert.equal(protocol.captionLegacy(legacyPacket({ version: null })).reason, 'badVersion')
assert.equal(protocol.captionLegacy(legacyPacket({ version: 0 })).reason, 'badVersion')
assert.equal(protocol.captionLegacy(legacyPacket({ langId: null })).reason, 'noLanguage')

assert.deepEqual(bytesOf(protocol.captionAck('5', '2')), [10, 8, 10, 6, 8, 5, 16, 2, 24, 1])
assert.deepEqual(bytesOf(protocol.captionAck('300', '1')), [10, 9, 10, 7, 8, 172, 2, 16, 1, 24, 1])
const hugeAck = bytesOf(protocol.captionAck('18446744073709551615', '1'))
assert.deepEqual(hugeAck.slice(4, 15), [8, 255, 255, 255, 255, 255, 255, 255, 255, 255, 1])
assert.deepEqual(bytesOf(protocol.captionAck('-1', '1')).slice(4, 15), hugeAck.slice(4, 15), 'Negative ids encode as two complement varints')

assert.deepEqual(bytesOf(protocol.languageAck(7)), [10, 6, 10, 4, 16, 7, 24, 1])
assert.deepEqual(bytesOf(protocol.languageAck(200)), [10, 7, 10, 5, 16, 200, 1, 24, 1])
assert.equal(protocol.outgoingAck(protocol.languageAck(9)), 9)

const config = field(9, cat(string(1, 'id-ID'), string(2, 'id-ID')))
const update = cat(field(1, config), field(2, string(1, 'client_config.caption_config')))
const expectedCommand = field(1, field(2, cat(integer(1, 3), field(3, update))))
assert.deepEqual(bytesOf(protocol.languageCommand(3, 'id-ID')), bytesOf(expectedCommand))
assert.equal(protocol.outgoingOp(protocol.languageCommand(41, 'en-US')), 41)
assert.equal(protocol.outgoingOp(protocol.languageAck(4)), undefined, 'An ack carries no command op')
assert.equal(protocol.outgoingAck(protocol.languageCommand(4, 'en-US')), undefined, 'A command carries no ack seq')
assert.equal(protocol.outgoingOp(Uint8Array.from([15])), undefined)
assert.equal(protocol.outgoingAck(Uint8Array.from([15])), undefined)

const plain = v2Packet()
const zipped = gzipSync(plain)
assert.deepEqual(bytesOf(await protocol.unwrap(zipped)), bytesOf(plain), 'gzip at offset 0 is expanded')
const prefixed = cat(Uint8Array.from([1, 2, 3]), zipped)
assert.deepEqual(bytesOf(await protocol.unwrap(prefixed)), bytesOf(plain), 'gzip after a 3 byte prefix is expanded')
assert.deepEqual(bytesOf(await protocol.unwrap(plain)), bytesOf(plain), 'Uncompressed bytes pass through')
assert.equal(protocol.captionV2(await protocol.unwrap(prefixed)).text, 'Halo semua')
assert.deepEqual(bytesOf(await protocol.packet(zipped, true)), bytesOf(plain))
assert.deepEqual(bytesOf(await protocol.packet(prefixed, true)), bytesOf(plain))
assert.deepEqual(bytesOf(await protocol.packet(new Blob([prefixed]), true)), bytesOf(plain), 'Blob payloads are handled')
assert.deepEqual(bytesOf(await protocol.packet(plain)), bytesOf(plain))

await assert.rejects(() => protocol.unwrap(new Uint8Array(2 * 1024 * 1024 + 1)))
await assert.rejects(() => protocol.unwrap('not bytes'))
await assert.rejects(() => protocol.packet(new Uint8Array(2 * 1024 * 1024 + 1), true))
await assert.rejects(() => protocol.unwrap(gzipSync(new Uint8Array(2 * 1024 * 1024 + 1))), /too large/)
await assert.rejects(() => protocol.packet(gzipSync(new Uint8Array(2 * 1024 * 1024 + 1)), true), /too large/)
const truncated = zipped.subarray(0, zipped.length - 6)
await assert.rejects(() => protocol.unwrap(truncated), 'A truncated gzip body fails instead of returning garbage')

assert.equal(protocol.outgoingLanguage(protocol.languageCommand(4, 'id-ID')), 'id-ID')
assert.equal(protocol.outgoingLanguage(protocol.languageAck(4)), undefined)
assert.equal(protocol.incomingSeq(Uint8Array.from([10, 3, 8, 1, 34, 2, 8, 9])), 9)
assert.equal(protocol.incomingSeq(Uint8Array.from([10, 3, 8, 1, 35, 2, 8, 9])), undefined)
assert.equal(protocol.languageId('id-ID'), 41)
assert.equal(protocol.languageCode(41), 'id-ID')
assert.equal(protocol.languageCode(999), null)

const encode = (text) => new TextEncoder().encode(text)
const heuristicChat = cat(encode('xx/messages/abc123'), Uint8Array.from([18]), encode('spaces/s/devices/7'), Uint8Array.from([24, 1, 10, 5]), encode('hallo'))
const chat = protocol.chatMessage(heuristicChat)
assert.equal(chat.deviceId, 'spaces/s/devices/7', 'The chat byte pattern fallback finds the sender')
assert.equal(chat.messageId, 'abc123')
assert.equal(chat.text, 'hallo')
const protoChat = protocol.chatMessage(cat(string(2, 'spaces/s/devices/8'), integer(3, 42), field(5, string(1, 'langsung'))))
assert.equal(protoChat.text, 'langsung')
assert.equal(protoChat.messageId, '42')
assert.equal(protocol.chatMessage(v2Packet()), null, 'Caption packets are never mistaken for chat')
assert.equal(protocol.captionLoose(Uint8Array.from([1, 2, 3])), null)

const shape = protocol.skeleton(v2Packet())
assert.ok(shape.startsWith('1{'), 'The skeleton describes structure')
assert.ok(!shape.includes('Halo'), 'The skeleton never includes text content')
assert.ok(protocol.skeleton(v2Packet({ text: 'x'.repeat(5000) })).length <= 240)
assert.equal(protocol.skeleton(Uint8Array.from([15])), 'raw1')

console.log('PASS: Meet caption codec parsing, rejection reasons, legacy packets, ack and language encoders, gzip framing, and size limits (synthetic fixtures).')

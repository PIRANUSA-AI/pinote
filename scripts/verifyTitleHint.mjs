import assert from 'node:assert/strict'

const { cleanTitleHint } = await import('../backend/dist/lib/titleHint.js')

assert.equal(cleanTitleHint('Rapat | Meeting with Yoel ‎ㅤ | Microsoft Teams'), 'Meeting with Yoel')
assert.equal(cleanTitleHint('Weekly Sync Produk | Microsoft Teams'), 'Weekly Sync Produk')
assert.equal(cleanTitleHint('Meet - abc-defg-hij'), null, 'A bare Meet code is not a title')
assert.equal(cleanTitleHint('Meet – Evaluasi Q3 Tim Sales'), 'Evaluasi Q3 Tim Sales')
assert.equal(cleanTitleHint('Zoom Meeting'), null)
assert.equal(cleanTitleHint('YOEL Zoom Meeting'), 'YOEL')
assert.equal(cleanTitleHint('Zoom Workplace'), null)
assert.equal(cleanTitleHint('Rapat Anggaran 2027 - Zoom'), 'Rapat Anggaran 2027')
assert.equal(cleanTitleHint('WhatsApp'), null)
assert.equal(cleanTitleHint('(3) WhatsApp'), null)
assert.equal(cleanTitleHint('Rapat | Microsoft Teams'), null)
assert.equal(cleanTitleHint(''), null)
assert.equal(cleanTitleHint(undefined), null)
assert.equal(cleanTitleHint(42), null)
assert.ok(cleanTitleHint(`Rapat ${'panjang '.repeat(40)}`).length <= 120)

console.log('PASS: meeting title hints from Meet, Zoom, Teams, and WhatsApp tab titles (synthetic fixtures).')

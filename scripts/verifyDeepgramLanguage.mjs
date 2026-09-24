import assert from 'node:assert/strict'

delete process.env.DEEPGRAM_AUTO_LANGUAGE
const { buildUrl } = await import('../backend/dist/services/deepgram.js')

const auto = new URL(buildUrl('auto')).searchParams
assert.equal(auto.get('detect_language'), 'true', 'Auto detects the language so Indonesian is recognized')
assert.equal(auto.get('language'), null, 'Auto does not force the multi model, which lacks Indonesian')
assert.equal(auto.get('diarize'), 'true')

const indonesian = new URL(buildUrl('id')).searchParams
assert.equal(indonesian.get('language'), 'id')
assert.equal(indonesian.get('detect_language'), null)
assert.equal(new URL(buildUrl('en')).searchParams.get('language'), 'en')

process.env.DEEPGRAM_AUTO_LANGUAGE = 'multi'
const configured = new URL(buildUrl('auto')).searchParams
assert.equal(configured.get('language'), 'multi', 'An explicit server setting still wins')
assert.equal(configured.get('detect_language'), null)

console.log('PASS: final transcript language parameters for auto, Indonesian, English, and server override (synthetic fixtures).')

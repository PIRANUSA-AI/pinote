import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const context = vm.createContext({})
vm.runInContext(readFileSync(new URL('../extension/languageDetect.js', import.meta.url), 'utf8'), context)
const { detect, supported } = context.RekapinLanguage

const indonesian = detect('dibuka kembali Cerita rakyat ini tuh mencatat syarat ekstrim yang diajukan seorang putri untuk menolak pinangan')
assert.equal(indonesian.code, 'id-ID')
assert.ok(indonesian.confidence >= 0.9)

const englishUnderIndonesian = detect('halo Interaction instruction FB following the meeting for ten minutes and I don\'t think that this meeting upgrade our')
assert.equal(englishUnderIndonesian.code, 'en-US', 'English still shows through Indonesian captions')
assert.ok(englishUnderIndonesian.confidence >= 0.6)

const mixed = detect('Jadi nanti kita deploy this service after lunch ya')
assert.notEqual(mixed.code, 'en-US', 'Indonesian with English jargon never reads as English')
assert.equal(detect('Seorang anak kecil berjalan pelan menuju sekolah sambil membawa payung kecil warna merah.').code, 'id-ID', 'Sentences made of content words are recognised by letter shapes')
assert.equal(detect('A small child walked slowly toward school, carrying a tiny red umbrella.').code, 'en-US')
assert.ok(detect('A small child walked slowly toward school, carrying a tiny red umbrella.').confidence >= 0.8)
assert.equal(detect('Il cielo quella mattina era ancora un po nuvoloso, ma l aria era fresca.').code, 'it-IT')
assert.equal(detect('De lucht was die ochtend nog een beetje bewolkt, maar de lucht voelde fris aan.').code, 'nl-NL')
assert.equal(detect('Still bahasa Indonesia sono sarawamata Ustikumoteit karedo').code, null, 'Garbled romaji from Japanese speech is never mistaken for Italian')
assert.equal(detect('mahal').code, null)
const jargon = detect('nanti kita meeting jam 3 ya jangan lupa deadline')
assert.notEqual(jargon.code, 'en-US', 'English loan words never flip a sentence to English')

assert.equal(detect('我们今天讨论一下这个项目的进度').code, 'cmn-Hans-CN')
assert.equal(detect('我们今天讨论一下这个项目的进度').script, true)
assert.equal(detect('今日はプロジェクトの進捗について話しましょう').code, 'ja-JP', 'Kana marks Japanese even with Han characters')
assert.equal(detect('오늘 프로젝트 진행 상황에 대해 이야기합시다').code, 'ko-KR')
assert.equal(detect('Guten Morgen, wir sprechen heute über das Projekt und die Ergebnisse').code, 'de-DE')
assert.equal(detect('Hola a todos, hoy vamos a hablar sobre el proyecto y los resultados').code, 'es-ES')
assert.equal(detect('Bonjour à tous, nous allons parler du projet et des résultats').code, 'fr-FR')

assert.ok(detect('okay yes sorry').tokens < 5, 'Short interjections carry too few words to count')
assert.equal(detect(''), null)
assert.equal(detect('12345 !!!'), null)
assert.equal(detect('xqzt brrp klm').code, null, 'Text without any known words has no language')

assert.ok(supported.length >= 15, 'Many languages are supported, not only Indonesian and English')
assert.ok(supported.includes('id-ID') && supported.includes('en-US') && supported.includes('cmn-Hans-CN'))

console.log('PASS: local caption language detection for Latin languages by stopwords and letter patterns, scripts for CJK and others, loan words, and short text guards (synthetic fixtures).')

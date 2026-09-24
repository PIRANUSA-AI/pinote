import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const only = process.argv.slice(2)
const files = readdirSync(here)
  .filter((name) => /^verify\w+\.mjs$/.test(name))
  .filter((name) => only.length === 0 || only.some((wanted) => name.toLowerCase().includes(wanted.toLowerCase())))
  .sort()

const failed = []
const started = Date.now()
for (const name of files) {
  const run = spawnSync(process.execPath, ['--no-warnings', join(here, name)], { encoding: 'utf8', timeout: 180000 })
  const ok = run.status === 0
  const lastLine = `${run.stdout ?? ''}`.trim().split('\n').at(-1) ?? ''
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n${(run.stderr || run.stdout || String(run.error ?? '')).trim().split('\n').slice(0, 15).join('\n')}`}`)
  if (!ok) failed.push(name)
  else if (process.env.TEST_VERBOSE) console.log(`     ${lastLine}`)
}

console.log(`\n${files.length - failed.length}/${files.length} test files passed in ${((Date.now() - started) / 1000).toFixed(1)}s`)
if (failed.length > 0) {
  console.log(`Failed: ${failed.join(', ')}`)
  process.exit(1)
}

import { createHash, createPublicKey } from 'node:crypto'
import { createReadStream, createWriteStream, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXPECTED_ID = 'cncnbeehgiacjoimfoapiijccfifcoha'

const signingKey = normalizeKey(process.env.EXTENSION_SIGNING_KEY ?? '')
delete process.env.EXTENSION_SIGNING_KEY

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = join(root, 'extension')
const outDir = join(root, 'frontend', 'dist', 'downloads')

function normalizeKey(value) {
  const trimmed = value.trim()
  if (!trimmed) return ''
  const withNewlines = trimmed.includes('\n') ? trimmed : trimmed.replace(/\\n/g, '\n')
  return `${withNewlines}\n`
}

function listFiles(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...listFiles(full))
    else if (entry.isFile()) files.push(full)
  }
  return files.sort()
}

function extensionIdFromDer(der) {
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32)
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('')
}

async function writeZip(files, zipPath) {
  const { default: yazl } = await import('yazl')
  const zip = new yazl.ZipFile()
  for (const file of files) {
    const name = relative(sourceDir, file).split(sep).join('/')
    zip.addFile(file, name, { compressionLevel: 9 })
  }
  await new Promise((resolvePromise, rejectPromise) => {
    const out = createWriteStream(zipPath)
    out.once('close', resolvePromise)
    out.once('error', rejectPromise)
    zip.outputStream.once('error', rejectPromise)
    zip.outputStream.pipe(out)
    zip.end()
  })
}

async function writeCrx(zipPath, crxPath) {
  const keyFile = join(tmpdir(), `rekapinSigning${process.pid}${Date.now()}.pem`)
  try {
    writeFileSync(keyFile, signingKey, { mode: 0o600 })

    const der = createPublicKey(signingKey).export({ type: 'spki', format: 'der' })
    const keyId = extensionIdFromDer(der)
    if (keyId !== EXPECTED_ID) {
      throw new Error(`Kunci penandatangan menghasilkan ID ${keyId}, seharusnya ${EXPECTED_ID}. CRX dibatalkan.`)
    }

    const { default: crx3 } = await import('crx3')
    const info = await crx3(createReadStream(zipPath), { keyPath: keyFile, crxPath })
    if (info.newKey) throw new Error('crx3 membuat kunci baru. CRX dibatalkan supaya ID extension tidak berubah.')
    if (info.appId !== EXPECTED_ID) throw new Error(`CRX bertanda ID ${info.appId}, seharusnya ${EXPECTED_ID}.`)

    const crx = readFileSync(crxPath)
    const headerSize = crx.readUInt32LE(8)
    if (crx.subarray(0, 4).toString() !== 'Cr24' || crx.readUInt32LE(4) !== 3) {
      throw new Error('Berkas CRX yang dihasilkan tidak valid.')
    }
    if (!crx.subarray(12, 12 + headerSize).includes(der)) {
      throw new Error('CRX tidak ditandatangani dengan kunci yang diharapkan.')
    }
  } catch (err) {
    rmSync(crxPath, { force: true })
    throw err
  } finally {
    rmSync(keyFile, { force: true })
  }
}

async function main() {
  const manifest = JSON.parse(readFileSync(join(sourceDir, 'manifest.json'), 'utf8'))
  const version = manifest.version
  const base = `rekapinExtension_v${version}`
  const files = listFiles(sourceDir)

  mkdirSync(outDir, { recursive: true })

  let crx = null
  if (signingKey) {
    const zipPath = join(tmpdir(), `rekapinPack${process.pid}${Date.now()}.zip`)
    try {
      await writeZip(files, zipPath)
      const crxName = `${base}.crx`
      const crxPath = join(outDir, crxName)
      await writeCrx(zipPath, crxPath)
      crx = { url: `/downloads/${crxName}`, size: statSync(crxPath).size }
      console.log(`CRX siap: ${crxName}, ID ${EXPECTED_ID}`)
    } finally {
      rmSync(zipPath, { force: true })
    }
  } else {
    console.warn('EXTENSION_SIGNING_KEY tidak diset, jadi tidak ada paket yang diterbitkan.')
  }

  const latest = {
    version,
    extensionId: EXPECTED_ID,
    crx,
    builtAt: new Date().toISOString(),
  }
  writeFileSync(join(outDir, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`)
  console.log(`latest.json ditulis untuk versi ${version}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})

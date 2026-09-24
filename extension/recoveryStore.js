const RECOVERY_DB = 'rekapinRecovery'
const RECOVERY_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000
let recoveryOpening = null

function recoveryDb() {
  if (!recoveryOpening) {
    recoveryOpening = new Promise((resolve, reject) => {
      const request = indexedDB.open(RECOVERY_DB, 1)
      request.onupgradeneeded = () => {
        const db = request.result
        db.createObjectStore('sessions', { keyPath: 'id' })
        db.createObjectStore('chunks', { autoIncrement: true }).createIndex('session', 'session')
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    recoveryOpening.catch(() => { recoveryOpening = null })
  }
  return recoveryOpening
}

function settled(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

async function beginRecovery(meta) {
  const db = await recoveryDb()
  const tx = db.transaction('sessions', 'readwrite')
  tx.objectStore('sessions').put({ ...meta, createdAt: Date.now() })
  await settled(tx)
}

async function appendRecovery(id, blob) {
  const db = await recoveryDb()
  const tx = db.transaction('chunks', 'readwrite')
  tx.objectStore('chunks').add({ session: id, blob })
  await settled(tx)
}

async function loadRecovery(id) {
  if (typeof id !== 'string' || !id) return null
  const db = await recoveryDb()
  const tx = db.transaction(['sessions', 'chunks'], 'readonly')
  const session = tx.objectStore('sessions').get(id)
  const chunks = tx.objectStore('chunks').index('session').getAll(id)
  await settled(tx)
  if (!session.result) return null
  return { ...session.result, chunks: chunks.result.map((row) => row.blob) }
}

async function dropRecovery(id) {
  if (typeof id !== 'string' || !id) return
  const db = await recoveryDb()
  const tx = db.transaction(['sessions', 'chunks'], 'readwrite')
  tx.objectStore('sessions').delete(id)
  const chunks = tx.objectStore('chunks')
  const cursor = chunks.index('session').openKeyCursor(IDBKeyRange.only(id))
  cursor.onsuccess = () => {
    if (!cursor.result) return
    chunks.delete(cursor.result.primaryKey)
    cursor.result.continue()
  }
  await settled(tx)
}

async function pruneRecovery(keep = []) {
  const db = await recoveryDb()
  const tx = db.transaction('sessions', 'readonly')
  const all = tx.objectStore('sessions').getAll()
  await settled(tx)
  const cutoff = Date.now() - RECOVERY_MAX_AGE_MS
  for (const session of all.result) {
    if (session.createdAt < cutoff && !keep.includes(session.id)) await dropRecovery(session.id)
  }
}

globalThis.RekapinRecovery = { begin: beginRecovery, append: appendRecovery, load: loadRecovery, drop: dropRecovery, prune: pruneRecovery }

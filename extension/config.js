export const API_BASE = 'https://rekapin.contrivent.com/api'
export const APP_BASE = 'https://rekapin.contrivent.com'

const LOCAL_API = 'http://localhost:3000'
const LOCAL_APP = 'http://localhost:5173'
const PROBE_TIMEOUT_MS = 700

let cached = null

async function localBackendAlive() {
  try {
    const response = await fetch(`${LOCAL_API}/health/live`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    return response.ok
  } catch {
    return false
  }
}

export async function readConfig() {
  if (cached) return cached
  cached = (await localBackendAlive())
    ? { apiBase: LOCAL_API, appBase: LOCAL_APP, local: true }
    : { apiBase: API_BASE, appBase: APP_BASE, local: false }
  return cached
}

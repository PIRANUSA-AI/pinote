export const DEFAULT_API_BASE = 'https://rekapin.contrivent.com/api'
export const DEFAULT_APP_BASE = 'https://rekapin.contrivent.com'

export async function readConfig() {
  const stored = await chrome.storage.local.get(['apiBase', 'appBase'])
  return {
    apiBase: (stored.apiBase || DEFAULT_API_BASE).replace(/\/+$/, ''),
    appBase: (stored.appBase || DEFAULT_APP_BASE).replace(/\/+$/, ''),
  }
}

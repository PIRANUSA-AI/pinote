export const API_BASE = 'https://rekapin.contrivent.com/api'
export const APP_BASE = 'https://rekapin.contrivent.com'

export async function readConfig() {
  return { apiBase: API_BASE, appBase: APP_BASE }
}

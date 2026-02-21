const DEFAULT_PORT = 3700

export function getApiBase(): string {
  // Explicit env override always wins
  if (import.meta.env.VITE_API_URL) return import.meta.env.VITE_API_URL
  // On localhost — use same-origin URLs (Vite proxy or local server).
  const host = location.hostname
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return ''
  // Fallback for unusual local setups where UI origin differs from API origin.
  const savedPort = localStorage.getItem('quoroom_port') || String(DEFAULT_PORT)
  return `http://127.0.0.1:${savedPort}`
}

export const API_BASE = getApiBase()

let cachedToken: string | null = null
let inFlightTokenRequest: Promise<string> | null = null

async function fetchHandshakeToken(): Promise<string> {
  const res = await fetch(`${API_BASE}/api/auth/handshake`, {
    cache: 'no-store',
  })
  if (!res.ok) throw new Error('Failed to fetch')
  const data = await res.json() as { token?: unknown }
  if (typeof data.token !== 'string' || data.token.length === 0) {
    throw new Error('Invalid auth token response')
  }
  return data.token
}

function requestToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh && inFlightTokenRequest) return inFlightTokenRequest
  const req = fetchHandshakeToken()
    .then((token) => {
      if (inFlightTokenRequest === req) {
        cachedToken = token
      }
      return token
    })
    .finally(() => {
      if (inFlightTokenRequest === req) {
        inFlightTokenRequest = null
      }
    })
  inFlightTokenRequest = req
  return req
}

export async function getToken(options: { forceRefresh?: boolean } = {}): Promise<string> {
  const forceRefresh = options.forceRefresh === true
  if (forceRefresh) cachedToken = null
  if (!forceRefresh && cachedToken) return cachedToken
  return requestToken(forceRefresh)
}

export function clearToken(): void {
  cachedToken = null
  inFlightTokenRequest = null
}

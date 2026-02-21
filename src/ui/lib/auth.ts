const DEFAULT_PORT = 3700
const CLOUD_TOKEN_STORAGE_KEY = 'quoroom_cloud_token'
const CLOUD_TOKEN_QUERY_KEY = 'token'

export type AppMode = 'local' | 'cloud'

function normalizeApiBase(url: string): string {
  return url.replace(/\/+$/, '')
}

function normalizeAppMode(value: string | undefined): AppMode {
  return value?.trim().toLowerCase() === 'cloud' ? 'cloud' : 'local'
}

export const APP_MODE = normalizeAppMode(import.meta.env.VITE_APP_MODE)

export function getApiBase(): string {
  // Explicit env override always wins
  if (import.meta.env.VITE_API_URL) return normalizeApiBase(import.meta.env.VITE_API_URL)
  // Cloud mode defaults to same-origin API.
  if (APP_MODE === 'cloud') return ''
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

async function verifyToken(token: string): Promise<boolean> {
  const res = await fetch(`${API_BASE}/api/auth/verify`, {
    method: 'GET',
    cache: 'no-store',
    headers: { Authorization: `Bearer ${token}` },
  })
  return res.ok
}

function getCloudTokenFromQuery(): string | null {
  const params = new URLSearchParams(location.search)
  const token = params.get(CLOUD_TOKEN_QUERY_KEY)?.trim()
  return token && token.length > 0 ? token : null
}

function removeCloudTokenFromQuery(): void {
  const params = new URLSearchParams(location.search)
  if (!params.has(CLOUD_TOKEN_QUERY_KEY)) return
  params.delete(CLOUD_TOKEN_QUERY_KEY)
  const next = `${location.pathname}${params.toString() ? `?${params}` : ''}${location.hash}`
  window.history.replaceState({}, '', next)
}

function getCloudTokenFromStorage(): string | null {
  const token = localStorage.getItem(CLOUD_TOKEN_STORAGE_KEY)?.trim()
  return token && token.length > 0 ? token : null
}

function saveCloudToken(token: string): void {
  localStorage.setItem(CLOUD_TOKEN_STORAGE_KEY, token)
}

async function fetchCloudToken(): Promise<string> {
  const queryToken = getCloudTokenFromQuery()
  if (queryToken) {
    if (await verifyToken(queryToken)) {
      saveCloudToken(queryToken)
      removeCloudTokenFromQuery()
      return queryToken
    }
    removeCloudTokenFromQuery()
  }

  const storedToken = getCloudTokenFromStorage()
  if (storedToken && await verifyToken(storedToken)) {
    return storedToken
  }

  if (storedToken) {
    localStorage.removeItem(CLOUD_TOKEN_STORAGE_KEY)
  }
  throw new Error('Cloud session missing or expired. Launch the app from your cloud dashboard again.')
}

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
  const req = (APP_MODE === 'cloud' ? fetchCloudToken() : fetchHandshakeToken())
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

export function getCachedToken(): string | null {
  return cachedToken
}

export function clearToken(): void {
  cachedToken = null
  inFlightTokenRequest = null
}

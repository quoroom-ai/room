import { storageGet, storageSet, storageRemove } from './storage'

const DEFAULT_PORT = 3700
const CLOUD_TOKEN_STORAGE_KEY = 'quoroom_cloud_token'
const CLOUD_TOKEN_QUERY_KEY = 'token'
const CLOUD_MODE_FLAG_KEY = 'quoroom_cloud_mode'

export type AppMode = 'local' | 'cloud'

function normalizeApiBase(url: string): string {
  return url.replace(/\/+$/, '')
}

export function isLocalHost(): boolean {
  if (typeof location === 'undefined') return true
  const host = location.hostname
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
}

function detectAppMode(envValue: string | undefined): AppMode {
  if (envValue?.trim().toLowerCase() === 'cloud') return 'cloud'
  if (typeof location !== 'undefined') {
    if (isLocalHost()) {
      // On localhost, clear any stale cloud flag and use local mode
      storageRemove(CLOUD_MODE_FLAG_KEY)
      return 'local'
    }
    // Non-localhost: check token presence or persisted cloud mode flag
    const hasTokenParam = new URLSearchParams(location.search).has('token')
    const hasStoredToken = !!storageGet(CLOUD_TOKEN_STORAGE_KEY)
    const hasCloudFlag = !!storageGet(CLOUD_MODE_FLAG_KEY)
    if (hasTokenParam || hasStoredToken || hasCloudFlag) return 'cloud'
  }
  return 'local'
}

export const APP_MODE = detectAppMode(import.meta.env.VITE_APP_MODE)

export function getApiBase(): string {
  // Explicit env override always wins
  if (import.meta.env.VITE_API_URL) return normalizeApiBase(import.meta.env.VITE_API_URL)
  // Cloud mode defaults to same-origin API.
  if (APP_MODE === 'cloud') return ''
  // On localhost — use same-origin URLs (Vite proxy or local server).
  const host = location.hostname
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return ''
  // Fallback for unusual local setups where UI origin differs from API origin.
  const savedPort = storageGet('quoroom_port') || String(DEFAULT_PORT)
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
  const token = storageGet(CLOUD_TOKEN_STORAGE_KEY)?.trim()
  return token && token.length > 0 ? token : null
}

function saveCloudToken(token: string): void {
  storageSet(CLOUD_TOKEN_STORAGE_KEY, token)
  storageSet(CLOUD_MODE_FLAG_KEY, '1')
}

async function fetchCloudToken(): Promise<string> {
  const queryToken = getCloudTokenFromQuery()
  if (queryToken) {
    if (await verifyToken(queryToken)) {
      saveCloudToken(queryToken)
      removeCloudTokenFromQuery()
      scheduleCloudTokenRefresh(queryToken)
      return queryToken
    }
    removeCloudTokenFromQuery()
  }

  const storedToken = getCloudTokenFromStorage()
  if (storedToken && await verifyToken(storedToken)) {
    scheduleCloudTokenRefresh(storedToken)
    return storedToken
  }

  if (storedToken) {
    storageRemove(CLOUD_TOKEN_STORAGE_KEY)
  }
  throw new Error('Cloud session missing or expired. Launch the app from your cloud dashboard again.')
}

async function fetchHandshakeToken(): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const res = await fetch(`${API_BASE}/api/auth/handshake`, {
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!res.ok) throw new Error('Failed to fetch')
    const data = await res.json() as { token?: unknown }
    if (typeof data.token !== 'string' || data.token.length === 0) {
      throw new Error('Invalid auth token response')
    }
    return data.token
  } finally {
    clearTimeout(timeout)
  }
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
  stopCloudTokenRefresh()
}

// ─── Cloud JWT auto-refresh ──────────────────────────────────

let refreshTimer: ReturnType<typeof setTimeout> | null = null

/** Decode a JWT payload without verification (browser-side, used for scheduling only). */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
}

function getCloudControlOrigin(): string {
  return (import.meta.env.VITE_CLOUD_CONTROL_ORIGIN || 'https://quoroom.ai').replace(/\/+$/, '')
}

async function refreshCloudToken(currentToken: string): Promise<string | null> {
  const payload = decodeJwtPayload(currentToken)
  if (!payload?.instanceId) return null

  const controlOrigin = getCloudControlOrigin()
  try {
    const res = await fetch(`${controlOrigin}/api/cloud/instances/${payload.instanceId}/refresh-token`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: currentToken }),
    })
    if (!res.ok) return null
    const data = await res.json() as { ok?: boolean; token?: string }
    if (data.ok && typeof data.token === 'string') return data.token
  } catch {
    // Network error — will retry on next cycle
  }
  return null
}

function scheduleCloudTokenRefresh(token: string): void {
  stopCloudTokenRefresh()
  const payload = decodeJwtPayload(token)
  if (!payload?.exp || typeof payload.exp !== 'number') return

  // Refresh at 80% of remaining TTL (e.g., 12 min into a 15-min token)
  const nowSec = Math.floor(Date.now() / 1000)
  const remainingSec = payload.exp - nowSec
  if (remainingSec <= 0) return
  const refreshInMs = Math.max(30_000, remainingSec * 0.8 * 1000)

  refreshTimer = setTimeout(async () => {
    const current = getCloudTokenFromStorage()
    if (!current) return
    const newToken = await refreshCloudToken(current)
    if (newToken) {
      saveCloudToken(newToken)
      cachedToken = newToken
      scheduleCloudTokenRefresh(newToken)
    }
  }, refreshInMs)
}

function stopCloudTokenRefresh(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
}

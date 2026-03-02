export type RestartToApplyUpdateResult =
  | { ok: true; reloaded: true; reason: 'updated' | 'recovered' | 'fallback_timeout' }
  | { ok: false; error: string }

export interface RestartToApplyUpdateOptions {
  apiBase: string
  targetVersion: string
  authToken?: string | null
  requestTimeoutMs?: number
  statusRequestTimeoutMs?: number
  initialPollDelayMs?: number
  pollIntervalMs?: number
  pollTimeoutMs?: number
  fetchImpl?: typeof fetch
  reload?: () => void
  wait?: (ms: number) => Promise<void>
  now?: () => number
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5000
const DEFAULT_STATUS_REQUEST_TIMEOUT_MS = 1500
const DEFAULT_INITIAL_POLL_DELAY_MS = 600
const DEFAULT_POLL_INTERVAL_MS = 1000
const DEFAULT_POLL_TIMEOUT_MS = 30000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '')
}

function asErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const value = (payload as Record<string, unknown>).error
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

async function readErrorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  if (text) {
    try {
      const parsed = JSON.parse(text) as unknown
      const parsedError = asErrorMessage(parsed)
      if (parsedError) return parsedError
    } catch {
      // Fall through to plain text fallback.
    }
    const compact = text.replace(/\s+/g, ' ').trim()
    if (compact) return compact
  }
  return `HTTP ${res.status}`
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  if (timeoutMs <= 0 || typeof AbortController === 'undefined') {
    return fetchImpl(url, init)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function extractStatusVersion(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const version = (payload as Record<string, unknown>).version
  if (typeof version !== 'string') return null
  const trimmed = version.trim()
  return trimmed.length > 0 ? trimmed : null
}

export async function restartToApplyUpdate(options: RestartToApplyUpdateOptions): Promise<RestartToApplyUpdateResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const reload = options.reload ?? (() => window.location.reload())
  const wait = options.wait ?? sleep
  const now = options.now ?? (() => Date.now())
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const statusRequestTimeoutMs = options.statusRequestTimeoutMs ?? DEFAULT_STATUS_REQUEST_TIMEOUT_MS
  const initialPollDelayMs = options.initialPollDelayMs ?? DEFAULT_INITIAL_POLL_DELAY_MS
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS

  const targetVersion = normalizeVersion(options.targetVersion)
  const restartUrl = `${options.apiBase}/api/server/update-restart`
  const statusUrl = `${options.apiBase}/api/status?parts=update`
  let sawOffline = false

  try {
    const restartResponse = await fetchWithTimeout(
      fetchImpl,
      restartUrl,
      { method: 'POST', cache: 'no-store' },
      requestTimeoutMs
    )
    if (!restartResponse.ok) {
      const message = await readErrorMessage(restartResponse)
      return { ok: false, error: `Restart to update failed: ${message}` }
    }
  } catch {
    // Network interruptions are expected while process exits; treat as uncertain success.
    sawOffline = true
  }

  if (initialPollDelayMs > 0) {
    await wait(initialPollDelayMs)
  }

  const deadline = now() + Math.max(0, pollTimeoutMs)
  const intervalDelay = pollIntervalMs > 0 ? pollIntervalMs : 1

  while (now() < deadline) {
    try {
      const headers: Record<string, string> = {}
      const token = typeof options.authToken === 'string' ? options.authToken.trim() : ''
      if (token) headers.Authorization = `Bearer ${token}`

      const statusResponse = await fetchWithTimeout(
        fetchImpl,
        statusUrl,
        {
          method: 'GET',
          cache: 'no-store',
          headers: Object.keys(headers).length > 0 ? headers : undefined,
        },
        statusRequestTimeoutMs
      )

      if (statusResponse.ok) {
        const payload = await statusResponse.json().catch(() => null)
        const currentVersion = extractStatusVersion(payload)
        if (currentVersion && normalizeVersion(currentVersion) === targetVersion) {
          reload()
          return { ok: true, reloaded: true, reason: 'updated' }
        }
        if (sawOffline) {
          reload()
          return { ok: true, reloaded: true, reason: 'recovered' }
        }
      } else if (sawOffline) {
        // Response means server process is reachable again after restart cycle.
        reload()
        return { ok: true, reloaded: true, reason: 'recovered' }
      }
    } catch {
      sawOffline = true
    }

    await wait(intervalDelay)
  }

  reload()
  return { ok: true, reloaded: true, reason: 'fallback_timeout' }
}

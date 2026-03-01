/**
 * Background update checker — polls GitHub releases (default every 4 hours).
 * Caches the result in memory; the status route reads it via getUpdateInfo().
 * When a lightweight update bundle is available, triggers auto-download.
 */

import { checkAndApplyUpdate, getAutoUpdateStatus, getReadyUpdateVersion } from './autoUpdate'

const DEFAULT_CHECK_INTERVAL = 4 * 60 * 60 * 1000  // 4 hours
const INITIAL_DELAY  = 15_000               // 15s after startup
const REQUEST_TIMEOUT_MS = 10_000
const BACKOFF_BASE_MS = 30_000
const BACKOFF_MAX_MS = 30 * 60 * 1000
const GITHUB_RELEASES_URL = 'https://api.github.com/repos/quoroom-ai/room/releases?per_page=100'
const DEFAULT_RELEASE_URL = 'https://github.com/quoroom-ai/room/releases'

interface GithubReleaseAsset {
  name: string
  browser_download_url: string
}

interface GithubRelease {
  tag_name: string
  html_url: string
  draft: boolean
  prerelease: boolean
  assets?: GithubReleaseAsset[]
}

export interface UpdateInfo {
  latestVersion: string
  releaseUrl: string
  assets: {
    mac: string | null     // .pkg installer
    windows: string | null // setup.exe installer
    linux: string | null   // .deb installer
  }
  /** Lightweight update bundle URL (JS + UI only, ~13MB) */
  updateBundle: string | null
}

export { getAutoUpdateStatus, getReadyUpdateVersion }

type UpdateSource = 'cloud' | 'github'

export interface UpdateDiagnostics {
  lastCheckAt: string | null
  lastSuccessAt: string | null
  lastErrorAt: string | null
  lastErrorCode: string | null
  lastErrorMessage: string | null
  updateSource: UpdateSource | null
  nextCheckAt: string | null
  consecutiveFailures: number
}

export interface UpdateCheckerOptions {
  /** Poll interval in milliseconds (defaults to 4 hours). */
  pollIntervalMs?: number
  /** Called when a new ready update version appears. */
  onReadyUpdate?: (version: string) => void
}

interface ForceCheckOptions {
  onReadyUpdate?: (version: string) => void
  ignoreBackoff?: boolean
}

interface CloudUpdateResponse {
  version?: unknown
  updateBundleUrl?: unknown
  releaseUrl?: unknown
  checkedAt?: unknown
}

let cached: UpdateInfo | null = null
let initTimer: ReturnType<typeof setTimeout> | null = null
let pollInterval: ReturnType<typeof setInterval> | null = null
let consecutiveFailures = 0
let backoffUntil = 0
const diagnostics: UpdateDiagnostics = {
  lastCheckAt: null,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastErrorCode: null,
  lastErrorMessage: null,
  updateSource: null,
  nextCheckAt: null,
  consecutiveFailures: 0,
}

class UpdateCheckError extends Error {
  readonly code: string
  readonly source: UpdateSource

  constructor(code: string, source: UpdateSource, message: string) {
    super(message)
    this.code = code
    this.source = source
  }
}

function isTestTag(tag: string): boolean {
  return /-test/i.test(tag)
}

function parseSemver(tag: string): [number, number, number] | null {
  const cleaned = tag.trim().replace(/^v/i, '')
  const match = cleaned.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return 1
    if (a[i] < b[i]) return -1
  }
  return 0
}

function pickLatestStable(releases: GithubRelease[]): GithubRelease | null {
  let firstStable: GithubRelease | null = null
  let bestRelease: GithubRelease | null = null
  let bestVersion: [number, number, number] | null = null

  for (const r of releases) {
    if (r.draft || r.prerelease) continue
    if (isTestTag(r.tag_name)) continue
    if (!firstStable) firstStable = r

    const parsed = parseSemver(r.tag_name)
    if (!parsed) continue

    if (!bestVersion || compareSemver(parsed, bestVersion) > 0) {
      bestVersion = parsed
      bestRelease = r
    }
  }
  return bestRelease ?? firstStable
}

function nowIso(ts = Date.now()): string {
  return new Date(ts).toISOString()
}

function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/, '')
}

function getBackoffMs(failureCount: number): number {
  if (failureCount <= 1) return 0
  const exponent = Math.min(8, failureCount - 2)
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * (2 ** exponent))
}

function getGithubToken(): string | null {
  const token = (process.env.QUOROOM_UPDATE_GITHUB_TOKEN || '').trim()
  return token || null
}

function getCloudSourceConfig(): { url: string; token: string | null } | null {
  const url = (process.env.QUOROOM_UPDATE_SOURCE_URL || '').trim()
  if (!url) return null
  const token = (process.env.QUOROOM_UPDATE_SOURCE_TOKEN || '').trim() || null
  return { url, token }
}

async function fetchJson(
  url: string,
  source: UpdateSource,
  headers: Record<string, string> = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(timeoutMs)
  let response: Response
  try {
    response = await fetch(url, {
      headers: {
        'User-Agent': 'quoroom-update-checker',
        Accept: 'application/json',
        ...headers,
      },
      signal: timeout,
    })
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new UpdateCheckError('timeout', source, `Request timed out after ${timeoutMs}ms`)
    }
    throw new UpdateCheckError(
      'network',
      source,
      error instanceof Error ? error.message : 'Network error while checking updates',
    )
  }

  if (!response.ok) {
    const rateLimitRemaining = response.headers.get('x-ratelimit-remaining')
    const retryAfter = response.headers.get('retry-after')
    const isRateLimited = response.status === 429
      || (response.status === 403 && (rateLimitRemaining === '0' || Boolean(retryAfter)))
    if (isRateLimited) {
      const message = retryAfter
        ? `Rate limited (HTTP ${response.status}, retry-after=${retryAfter}s)`
        : `Rate limited (HTTP ${response.status})`
      throw new UpdateCheckError('rate_limited', source, message)
    }
    throw new UpdateCheckError('http_status', source, `HTTP ${response.status}`)
  }

  const body = await response.text()
  try {
    return JSON.parse(body)
  } catch {
    throw new UpdateCheckError('invalid_json', source, 'Response body is not valid JSON')
  }
}

function formatFailure(error: unknown): { code: string; source: UpdateSource; message: string } {
  if (error instanceof UpdateCheckError) {
    return { code: error.code, source: error.source, message: error.message }
  }
  if (error instanceof Error) {
    return { code: 'unexpected', source: 'github', message: error.message }
  }
  return { code: 'unexpected', source: 'github', message: String(error) }
}

function parseGithubUpdateInfo(raw: unknown): UpdateInfo {
  if (!Array.isArray(raw)) {
    throw new UpdateCheckError('invalid_payload', 'github', 'GitHub response is not an array')
  }
  const latest = pickLatestStable(raw as GithubRelease[])
  if (!latest?.assets) {
    throw new UpdateCheckError('invalid_payload', 'github', 'No stable release with assets found')
  }
  const latestVersion = normalizeVersion(latest.tag_name)
  const assets: UpdateInfo['assets'] = { mac: null, windows: null, linux: null }

  let updateBundle: string | null = null
  for (const a of latest.assets) {
    const { name, browser_download_url: url } = a
    if (name.endsWith('.pkg')) assets.mac = url
    else if (name.toLowerCase().includes('setup') && name.endsWith('.exe')) assets.windows = url
    else if (name.endsWith('.deb')) assets.linux = url
    else if (name.startsWith('quoroom-update-') && name.endsWith('.tar.gz')) updateBundle = url
  }
  if (!updateBundle) {
    console.error(`[update-checker] Missing update bundle asset for v${latestVersion}`)
  }
  return {
    latestVersion,
    releaseUrl: latest.html_url || DEFAULT_RELEASE_URL,
    assets,
    updateBundle,
  }
}

function parseCloudUpdateInfo(raw: unknown): UpdateInfo {
  const payload = (raw ?? {}) as CloudUpdateResponse
  const version = typeof payload.version === 'string' ? normalizeVersion(payload.version) : ''
  const updateBundleUrl = typeof payload.updateBundleUrl === 'string' ? payload.updateBundleUrl.trim() : ''
  const releaseUrl = typeof payload.releaseUrl === 'string' ? payload.releaseUrl.trim() : DEFAULT_RELEASE_URL

  if (!version) {
    throw new UpdateCheckError('invalid_payload', 'cloud', 'Cloud source returned missing version')
  }
  if (!updateBundleUrl) {
    throw new UpdateCheckError('missing_bundle', 'cloud', `Cloud source missing update bundle for v${version}`)
  }

  return {
    latestVersion: version,
    releaseUrl,
    assets: { mac: null, windows: null, linux: null },
    updateBundle: updateBundleUrl,
  }
}

async function fetchFromGithub(): Promise<UpdateInfo> {
  const headers: Record<string, string> = {}
  const githubToken = getGithubToken()
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`
  const raw = await fetchJson(GITHUB_RELEASES_URL, 'github', headers)
  return parseGithubUpdateInfo(raw)
}

async function fetchFromCloudSource(url: string, token: string | null): Promise<UpdateInfo> {
  const headers: Record<string, string> = {}
  if (token) {
    headers.Authorization = `Bearer ${token}`
    headers['X-Update-Token'] = token
  }
  const raw = await fetchJson(url, 'cloud', headers)
  return parseCloudUpdateInfo(raw)
}

async function resolveLatestUpdateInfo(): Promise<{ info: UpdateInfo; source: UpdateSource }> {
  const cloudSource = getCloudSourceConfig()
  let cloudError: { code: string; message: string } | null = null

  if (cloudSource) {
    try {
      const info = await fetchFromCloudSource(cloudSource.url, cloudSource.token)
      return { info, source: 'cloud' }
    } catch (error) {
      const failed = formatFailure(error)
      cloudError = { code: failed.code, message: failed.message }
      console.error(`[update-checker] Cloud update source failed (${failed.code}): ${failed.message}`)
    }
  }

  try {
    const info = await fetchFromGithub()
    return { info, source: 'github' }
  } catch (error) {
    const failed = formatFailure(error)
    if (cloudError) {
      throw new UpdateCheckError(
        failed.code,
        failed.source,
        `Cloud source failed (${cloudError.code}): ${cloudError.message}; GitHub fallback failed (${failed.code}): ${failed.message}`,
      )
    }
    throw error
  }
}

export async function forceCheck(options: ForceCheckOptions = {}): Promise<void> {
  diagnostics.lastCheckAt = nowIso()
  if (!options.ignoreBackoff && backoffUntil > Date.now()) {
    diagnostics.nextCheckAt = nowIso(backoffUntil)
    return
  }

  try {
    const { info, source } = await resolveLatestUpdateInfo()
    cached = info
    diagnostics.updateSource = source
    diagnostics.lastSuccessAt = nowIso()
    diagnostics.lastErrorAt = null
    diagnostics.lastErrorCode = null
    diagnostics.lastErrorMessage = null
    diagnostics.nextCheckAt = null
    consecutiveFailures = 0
    diagnostics.consecutiveFailures = 0

    // If a lightweight update bundle is available, trigger background auto-download
    if (info.updateBundle && info.latestVersion) {
      const beforeReadyVersion = getReadyUpdateVersion()
      await checkAndApplyUpdate(info.updateBundle, info.latestVersion).catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[update-checker] Auto-apply failed for v${info.latestVersion}: ${message}`)
      })
      const afterReadyVersion = getReadyUpdateVersion()
      if (options.onReadyUpdate && afterReadyVersion && afterReadyVersion !== beforeReadyVersion) {
        try {
          options.onReadyUpdate(afterReadyVersion)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          console.error(`[update-checker] onReadyUpdate callback failed: ${message}`)
          // Non-critical — callback failures should not impact checker loop
        }
      }
    }
  } catch (error) {
    const failed = formatFailure(error)
    consecutiveFailures += 1
    diagnostics.consecutiveFailures = consecutiveFailures
    diagnostics.lastErrorAt = nowIso()
    diagnostics.lastErrorCode = failed.code
    diagnostics.lastErrorMessage = failed.message
    const backoffMs = getBackoffMs(consecutiveFailures)
    backoffUntil = backoffMs > 0 ? Date.now() + backoffMs : 0
    diagnostics.nextCheckAt = backoffUntil > 0 ? nowIso(backoffUntil) : null
    console.error(`[update-checker] Update check failed (${failed.code}, source=${failed.source}): ${failed.message}`)
  }
}

export function initUpdateChecker(options: UpdateCheckerOptions = {}): void {
  if (process.env.NODE_ENV === 'test') return
  const pollEvery = Number.isFinite(options.pollIntervalMs) && (options.pollIntervalMs ?? 0) > 0
    ? Number(options.pollIntervalMs)
    : DEFAULT_CHECK_INTERVAL
  initTimer = setTimeout(() => {
    void forceCheck({ onReadyUpdate: options.onReadyUpdate })
    pollInterval = setInterval(() => {
      void forceCheck({ onReadyUpdate: options.onReadyUpdate })
    }, pollEvery)
  }, INITIAL_DELAY)
}

export function stopUpdateChecker(): void {
  if (initTimer) { clearTimeout(initTimer); initTimer = null }
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null }
}

export function getUpdateInfo(): UpdateInfo | null {
  return cached
}

export function getUpdateDiagnostics(): UpdateDiagnostics {
  return { ...diagnostics }
}

export async function simulateUpdate(): Promise<void> {
  // Fetch real release data first if not yet cached, so asset URLs are populated.
  if (!cached) await forceCheck({ ignoreBackoff: true })
  cached = {
    latestVersion: '99.0.0',
    releaseUrl: 'https://github.com/quoroom-ai/room/releases',
    assets: {
      mac: cached?.assets.mac ?? null,
      windows: cached?.assets.windows ?? null,
      linux: cached?.assets.linux ?? null,
    },
    updateBundle: cached?.updateBundle ?? null,
  }
}

/**
 * Background update checker — polls GitHub releases (default every 4 hours).
 * Caches the result in memory; the status route reads it via getUpdateInfo().
 * When a lightweight update bundle is available, triggers auto-download.
 */

import https from 'node:https'
import { checkAndApplyUpdate, getAutoUpdateStatus, getReadyUpdateVersion } from './autoUpdate'

const DEFAULT_CHECK_INTERVAL = 4 * 60 * 60 * 1000  // 4 hours
const INITIAL_DELAY  = 15_000               // 15s after startup

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

export interface UpdateCheckerOptions {
  /** Poll interval in milliseconds (defaults to 4 hours). */
  pollIntervalMs?: number
  /** Called when a new ready update version appears. */
  onReadyUpdate?: (version: string) => void
}

let cached: UpdateInfo | null = null
let initTimer: ReturnType<typeof setTimeout> | null = null
let pollInterval: ReturnType<typeof setInterval> | null = null

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

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'quoroom-update-checker' } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()))
        } catch (e) {
          reject(e)
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error('Timeout')) })
  })
}

export async function forceCheck(options: Pick<UpdateCheckerOptions, 'onReadyUpdate'> = {}): Promise<void> {
  try {
    const releases = await fetchJson(
      'https://api.github.com/repos/quoroom-ai/room/releases?per_page=100'
    ) as GithubRelease[]
    if (!Array.isArray(releases)) return

    const latest = pickLatestStable(releases)
    if (!latest?.assets) return

    const latestVersion = latest.tag_name.replace(/^v/, '')
    const assets: UpdateInfo['assets'] = { mac: null, windows: null, linux: null }

    let updateBundle: string | null = null

    for (const a of latest.assets) {
      const { name, browser_download_url: url } = a
      if (name.endsWith('.pkg')) assets.mac = url
      else if (name.toLowerCase().includes('setup') && name.endsWith('.exe')) assets.windows = url
      else if (name.endsWith('.deb')) assets.linux = url
      else if (name.startsWith('quoroom-update-') && name.endsWith('.tar.gz')) updateBundle = url
    }

    cached = { latestVersion, releaseUrl: latest.html_url, assets, updateBundle }

    // If a lightweight update bundle is available, trigger background auto-download
    if (updateBundle && latestVersion) {
      const beforeReadyVersion = getReadyUpdateVersion()
      await checkAndApplyUpdate(updateBundle, latestVersion).catch(() => {
        // Non-critical — auto-update failure doesn't affect normal operation
      })
      const afterReadyVersion = getReadyUpdateVersion()
      if (options.onReadyUpdate && afterReadyVersion && afterReadyVersion !== beforeReadyVersion) {
        try {
          options.onReadyUpdate(afterReadyVersion)
        } catch {
          // Non-critical — callback failures should not impact checker loop
        }
      }
    }
  } catch {
    // Non-critical — silently ignore network/parse errors
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

export async function simulateUpdate(): Promise<void> {
  // Fetch real release data first if not yet cached, so asset URLs are populated.
  if (!cached) await forceCheck()
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

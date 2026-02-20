/**
 * Background update checker — polls GitHub releases every 4 hours.
 * Caches the result in memory; the status route reads it via getUpdateInfo().
 */

import https from 'node:https'

const CHECK_INTERVAL = 4 * 60 * 60 * 1000  // 4 hours
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
}

let cached: UpdateInfo | null = null
let initTimer: ReturnType<typeof setTimeout> | null = null
let pollInterval: ReturnType<typeof setInterval> | null = null

function isTestTag(tag: string): boolean {
  return /-test/i.test(tag)
}

function pickLatestStable(releases: GithubRelease[]): GithubRelease | null {
  for (const r of releases) {
    if (r.draft || r.prerelease) continue
    if (isTestTag(r.tag_name)) continue
    return r
  }
  return null
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

async function check(): Promise<void> {
  try {
    const releases = await fetchJson(
      'https://api.github.com/repos/quoroom-ai/room/releases?per_page=20'
    ) as GithubRelease[]
    if (!Array.isArray(releases)) return

    const latest = pickLatestStable(releases)
    if (!latest?.assets) return

    const latestVersion = latest.tag_name.replace(/^v/, '')
    const assets: UpdateInfo['assets'] = { mac: null, windows: null, linux: null }

    for (const a of latest.assets) {
      const { name, browser_download_url: url } = a
      if (name.endsWith('.pkg')) assets.mac = url
      else if (name.toLowerCase().includes('setup') && name.endsWith('.exe')) assets.windows = url
      else if (name.endsWith('.deb')) assets.linux = url
    }

    cached = { latestVersion, releaseUrl: latest.html_url, assets }
  } catch {
    // Non-critical — silently ignore network/parse errors
  }
}

export function initUpdateChecker(): void {
  if (process.env.NODE_ENV === 'test') return
  initTimer = setTimeout(() => {
    void check()
    pollInterval = setInterval(() => { void check() }, CHECK_INTERVAL)
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
  if (!cached) await check()
  cached = {
    latestVersion: '99.0.0',
    releaseUrl: 'https://github.com/quoroom-ai/room/releases',
    assets: {
      mac: cached?.assets.mac ?? null,
      windows: cached?.assets.windows ?? null,
      linux: cached?.assets.linux ?? null,
    },
  }
}

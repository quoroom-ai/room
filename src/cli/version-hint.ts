import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'

const PACKAGE_NAME = 'quoroom'
const NPM_LATEST_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`
const CACHE_FILE_PATH = path.join(homedir(), '.quoroom', 'npm-version-check.json')
const CHECK_TTL_MS = 12 * 60 * 60 * 1000
const NOTIFY_TTL_MS = 24 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 3000

interface VersionCache {
  checkedAt?: number
  latestVersion?: string
  notifiedVersion?: string
  notifiedAt?: number
}

interface LatestPackageMeta {
  version?: unknown
}

function parseSemver(value: string): [number, number, number] | null {
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function semverGt(a: string, b: string): boolean {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return false
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return true
    if (pa[i] < pb[i]) return false
  }
  return false
}

function shouldSkip(command: string): boolean {
  if (process.env.QUOROOM_DISABLE_VERSION_HINT === '1') return true
  if (command === 'mcp' || command === 'update' || command === 'uninstall') return true
  return false
}

function readCache(): VersionCache {
  try {
    if (!fs.existsSync(CACHE_FILE_PATH)) return {}
    const raw = fs.readFileSync(CACHE_FILE_PATH, 'utf8')
    const parsed = JSON.parse(raw) as VersionCache
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeCache(cache: VersionCache): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE_PATH), { recursive: true })
    fs.writeFileSync(CACHE_FILE_PATH, JSON.stringify(cache))
  } catch {
    // Ignore cache write failures.
  }
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(NPM_LATEST_URL, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'quoroom-cli-version-hint',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const payload = await res.json() as LatestPackageMeta
    const version = typeof payload?.version === 'string' ? payload.version.trim() : ''
    return parseSemver(version) ? version : null
  } catch {
    return null
  }
}

export async function maybeShowVersionHint(currentVersion: string, command: string): Promise<void> {
  if (shouldSkip(command)) return

  const now = Date.now()
  const cache = readCache()
  const hasFreshCache = typeof cache.checkedAt === 'number' && (now - cache.checkedAt) < CHECK_TTL_MS
  let latestVersion = hasFreshCache ? (cache.latestVersion || null) : null

  if (!latestVersion) {
    latestVersion = await fetchLatestVersion()
    if (!latestVersion) return
    cache.latestVersion = latestVersion
    cache.checkedAt = now
    writeCache(cache)
  }

  if (!semverGt(latestVersion, currentVersion)) return

  const notifiedRecently = cache.notifiedVersion === latestVersion
    && typeof cache.notifiedAt === 'number'
    && (now - cache.notifiedAt) < NOTIFY_TTL_MS
  if (notifiedRecently) return

  console.log(
    `Update available: quoroom v${latestVersion} (current v${currentVersion}). ` +
    'Run: quoroom update or npm i -g quoroom@latest'
  )
  writeCache({
    ...cache,
    latestVersion,
    checkedAt: now,
    notifiedVersion: latestVersion,
    notifiedAt: now,
  })
}

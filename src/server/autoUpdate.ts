/**
 * Auto-update system — downloads lightweight update bundles (JS + UI only)
 * to ~/.quoroom/app/ so the wrapper script can pick them up on next restart.
 *
 * The bundled native modules in /usr/local/lib/quoroom/lib/node_modules/
 * are reused via NODE_PATH — only JS code and UI assets are updated.
 */

import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import https from 'node:https'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'

// ── Paths ──────────────────────────────────────────────────────

const USER_APP_DIR = path.join(homedir(), '.quoroom', 'app')
const STAGING_DIR = path.join(homedir(), '.quoroom', 'app-staging')
const BOOT_MARKER = path.join(USER_APP_DIR, '.booting')
const CRASH_COUNT_FILE = path.join(USER_APP_DIR, '.crash_count')
const VERSION_FILE = path.join(USER_APP_DIR, 'version.json')

export { USER_APP_DIR, VERSION_FILE }

// ── Types ──────────────────────────────────────────────────────

export interface UpdateVersionInfo {
  version: string
  minEngineVersion?: string
  createdAt?: string
  checksums?: Record<string, string>
}

export type AutoUpdateStatus =
  | { state: 'idle' }
  | { state: 'downloading'; version: string }
  | { state: 'verifying'; version: string }
  | { state: 'ready'; version: string }
  | { state: 'error'; error: string }

let status: AutoUpdateStatus = { state: 'idle' }
let downloadInProgress = false

export function getAutoUpdateStatus(): AutoUpdateStatus {
  // Also check if an update is already staged
  if (status.state === 'idle' && fs.existsSync(VERSION_FILE)) {
    try {
      const info: UpdateVersionInfo = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf-8'))
      return { state: 'ready', version: info.version }
    } catch { /* ignore */ }
  }
  return status
}

// ── Boot health check ──────────────────────────────────────────

/**
 * Called on server startup. Cleans up stale user-space updates if the
 * bundled version is >= the user-space version (e.g. after a full installer
 * upgrade). Then writes a .booting marker for crash detection.
 * If the server survives 30s, clears the marker + crash count.
 */
export function initBootHealthCheck(): void {
  // Clean stale user-space updates: if user installed a full .pkg that is
  // equal or newer than the user-space version, delete ~/.quoroom/app/
  // so the wrapper script uses the bundled code and future auto-updates
  // work correctly.
  if (fs.existsSync(VERSION_FILE)) {
    try {
      const info: UpdateVersionInfo = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf-8'))
      const currentVersion = getCurrentVersion()
      if (info.version && !semverGt(info.version, currentVersion)) {
        console.error(`[auto-update] Cleaning stale user-space update v${info.version} (bundled is v${currentVersion})`)
        fs.rmSync(USER_APP_DIR, { recursive: true, force: true })
      }
    } catch { /* ignore */ }
  }

  if (!fs.existsSync(USER_APP_DIR)) return

  try {
    fs.writeFileSync(BOOT_MARKER, JSON.stringify({ pid: process.pid, at: Date.now() }))
  } catch { /* ignore */ }

  setTimeout(() => {
    // Server survived 30 seconds — mark as healthy
    try { fs.unlinkSync(BOOT_MARKER) } catch { /* ignore */ }
    try { fs.unlinkSync(CRASH_COUNT_FILE) } catch { /* ignore */ }
  }, 30_000)
}

// ── Download helpers ───────────────────────────────────────────

function followRedirects(url: string, maxRedirects = 5): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'))
    const parsed = new URL(url)
    const mod = parsed.protocol === 'https:' ? https : http
    const req = mod.get(url, { headers: { 'User-Agent': 'quoroom-auto-updater/1.0' } }, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location) {
        res.resume()
        followRedirects(res.headers.location, maxRedirects - 1).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      resolve(res)
    })
    req.on('error', reject)
    req.setTimeout(60_000, () => { req.destroy(); reject(new Error('Download timeout')) })
  })
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

// ── Core update logic ──────────────────────────────────────────

/**
 * Downloads and extracts the update bundle to a staging directory.
 */
async function downloadAndExtract(bundleUrl: string): Promise<void> {
  // Clean up any previous staging
  fs.rmSync(STAGING_DIR, { recursive: true, force: true })
  fs.mkdirSync(STAGING_DIR, { recursive: true })

  const tarballPath = path.join(STAGING_DIR, 'update.tar.gz')

  // Download the tarball
  const response = await followRedirects(bundleUrl)
  const fileStream = fs.createWriteStream(tarballPath)
  await pipeline(response, fileStream)

  // Extract — strip 1 level (the update bundle has a top-level dir)
  // The tar package from npm handles this, but we use node:zlib + simple extraction
  await extractTarGz(tarballPath, STAGING_DIR)

  // Clean up the tarball
  fs.unlinkSync(tarballPath)
}

/**
 * Extract a .tar.gz to a destination directory using the system tar command.
 */
async function extractTarGz(tarballPath: string, destDir: string): Promise<void> {
  const { execSync } = await import('node:child_process')
  execSync(`tar xzf ${JSON.stringify(tarballPath)} -C ${JSON.stringify(destDir)}`, { stdio: 'ignore' })
}

/**
 * Verify checksums of extracted files against version.json.
 */
async function verifyUpdate(dir: string): Promise<UpdateVersionInfo> {
  const versionPath = path.join(dir, 'version.json')
  if (!fs.existsSync(versionPath)) {
    throw new Error('Missing version.json in update bundle')
  }

  const info: UpdateVersionInfo = JSON.parse(fs.readFileSync(versionPath, 'utf-8'))
  if (!info.version) {
    throw new Error('Invalid version.json: missing version field')
  }

  // Verify checksums if provided
  if (info.checksums) {
    for (const [relativePath, expectedHash] of Object.entries(info.checksums)) {
      const filePath = path.join(dir, relativePath)
      if (!fs.existsSync(filePath)) {
        throw new Error(`Missing file in update: ${relativePath}`)
      }
      const actualHash = await sha256File(filePath)
      if (actualHash !== expectedHash) {
        throw new Error(`Checksum mismatch for ${relativePath}`)
      }
    }
  }

  // Verify essential files exist
  const requiredFiles = ['lib/cli.js', 'lib/api-server.js', 'lib/server.js']
  for (const f of requiredFiles) {
    if (!fs.existsSync(path.join(dir, f))) {
      throw new Error(`Missing required file: ${f}`)
    }
  }

  return info
}

/**
 * Atomically swap staging directory into the user-space app directory.
 */
function applyUpdate(): void {
  // Remove old app dir (keep data files like .crash_count if they exist)
  fs.rmSync(USER_APP_DIR, { recursive: true, force: true })

  // Rename staging → app
  fs.renameSync(STAGING_DIR, USER_APP_DIR)
}

/**
 * Simple semver comparison: returns true if a > b.
 */
function semverGt(a: string, b: string): boolean {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const av = pa[i] ?? 0
    const bv = pb[i] ?? 0
    if (av > bv) return true
    if (av < bv) return false
  }
  return false
}

declare const __APP_VERSION__: string

function getCurrentVersion(): string {
  try {
    return typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : require('../../package.json').version
  } catch {
    return '0.0.0'
  }
}

/**
 * Check if a user-space update is already ready (downloaded and verified).
 */
export function getReadyUpdateVersion(): string | null {
  try {
    if (!fs.existsSync(VERSION_FILE)) return null
    const info: UpdateVersionInfo = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf-8'))
    if (info.version && semverGt(info.version, getCurrentVersion())) {
      return info.version
    }
    return null
  } catch {
    return null
  }
}

/**
 * Main entry point: download, verify, and stage an update.
 * Called by the update checker when a new version with an update bundle is detected.
 */
export async function checkAndApplyUpdate(bundleUrl: string, targetVersion: string): Promise<void> {
  if (downloadInProgress) return

  // Don't downgrade or re-apply current version
  const currentVersion = getCurrentVersion()
  if (!semverGt(targetVersion, currentVersion)) return

  // Don't re-download if we already have this version staged
  const readyVersion = getReadyUpdateVersion()
  if (readyVersion && !semverGt(targetVersion, readyVersion)) return

  downloadInProgress = true
  try {
    console.error(`[auto-update] Downloading update v${targetVersion}...`)
    status = { state: 'downloading', version: targetVersion }
    await downloadAndExtract(bundleUrl)

    console.error(`[auto-update] Verifying update v${targetVersion}...`)
    status = { state: 'verifying', version: targetVersion }
    const info = await verifyUpdate(STAGING_DIR)

    // Check minEngineVersion — if the bundled install is too old, skip
    if (info.minEngineVersion) {
      const currentVersion = getCurrentVersion()
      if (semverGt(info.minEngineVersion, currentVersion)) {
        console.error(`[auto-update] Update requires engine >= ${info.minEngineVersion}, current is ${currentVersion}. Skipping.`)
        fs.rmSync(STAGING_DIR, { recursive: true, force: true })
        status = { state: 'error', error: `Requires full installer (engine >= ${info.minEngineVersion})` }
        return
      }
    }

    console.error(`[auto-update] Applying update v${targetVersion}...`)
    applyUpdate()

    console.error(`[auto-update] Update v${targetVersion} ready! Restart to activate.`)
    status = { state: 'ready', version: targetVersion }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error(`[auto-update] Failed: ${message}`)
    status = { state: 'error', error: message }
    // Clean up staging on failure
    fs.rmSync(STAGING_DIR, { recursive: true, force: true })
  } finally {
    downloadInProgress = false
  }
}

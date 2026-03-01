import type { Router } from '../router'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getDataDir } from '../db'
import { getUpdateInfo, simulateUpdate, forceCheck, getAutoUpdateStatus, getReadyUpdateVersion, getUpdateDiagnostics } from '../updateChecker'
import { checkAndApplyUpdate } from '../autoUpdate'
import { getDeploymentMode } from '../auth'

const startedAt = Date.now()

declare const __APP_VERSION__: string

let cachedVersion: string | null = null
function getVersion(): string {
  if (cachedVersion) return cachedVersion
  try {
    cachedVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : require('../../../package.json').version
  } catch {
    cachedVersion = 'unknown'
  }
  return cachedVersion!
}

const execFileAsync = promisify(execFile)

type CliCheckResult = { available: boolean; version?: string }
const CLI_CACHE_MS = 30_000

let cachedClaude: CliCheckResult = { available: false }
let claudeCachedAt = 0
let claudeRefreshInFlight: Promise<void> | null = null

async function refreshClaude(): Promise<void> {
  try {
    const { stdout } = await execFileAsync('claude', ['--version'], { timeout: 5000 })
    cachedClaude = { available: true, version: stdout.trim() }
  } catch {
    cachedClaude = { available: false }
  }
  claudeCachedAt = Date.now()
}

function scheduleClaudeRefresh(force: boolean = false): void {
  if (!force && claudeCachedAt > 0 && Date.now() - claudeCachedAt < CLI_CACHE_MS) return
  if (claudeRefreshInFlight) return
  claudeRefreshInFlight = refreshClaude().finally(() => { claudeRefreshInFlight = null })
}

function getClaudeStatus(): CliCheckResult {
  scheduleClaudeRefresh()
  return cachedClaude
}

let cachedCodex: CliCheckResult = { available: false }
let codexCachedAt = 0
let codexRefreshInFlight: Promise<void> | null = null

async function refreshCodex(): Promise<void> {
  try {
    const { stdout } = await execFileAsync('codex', ['--version'], { timeout: 5000 })
    cachedCodex = { available: true, version: stdout.trim() }
  } catch {
    cachedCodex = { available: false }
  }
  codexCachedAt = Date.now()
}

function scheduleCodexRefresh(force: boolean = false): void {
  if (!force && codexCachedAt > 0 && Date.now() - codexCachedAt < CLI_CACHE_MS) return
  if (codexRefreshInFlight) return
  codexRefreshInFlight = refreshCodex().finally(() => { codexRefreshInFlight = null })
}

function getCodexStatus(): CliCheckResult {
  scheduleCodexRefresh()
  return cachedCodex
}

type StatusPart = 'storage' | 'providers' | 'resources' | 'update'

function parseStatusParts(raw: string | undefined): Set<StatusPart> | null {
  if (!raw || !raw.trim()) return null // null => include all parts
  const values = raw.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean)
  const set = new Set<StatusPart>()
  for (const part of values) {
    if (part === 'storage' || part === 'providers' || part === 'resources' || part === 'update') {
      set.add(part)
    }
  }
  return set
}

function warmStatusCaches(): void {
  // Startup warmup (async): route can still return immediately while these resolve.
  scheduleClaudeRefresh(true)
  scheduleCodexRefresh(true)
}

warmStatusCaches()

function getResources(): { cpuCount: number; loadAvg1m: number; loadAvg5m: number; memTotalGb: number; memFreeGb: number; memUsedPct: number } {
  const [load1, load5] = os.loadavg()
  const total = os.totalmem()
  const free = os.freemem()
  return {
    cpuCount: os.cpus().length,
    loadAvg1m: Math.round(load1 * 100) / 100,
    loadAvg5m: Math.round(load5 * 100) / 100,
    memTotalGb: Math.round(total / 1024 / 1024 / 1024 * 10) / 10,
    memFreeGb: Math.round(free / 1024 / 1024 / 1024 * 10) / 10,
    memUsedPct: Math.round((1 - free / total) * 100),
  }
}

export function registerStatusRoutes(router: Router): void {
  router.post('/api/status/simulate-update', async () => {
    await simulateUpdate()
    return { data: { ok: true } }
  })

  // Test endpoint: download an update bundle from a custom URL.
  // Usage: POST /api/status/test-auto-update { "url": "http://localhost:8199/quoroom-update-v99.tar.gz", "version": "99.0.0" }
  router.post('/api/status/test-auto-update', async (ctx) => {
    const { url, version } = (ctx.body ?? {}) as { url?: string; version?: string }
    if (!url || !version) return { error: 'Missing url or version', status: 400 }
    await checkAndApplyUpdate(url, version)
    return { data: { status: getAutoUpdateStatus(), readyVersion: getReadyUpdateVersion() } }
  })

  router.post('/api/status/check-update', async () => {
    await forceCheck({ ignoreBackoff: true })
    return { data: { updateInfo: getUpdateInfo() } }
  })

  router.get('/api/status', (ctx) => {
    const dataDir = getDataDir()
    const dbPath = ctx.db.name
    const deploymentMode = getDeploymentMode()
    const parts = parseStatusParts(ctx.query.parts)
    const include = (part: StatusPart): boolean => parts === null || parts.has(part)
    const pending: Partial<Record<'claude' | 'codex', boolean>> = {}

    const isCloud = deploymentMode === 'cloud'
    const data: Record<string, unknown> = {
      version: getVersion(),
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      deploymentMode,
      serverPlatform: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux',
      generatedAt: new Date().toISOString(),
    }

    if (include('storage') && !isCloud) {
      data.dataDir = dataDir
      data.dbPath = dbPath
    }
    if (include('providers')) {
      data.claude = getClaudeStatus()
      data.codex = getCodexStatus()
      pending.claude = claudeRefreshInFlight !== null
      pending.codex = codexRefreshInFlight !== null
    }
    if (include('resources')) {
      data.resources = getResources()
    }
    if (include('update')) {
      data.updateInfo = getUpdateInfo()
      data.autoUpdate = getAutoUpdateStatus()
      data.readyUpdateVersion = getReadyUpdateVersion()
      data.updateDiagnostics = getUpdateDiagnostics()
    }
    if (Object.keys(pending).length > 0) {
      data.pending = pending
    }

    return {
      data
    }
  })
}

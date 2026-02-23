import type { Router } from '../router'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getDataDir } from '../db'
import { invalidateOllamaCache } from '../../shared/model-provider'
import { isSupportedFreeOllamaModel, stripOllamaPrefix } from '../../shared/ollama-models'
import {
  isOllamaAvailable, listOllamaModels,
  ensureOllamaRunning, isModelInstalled, pullOllamaModel,
} from '../../shared/ollama-ensure'
import { getUpdateInfo, simulateUpdate, forceCheck } from '../updateChecker'
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

// Cache Ollama status for 30s to avoid hammering it on every UI poll
let cachedOllama: { available: boolean; models: Array<{ name: string; size: number }> } = {
  available: false,
  models: []
}
let ollamaCachedAt = 0
const OLLAMA_CACHE_MS = 30_000
let ollamaRefreshInFlight: Promise<void> | null = null

async function refreshOllama(): Promise<void> {
  const available = await isOllamaAvailable()
  const models = available ? await listOllamaModels() : []
  cachedOllama = { available, models }
  ollamaCachedAt = Date.now()
}

function scheduleOllamaRefresh(force: boolean = false): void {
  if (!force && ollamaCachedAt > 0 && Date.now() - ollamaCachedAt < OLLAMA_CACHE_MS) return
  if (ollamaRefreshInFlight) return
  ollamaRefreshInFlight = refreshOllama().finally(() => { ollamaRefreshInFlight = null })
}

function getOllamaStatus(): { available: boolean; models: Array<{ name: string; size: number }> } {
  scheduleOllamaRefresh()
  return cachedOllama
}

function resetOllamaCaches(): void {
  cachedOllama = { available: false, models: [] }
  ollamaCachedAt = 0
  invalidateOllamaCache()
}

type StatusPart = 'storage' | 'providers' | 'ollama' | 'resources' | 'update'

function parseStatusParts(raw: string | undefined): Set<StatusPart> | null {
  if (!raw || !raw.trim()) return null // null => include all parts
  const values = raw.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean)
  const set = new Set<StatusPart>()
  for (const part of values) {
    if (part === 'storage' || part === 'providers' || part === 'ollama' || part === 'resources' || part === 'update') {
      set.add(part)
    }
  }
  return set
}

function warmStatusCaches(): void {
  // Startup warmup (async): route can still return immediately while these resolve.
  scheduleClaudeRefresh(true)
  scheduleCodexRefresh(true)
  scheduleOllamaRefresh(true)
}

warmStatusCaches()

// Ollama helpers (hasOllamaBinary, installOllamaBinary, startOllamaServe, etc.)
// are in ../../shared/ollama-ensure.ts

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

  router.post('/api/status/check-update', async () => {
    await forceCheck()
    return { data: { updateInfo: getUpdateInfo() } }
  })

  router.post('/api/ollama/start', async () => {
    const result = await ensureOllamaRunning()
    resetOllamaCaches()
    scheduleOllamaRefresh(true)
    return { data: result }
  })

  router.post('/api/ollama/ensure-model', async (ctx) => {
    const body = ctx.body as Record<string, unknown> || {}
    const requestedModel = typeof body.model === 'string' ? body.model.trim() : ''
    if (!requestedModel) return { status: 400, error: 'model is required' }
    if (!isSupportedFreeOllamaModel(requestedModel)) {
      return { status: 400, error: `Unsupported free Ollama model: ${requestedModel}` }
    }

    const normalizedModel = stripOllamaPrefix(requestedModel)
    const running = await ensureOllamaRunning()
    if (!running.available) {
      return { status: 500, error: `Ollama unavailable (${running.status})` }
    }

    const installedModels = await listOllamaModels()
    if (isModelInstalled(installedModels, normalizedModel)) {
      resetOllamaCaches()
      scheduleOllamaRefresh(true)
      return { data: { ok: true, status: 'ready', model: `ollama:${normalizedModel}` } }
    }

    const pulled = await pullOllamaModel(normalizedModel)
    if (!pulled.ok) return { status: 500, error: `Failed to pull model ${normalizedModel}: ${pulled.error}` }
    resetOllamaCaches()
    scheduleOllamaRefresh(true)
    return { data: { ok: true, status: 'pulled', model: `ollama:${normalizedModel}` } }
  })

  router.get('/api/status', (ctx) => {
    const dataDir = getDataDir()
    const dbPath = ctx.db.name
    const deploymentMode = getDeploymentMode()
    const parts = parseStatusParts(ctx.query.parts)
    const include = (part: StatusPart): boolean => parts === null || parts.has(part)
    const pending: Partial<Record<'claude' | 'codex' | 'ollama', boolean>> = {}

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
    if (include('ollama')) {
      data.ollama = getOllamaStatus()
      pending.ollama = ollamaRefreshInFlight !== null
    }
    if (include('resources')) {
      data.resources = getResources()
    }
    if (include('update')) {
      data.updateInfo = getUpdateInfo()
    }
    if (Object.keys(pending).length > 0) {
      data.pending = pending
    }

    return {
      data
    }
  })
}

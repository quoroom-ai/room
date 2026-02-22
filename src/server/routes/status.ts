import type { Router } from '../router'
import { execSync, spawn } from 'node:child_process'
import os from 'node:os'
import { getDataDir } from '../db'
import { isOllamaAvailable, listOllamaModels } from '../../shared/agent-executor'
import { invalidateOllamaCache } from '../../shared/model-provider'
import { isSupportedFreeOllamaModel, stripOllamaPrefix } from '../../shared/ollama-models'
import { getUpdateInfo, simulateUpdate } from '../updateChecker'
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

function checkClaude(): { available: boolean; version?: string } {
  try {
    const out = execSync('claude --version 2>/dev/null', { timeout: 5000 }).toString().trim()
    return { available: true, version: out }
  } catch {
    return { available: false }
  }
}

function checkCodex(): { available: boolean; version?: string } {
  try {
    const out = execSync('codex --version 2>/dev/null', { timeout: 5000 }).toString().trim()
    return { available: true, version: out }
  } catch {
    return { available: false }
  }
}

// Cache Ollama status for 30s to avoid hammering it on every UI poll
let cachedOllama: { available: boolean; models: Array<{ name: string; size: number }> } | null = null
let ollamaCachedAt = 0
const OLLAMA_CACHE_MS = 30_000
const OLLAMA_INSTALL_TIMEOUT_MS = 10 * 60 * 1000
const OLLAMA_STARTUP_TIMEOUT_MS = 30_000

async function checkOllama(): Promise<{ available: boolean; models: Array<{ name: string; size: number }> }> {
  if (cachedOllama && Date.now() - ollamaCachedAt < OLLAMA_CACHE_MS) return cachedOllama
  const available = await isOllamaAvailable()
  const models = available ? await listOllamaModels() : []
  cachedOllama = { available, models }
  ollamaCachedAt = Date.now()
  return cachedOllama
}

function resetOllamaCaches(): void {
  cachedOllama = null
  ollamaCachedAt = 0
  invalidateOllamaCache()
}

function hasOllamaBinary(): boolean {
  try {
    execSync('which ollama 2>/dev/null', { timeout: 3000 })
    return true
  } catch {
    return false
  }
}

function installOllamaBinary(): boolean {
  try {
    if (process.platform === 'darwin') {
      execSync('brew install ollama 2>&1', { timeout: OLLAMA_INSTALL_TIMEOUT_MS })
    } else {
      execSync('curl -fsSL https://ollama.com/install.sh | sh 2>&1', { timeout: OLLAMA_INSTALL_TIMEOUT_MS })
    }
    return true
  } catch {
    return false
  }
}

function startOllamaServe(): boolean {
  try {
    const child = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

async function waitForOllamaAvailable(timeoutMs: number = OLLAMA_STARTUP_TIMEOUT_MS): Promise<boolean> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await isOllamaAvailable()) return true
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return false
}

async function ensureOllamaRunning(): Promise<{ available: boolean; status: 'running' | 'install_failed' | 'start_failed' }> {
  const already = await isOllamaAvailable()
  if (already) return { available: true, status: 'running' }

  if (!hasOllamaBinary() && !installOllamaBinary()) {
    return { available: false, status: 'install_failed' }
  }
  if (!startOllamaServe()) {
    return { available: false, status: 'start_failed' }
  }

  const available = await waitForOllamaAvailable()
  return { available, status: available ? 'running' : 'start_failed' }
}

function isModelInstalled(models: Array<{ name: string; size: number }>, requested: string): boolean {
  const requestedLower = requested.toLowerCase()
  for (const model of models) {
    const installedName = model.name.toLowerCase()
    if (installedName === requestedLower) return true
    if (!requestedLower.includes(':') && installedName === `${requestedLower}:latest`) return true
    if (requestedLower.endsWith(':latest') && installedName === requestedLower.slice(0, -7)) return true
  }
  return false
}

async function pullOllamaModel(model: string): Promise<{ ok: true } | { ok: false; error: string }> {
  return await new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let proc: ReturnType<typeof spawn>

    try {
      proc = spawn('ollama', ['pull', model], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      resolve({ ok: false, error: `Failed to start ollama pull: ${message}` })
      return
    }

    const finish = (result: { ok: true } | { ok: false; error: string }): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      finish({ ok: false, error: `Timed out while pulling model ${model}` })
    }, 15 * 60 * 1000)

    proc.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    proc.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      const message = err instanceof Error ? err.message : String(err)
      finish({ ok: false, error: `ollama pull failed: ${message}` })
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        finish({ ok: true })
        return
      }
      const details = `${stderr}\n${stdout}`.trim().split('\n').slice(-3).join('\n')
      finish({ ok: false, error: details || `ollama pull exited with code ${code ?? -1}` })
    })
  })
}

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

  router.post('/api/ollama/start', async () => {
    const result = await ensureOllamaRunning()
    resetOllamaCaches()
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
      return { data: { ok: true, status: 'ready', model: `ollama:${normalizedModel}` } }
    }

    const pulled = await pullOllamaModel(normalizedModel)
    if (!pulled.ok) return { status: 500, error: `Failed to pull model ${normalizedModel}: ${pulled.error}` }
    resetOllamaCaches()
    return { data: { ok: true, status: 'pulled', model: `ollama:${normalizedModel}` } }
  })

  router.get('/api/status', async (ctx) => {
    const dataDir = getDataDir()
    const dbPath = ctx.db.name
    const claude = checkClaude()
    const codex = checkCodex()
    const ollama = await checkOllama()
    const resources = getResources()
    const deploymentMode = getDeploymentMode()

    const isCloud = deploymentMode === 'cloud'
    return {
      data: {
        version: getVersion(),
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        ...(!isCloud && { dataDir, dbPath }),
        claude,
        codex,
        ollama,
        resources,
        deploymentMode,
        updateInfo: getUpdateInfo(),
        serverPlatform: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux',
      }
    }
  })
}

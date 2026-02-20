import type { Router } from '../router'
import { execSync } from 'node:child_process'
import os from 'node:os'
import { getDataDir } from '../db'
import { isOllamaAvailable, listOllamaModels } from '../../shared/agent-executor'
import { getUpdateInfo, simulateUpdate } from '../updateChecker'

const startedAt = Date.now()

let cachedVersion: string | null = null
function getVersion(): string {
  if (cachedVersion) return cachedVersion
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cachedVersion = require('../../../package.json').version
  } catch {
    cachedVersion = 'unknown'
  }
  return cachedVersion!
}

let cachedClaudeCheck: { available: boolean; version?: string } | null = null
function checkClaude(): { available: boolean; version?: string } {
  if (cachedClaudeCheck) return cachedClaudeCheck
  try {
    const out = execSync('claude --version 2>/dev/null', { timeout: 5000 }).toString().trim()
    cachedClaudeCheck = { available: true, version: out }
  } catch {
    cachedClaudeCheck = { available: false }
  }
  return cachedClaudeCheck
}

// Cache Ollama status for 30s to avoid hammering it on every UI poll
let cachedOllama: { available: boolean; models: Array<{ name: string; size: number }> } | null = null
let ollamaCachedAt = 0
const OLLAMA_CACHE_MS = 30_000

async function checkOllama(): Promise<{ available: boolean; models: Array<{ name: string; size: number }> }> {
  if (cachedOllama && Date.now() - ollamaCachedAt < OLLAMA_CACHE_MS) return cachedOllama
  const available = await isOllamaAvailable()
  const models = available ? await listOllamaModels() : []
  cachedOllama = { available, models }
  ollamaCachedAt = Date.now()
  return cachedOllama
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

  router.get('/api/status', async (ctx) => {
    const dataDir = getDataDir()
    const dbPath = ctx.db.name
    const claude = checkClaude()
    const ollama = await checkOllama()
    const resources = getResources()

    return {
      data: {
        version: getVersion(),
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        dataDir,
        dbPath,
        claude,
        ollama,
        resources,
        updateInfo: getUpdateInfo(),
        serverPlatform: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux',
      }
    }
  })
}

import { createHash } from 'crypto'
import { hostname, userInfo } from 'os'
import { homedir, mkdirSync, readFileSync, writeFileSync, existsSync, accessSync, constants } from 'fs'
import { join, dirname } from 'path'

// ─── Configuration ──────────────────────────────────────────
const GITHUB_API = 'https://api.github.com'
const REPO = 'quoroom-ai/room'
const HEARTBEAT_ISSUE_NUMBER = 1 // Pinned "Telemetry" issue — update after creating it
const TELEMETRY_TOKEN = process.env.QUOROOM_TELEMETRY_TOKEN ?? ''

/** Returns true if a telemetry token is available (build-time injected). */
export function isTelemetryEnabled(): boolean {
  return TELEMETRY_TOKEN.length > 0
}

// ─── Machine ID ─────────────────────────────────────────────
let cachedMachineId: string | null = null

/**
 * Path to persist the machine ID across restarts.
 * Primary: ~/.quoroom/machine-id
 * Fallback: /tmp/.quoroom-machine-id (for Docker/containers)
 */
const MACHINE_ID_PATH_PRIMARY = join(homedir(), '.quoroom', 'machine-id')
const MACHINE_ID_PATH_FALLBACK = '/tmp/.quoroom-machine-id'

/**
 * Check if a path is writable
 */
function isPathWritable(path: string): boolean {
  try {
    const dir = dirname(path)
    if (!existsSync(dir)) {
      // Try to create the directory
      mkdirSync(dir, { recursive: true })
    }
    accessSync(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Generate or retrieve a stable, anonymous machine identifier.
 * Uses a cryptographically random 12-byte hex string (24 chars).
 * 
 * Migration Strategy:
 * - Old IDs (based on hostname+username) are NOT migrated
 * - This is a deliberate security reset: anonymous IDs should not be linkable
 * - Telemetry data is anonymous by design, so no historical data is lost
 * 
 * Persistence Strategy:
 * - Primary: ~/.quoroom/machine-id (standard user environment)
 * - Fallback: /tmp/.quoroom-machine-id (Docker/containers with restricted home)
 * - Last Resort: In-memory random ID (ephemeral, resets on restart)
 * 
 * NOT reversible to actual identity.
 */
export function getMachineId(): string {
  if (cachedMachineId) return cachedMachineId
  
  const pathsToTry = [MACHINE_ID_PATH_PRIMARY, MACHINE_ID_PATH_FALLBACK]
  let usedPath: string | null = null
  
  try {
    // Try each path in order
    for (const path of pathsToTry) {
      if (existsSync(path)) {
        const stored = readFileSync(path, 'utf8').trim()
        if (stored.length === 24 && /^[0-9a-f]+$/.test(stored)) {
          cachedMachineId = stored
          usedPath = path
          break
        }
      }
      
      // If file doesn't exist or is invalid, try to write to this path
      if (isPathWritable(path)) {
        const randomId = crypto.randomBytes(12).toString('hex')
        cachedMachineId = randomId
        usedPath = path
        
        // Persist the ID
        try {
          const dir = dirname(path)
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
          writeFileSync(path, randomId, 'utf8')
        } catch (persistErr) {
          console.warn('[telemetry] Failed to persist machine ID to', path, ':', persistErr)
          // Continue to next path or fallback
          cachedMachineId = null
          usedPath = null
          continue
        }
        break
      }
    }
    
    // If all persistence attempts failed, use in-memory random ID
    if (!cachedMachineId) {
      cachedMachineId = crypto.randomBytes(12).toString('hex')
      console.warn('[telemetry] All persistence paths failed. Using ephemeral in-memory ID. Telemetry data will not be linkable across restarts.')
    }
  } catch {
    // Ultimate fallback
    cachedMachineId = crypto.randomBytes(12).toString('hex')
    console.warn('[telemetry] Critical error in ID generation. Using random in-memory ID.')
  }
  
  return cachedMachineId!
}

// ─── Crash Reports ──────────────────────────────────────────
export interface CrashReport {
  error: string
  stack: string
  process: string // 'main' | 'sidecar' | 'mcp'
  version: string
  os: string
  nodeVersion: string
  timestamp: string
  machineId: string
}

/**
 * Submit a crash report as a GitHub Issue (or comment on existing duplicate).
 * Non-fatal: all errors are caught and logged to stderr.
 */
export async function submitCrashReport(report: CrashReport): Promise<void> {
  if (!isTelemetryEnabled()) return
  try {
    const titlePrefix = truncate(`Crash: ${report.error}`, 80)
    const title = `${titlePrefix} (${report.process}, v${report.version})`
    const body = [
      `**Process:** ${report.process}`,
      `**Version:** ${report.version}`,
      `**OS:** ${report.os}`,
      `**Node.js:** ${report.nodeVersion}`,
      `**Machine:** ${report.machineId}`,
      `**Timestamp:** ${report.timestamp}`,
      '',
      '**Error:**',
      '```',
      report.error,
      '```',
      '',
      '**Stack trace:**',
      '```',
      report.stack || '(no stack)',
      '```',
      '',
      '_Auto-filed by Quoroom telemetry_'
    ].join('\n')

    // Search for existing open issue with same crash
    const existing = await searchIssue(titlePrefix)
    if (existing) {
      // Add comment to existing issue instead of creating duplicate
      await githubPost(`/repos/${REPO}/issues/${existing}/comments`, { body })
    } else {
      await githubPost(`/repos/${REPO}/issues`, {
        title: truncate(title, 120),
        body,
        labels: ['crash-report']
      })
    }
  } catch (err) {
    console.error('[telemetry] Failed to submit crash report:', err instanceof Error ? err.message : err)
  }
}

// ─── Heartbeat ──────────────────────────────────────────────
export interface HeartbeatData {
  version: string
  os: string
  machineId: string
  taskCount: number
  workerCount: number
  memoryCount: number
}

/**
 * Submit a daily heartbeat as a comment on the telemetry tracking issue.
 * Non-fatal: all errors are caught and logged to stderr.
 */
export async function submitHeartbeat(data: HeartbeatData): Promise<void> {
  if (!isTelemetryEnabled()) return
  try {
    const date = new Date().toISOString().slice(0, 10)
    const body = `${data.machineId} | v${data.version} | ${data.os} | tasks:${data.taskCount} workers:${data.workerCount} memories:${data.memoryCount} | ${date}`
    await githubPost(`/repos/${REPO}/issues/${HEARTBEAT_ISSUE_NUMBER}/comments`, { body })
  } catch (err) {
    console.error('[telemetry] Failed to submit heartbeat:', err instanceof Error ? err.message : err)
  }
}

// ─── GitHub API helpers ─────────────────────────────────────
async function githubPost(path: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TELEMETRY_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'Quoroom-Telemetry',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  })
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${await res.text().catch(() => 'unknown')}`)
  }
  return res.json()
}

async function searchIssue(titlePrefix: string): Promise<number | null> {
  const query = encodeURIComponent(`repo:${REPO} is:issue is:open in:title "${titlePrefix}"`)
  const res = await fetch(`${GITHUB_API}/search/issues?q=${query}&per_page=1`, {
    headers: {
      'Authorization': `Bearer ${TELEMETRY_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'Quoroom-Telemetry',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    signal: AbortSignal.timeout(10000)
  })
  if (!res.ok) return null
  const data = (await res.json()) as { items?: Array<{ number: number }> }
  return data.items?.[0]?.number ?? null
}

// ─── Utilities ──────────────────────────────────────────────
function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '\u2026' : text
}

import { createHash } from 'crypto'
import { hostname, userInfo } from 'os'

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
 * Generate a stable, anonymous machine identifier.
 * SHA-256 hash of hostname + username, truncated to 12 hex chars.
 * Not reversible to actual identity.
 */
export function getMachineId(): string {
  if (cachedMachineId) return cachedMachineId
  try {
    const raw = hostname() + userInfo().username
    cachedMachineId = createHash('sha256').update(raw).digest('hex').slice(0, 12)
  } catch {
    cachedMachineId = 'unknown'
  }
  return cachedMachineId
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

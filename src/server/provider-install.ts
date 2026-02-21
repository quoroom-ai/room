import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { eventBus } from './event-bus'
import type { ProviderName } from './provider-auth'
import { probeProviderInstalled } from './provider-cli'

export type ProviderInstallStatus = 'starting' | 'running' | 'completed' | 'failed' | 'canceled' | 'timeout'

interface ProviderInstallCommand {
  command: string
  args: string[]
}

export interface ProviderInstallLine {
  id: number
  stream: 'stdout' | 'stderr' | 'system'
  text: string
  timestamp: string
}

export interface ProviderInstallSessionView {
  sessionId: string
  provider: ProviderName
  status: ProviderInstallStatus
  command: string
  startedAt: string
  updatedAt: string
  endedAt: string | null
  exitCode: number | null
  active: boolean
  lines: ProviderInstallLine[]
}

interface ProviderInstallSessionInternal {
  sessionId: string
  provider: ProviderName
  command: string
  status: ProviderInstallStatus
  process: ChildProcessWithoutNullStreams
  startedAt: string
  updatedAt: string
  endedAt: string | null
  exitCode: number | null
  lines: ProviderInstallLine[]
  lineSeq: number
  stdoutBuffer: string
  stderrBuffer: string
  timeout: NodeJS.Timeout
  stopReason: 'canceled' | 'timeout' | null
}

const sessionStore = new Map<string, ProviderInstallSessionInternal>()
const activeByProvider = new Map<ProviderName, string>()
const MAX_LINES = Math.max(50, parseInt(process.env.QUOROOM_PROVIDER_INSTALL_MAX_LINES || '300', 10) || 300)
const SESSION_TIMEOUT_MS = Math.max(30_000, parseInt(process.env.QUOROOM_PROVIDER_INSTALL_TIMEOUT_MS || '900000', 10) || 900000)
const SESSION_TTL_MS = Math.max(60_000, parseInt(process.env.QUOROOM_PROVIDER_INSTALL_TTL_MS || '7200000', 10) || 7200000)

function nowIso(): string {
  return new Date().toISOString()
}

export function getNpmCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'npm.cmd' : 'npm'
}

export function getProviderInstallCommand(
  provider: ProviderName,
  platform: NodeJS.Platform = process.platform
): ProviderInstallCommand {
  const npmCommand = getNpmCommand(platform)
  const pkg = provider === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-code'
  return {
    command: npmCommand,
    args: ['install', '-g', pkg],
  }
}

function addGlobalNpmBinToPath(platform: NodeJS.Platform = process.platform): void {
  const npmCommand = getNpmCommand(platform)
  try {
    const npmBin = execFileSync(npmCommand, ['bin', '-g'], { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    if (!npmBin) return
    const currentPath = process.env.PATH || ''
    const parts = currentPath.split(path.delimiter).filter(Boolean)
    if (parts.includes(npmBin)) return
    process.env.PATH = `${npmBin}${path.delimiter}${currentPath}`
  } catch {
    // Ignore path refresh failures; verification still probes current PATH.
  }
}

function isActiveStatus(status: ProviderInstallStatus): boolean {
  return status === 'starting' || status === 'running'
}

function toSessionView(session: ProviderInstallSessionInternal, includeLines = true): ProviderInstallSessionView {
  return {
    sessionId: session.sessionId,
    provider: session.provider,
    status: session.status,
    command: session.command,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    endedAt: session.endedAt,
    exitCode: session.exitCode,
    active: isActiveStatus(session.status),
    lines: includeLines ? [...session.lines] : [],
  }
}

function emitSessionStatus(session: ProviderInstallSessionInternal): void {
  eventBus.emit(`provider-install:${session.sessionId}`, 'provider_install:status', toSessionView(session, false))
}

function emitSessionLine(session: ProviderInstallSessionInternal, line: ProviderInstallLine): void {
  eventBus.emit(`provider-install:${session.sessionId}`, 'provider_install:line', {
    sessionId: session.sessionId,
    provider: session.provider,
    ...line,
  })
}

function appendLine(
  session: ProviderInstallSessionInternal,
  stream: 'stdout' | 'stderr' | 'system',
  rawText: string
): void {
  const text = rawText.trim()
  if (!text) return

  const line: ProviderInstallLine = {
    id: ++session.lineSeq,
    stream,
    text,
    timestamp: nowIso(),
  }
  session.lines.push(line)
  if (session.lines.length > MAX_LINES) {
    session.lines.splice(0, session.lines.length - MAX_LINES)
  }
  session.updatedAt = line.timestamp
  emitSessionLine(session, line)
}

function consumeChunk(
  session: ProviderInstallSessionInternal,
  stream: 'stdout' | 'stderr',
  chunk: Buffer
): void {
  const text = chunk.toString('utf8')
  const buffer = stream === 'stdout' ? session.stdoutBuffer + text : session.stderrBuffer + text
  const parts = buffer.split(/\r?\n/)
  const remainder = parts.pop() ?? ''
  for (const line of parts) appendLine(session, stream, line)
  if (stream === 'stdout') session.stdoutBuffer = remainder
  else session.stderrBuffer = remainder
}

function flushBufferedLines(session: ProviderInstallSessionInternal): void {
  if (session.stdoutBuffer.trim()) appendLine(session, 'stdout', session.stdoutBuffer)
  if (session.stderrBuffer.trim()) appendLine(session, 'stderr', session.stderrBuffer)
  session.stdoutBuffer = ''
  session.stderrBuffer = ''
}

function finalizeSession(
  session: ProviderInstallSessionInternal,
  status: Exclude<ProviderInstallStatus, 'starting' | 'running'>,
  exitCode: number | null
): void {
  if (!isActiveStatus(session.status)) return
  clearTimeout(session.timeout)
  flushBufferedLines(session)
  session.status = status
  session.exitCode = exitCode
  session.endedAt = nowIso()
  session.updatedAt = session.endedAt
  if (activeByProvider.get(session.provider) === session.sessionId) {
    activeByProvider.delete(session.provider)
  }
  emitSessionStatus(session)
}

function pruneOldSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS
  for (const [id, session] of sessionStore.entries()) {
    if (isActiveStatus(session.status)) continue
    const endedAtMs = session.endedAt ? Date.parse(session.endedAt) : Date.parse(session.updatedAt)
    if (Number.isFinite(endedAtMs) && endedAtMs < cutoff) {
      sessionStore.delete(id)
    }
  }
}

function getActiveSession(provider: ProviderName): ProviderInstallSessionInternal | null {
  const sessionId = activeByProvider.get(provider)
  if (!sessionId) return null
  const session = sessionStore.get(sessionId)
  if (!session) {
    activeByProvider.delete(provider)
    return null
  }
  if (!isActiveStatus(session.status)) {
    activeByProvider.delete(provider)
    return null
  }
  return session
}

function getLatestSession(provider: ProviderName): ProviderInstallSessionInternal | null {
  let latest: ProviderInstallSessionInternal | null = null
  for (const session of sessionStore.values()) {
    if (session.provider !== provider) continue
    if (!latest || Date.parse(session.startedAt) > Date.parse(latest.startedAt)) {
      latest = session
    }
  }
  return latest
}

export function getProviderInstallSession(sessionId: string): ProviderInstallSessionView | null {
  pruneOldSessions()
  const session = sessionStore.get(sessionId)
  if (!session) return null
  return toSessionView(session, true)
}

export function getLatestProviderInstallSession(provider: ProviderName): ProviderInstallSessionView | null {
  pruneOldSessions()
  const session = getLatestSession(provider)
  if (!session) return null
  return toSessionView(session, true)
}

export function cancelProviderInstallSession(sessionId: string): ProviderInstallSessionView | null {
  const session = sessionStore.get(sessionId)
  if (!session) return null
  if (!isActiveStatus(session.status)) return toSessionView(session, true)

  session.stopReason = 'canceled'
  appendLine(session, 'system', 'Cancel requested. Stopping install process...')
  try {
    session.process.kill('SIGTERM')
  } catch {}

  setTimeout(() => {
    if (isActiveStatus(session.status)) {
      try {
        session.process.kill('SIGKILL')
      } catch {}
    }
  }, 2000).unref()

  return toSessionView(session, true)
}

export function startProviderInstallSession(provider: ProviderName): {
  session: ProviderInstallSessionView
  reused: boolean
} {
  pruneOldSessions()
  const existing = getActiveSession(provider)
  if (existing) {
    return { session: toSessionView(existing, true), reused: true }
  }

  const cmd = getProviderInstallCommand(provider)
  const displayCommand = [cmd.command, ...cmd.args].join(' ')
  const child = spawn(cmd.command, cmd.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
  })

  const startedAt = nowIso()
  const session: ProviderInstallSessionInternal = {
    sessionId: randomUUID(),
    provider,
    command: displayCommand,
    status: 'starting',
    process: child,
    startedAt,
    updatedAt: startedAt,
    endedAt: null,
    exitCode: null,
    lines: [],
    lineSeq: 0,
    stdoutBuffer: '',
    stderrBuffer: '',
    timeout: setTimeout(() => {
      if (!isActiveStatus(session.status)) return
      session.stopReason = 'timeout'
      appendLine(session, 'system', 'Install timed out. Start a new install session to retry.')
      try {
        session.process.kill('SIGTERM')
      } catch {}
      setTimeout(() => {
        if (isActiveStatus(session.status)) {
          try {
            session.process.kill('SIGKILL')
          } catch {}
        }
      }, 2000).unref()
    }, SESSION_TIMEOUT_MS),
    stopReason: null,
  }

  sessionStore.set(session.sessionId, session)
  activeByProvider.set(provider, session.sessionId)

  appendLine(session, 'system', `Starting ${displayCommand}`)
  session.status = 'running'
  emitSessionStatus(session)

  child.stdout.on('data', (chunk: Buffer) => consumeChunk(session, 'stdout', chunk))
  child.stderr.on('data', (chunk: Buffer) => consumeChunk(session, 'stderr', chunk))

  child.on('error', (err: Error) => {
    appendLine(session, 'stderr', err.message || `${provider} install failed to start`)
    finalizeSession(session, 'failed', null)
  })

  child.on('close', (code: number | null) => {
    if (session.stopReason === 'timeout') {
      finalizeSession(session, 'timeout', code)
      return
    }
    if (session.stopReason === 'canceled') {
      finalizeSession(session, 'canceled', code)
      return
    }
    if (code !== 0) {
      appendLine(session, 'system', `Install exited with code ${code ?? -1}.`)
      finalizeSession(session, 'failed', code)
      return
    }

    addGlobalNpmBinToPath()
    const probe = probeProviderInstalled(provider)
    if (!probe.installed) {
      appendLine(session, 'system', `Install command exited successfully, but ${provider} is still unavailable in PATH.`)
      finalizeSession(session, 'failed', code)
      return
    }

    appendLine(
      session,
      'system',
      `${provider} CLI installed${probe.version ? ` (${probe.version})` : ''}.`
    )
    finalizeSession(session, 'completed', code)
  })

  return { session: toSessionView(session, true), reused: false }
}

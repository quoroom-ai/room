import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { eventBus } from './event-bus'
import { getProviderCliCommand } from './provider-cli'

export type ProviderName = 'codex' | 'claude'
export type ProviderAuthStatus = 'starting' | 'running' | 'completed' | 'failed' | 'canceled' | 'timeout'

interface ProviderCommand {
  command: string
  args: string[]
}

export interface ProviderAuthLine {
  id: number
  stream: 'stdout' | 'stderr' | 'system'
  text: string
  timestamp: string
}

export interface ProviderAuthSessionView {
  sessionId: string
  provider: ProviderName
  status: ProviderAuthStatus
  command: string
  startedAt: string
  updatedAt: string
  endedAt: string | null
  exitCode: number | null
  verificationUrl: string | null
  deviceCode: string | null
  active: boolean
  lines: ProviderAuthLine[]
}

interface ProviderAuthSessionInternal {
  sessionId: string
  provider: ProviderName
  command: string
  status: ProviderAuthStatus
  process: ChildProcessWithoutNullStreams
  startedAt: string
  updatedAt: string
  endedAt: string | null
  exitCode: number | null
  verificationUrl: string | null
  deviceCode: string | null
  lines: ProviderAuthLine[]
  lineSeq: number
  stdoutBuffer: string
  stderrBuffer: string
  timeout: NodeJS.Timeout
  stopReason: 'canceled' | 'timeout' | null
}

const sessionStore = new Map<string, ProviderAuthSessionInternal>()
const activeByProvider = new Map<ProviderName, string>()
const MAX_LINES = Math.max(50, parseInt(process.env.QUOROOM_PROVIDER_AUTH_MAX_LINES || '300', 10) || 300)
const SESSION_TIMEOUT_MS = Math.max(30_000, parseInt(process.env.QUOROOM_PROVIDER_AUTH_TIMEOUT_MS || '900000', 10) || 900000)
const SESSION_TTL_MS = Math.max(60_000, parseInt(process.env.QUOROOM_PROVIDER_AUTH_TTL_MS || '7200000', 10) || 7200000)

export interface ProviderAuthHints {
  verificationUrl: string | null
  deviceCode: string | null
}

function nowIso(): string {
  return new Date().toISOString()
}

function getProviderCommand(provider: ProviderName): ProviderCommand {
  const command = getProviderCliCommand(provider)
  return { command, args: ['login'] }
}

function isActiveStatus(status: ProviderAuthStatus): boolean {
  return status === 'starting' || status === 'running'
}

function emitSessionStatus(session: ProviderAuthSessionInternal): void {
  eventBus.emit(`provider-auth:${session.sessionId}`, 'provider_auth:status', toSessionView(session, false))
  eventBus.emit('providers', 'providers:auth_status', {
    provider: session.provider,
    sessionId: session.sessionId,
    status: session.status,
    active: isActiveStatus(session.status),
    updatedAt: session.updatedAt,
  })
}

function emitSessionLine(
  session: ProviderAuthSessionInternal,
  line: ProviderAuthLine
): void {
  eventBus.emit(`provider-auth:${session.sessionId}`, 'provider_auth:line', {
    sessionId: session.sessionId,
    provider: session.provider,
    ...line,
    deviceCode: session.deviceCode,
    verificationUrl: session.verificationUrl,
  })
}

export function extractProviderAuthHints(text: string): ProviderAuthHints {
  const hints: ProviderAuthHints = {
    verificationUrl: null,
    deviceCode: null,
  }
  const urlMatch = text.match(/\bhttps?:\/\/[^\s)]+/i)
  if (urlMatch) {
    hints.verificationUrl = urlMatch[0]
  }
  const codePatterns = [
    /\bdevice code(?:\s+is|:)?\s*([A-Z0-9-]{4,})\b/i,
    /\bverification code(?:\s+is|:)?\s*([A-Z0-9-]{4,})\b/i,
    /\bcode(?:\s+is|:)\s*([A-Z0-9-]{4,})\b/i,
    /\benter\s+code\s*([A-Z0-9-]{4,})\b/i,
  ]
  for (const pattern of codePatterns) {
    const match = text.match(pattern)
    if (match && match[1]) {
      hints.deviceCode = match[1].toUpperCase()
      break
    }
  }
  return hints
}

function applyHintsFromText(session: ProviderAuthSessionInternal, text: string): boolean {
  const hints = extractProviderAuthHints(text)
  let changed = false
  if (hints.verificationUrl && !session.verificationUrl) {
    session.verificationUrl = hints.verificationUrl
    changed = true
  }
  if (hints.deviceCode && session.deviceCode !== hints.deviceCode) {
    session.deviceCode = hints.deviceCode
    changed = true
  }
  return changed
}

function appendLine(
  session: ProviderAuthSessionInternal,
  stream: 'stdout' | 'stderr' | 'system',
  rawText: string
): void {
  const text = rawText.trim()
  if (!text) return

  const line: ProviderAuthLine = {
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
  const hintsChanged = applyHintsFromText(session, text)

  emitSessionLine(session, line)
  if (hintsChanged) emitSessionStatus(session)
}

function flushBufferedLines(session: ProviderAuthSessionInternal): void {
  if (session.stdoutBuffer.trim()) appendLine(session, 'stdout', session.stdoutBuffer)
  if (session.stderrBuffer.trim()) appendLine(session, 'stderr', session.stderrBuffer)
  session.stdoutBuffer = ''
  session.stderrBuffer = ''
}

function consumeChunk(
  session: ProviderAuthSessionInternal,
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

function toSessionView(
  session: ProviderAuthSessionInternal,
  includeLines = true
): ProviderAuthSessionView {
  return {
    sessionId: session.sessionId,
    provider: session.provider,
    status: session.status,
    command: session.command,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    endedAt: session.endedAt,
    exitCode: session.exitCode,
    verificationUrl: session.verificationUrl,
    deviceCode: session.deviceCode,
    active: isActiveStatus(session.status),
    lines: includeLines ? [...session.lines] : [],
  }
}

function finalizeSession(
  session: ProviderAuthSessionInternal,
  status: Exclude<ProviderAuthStatus, 'starting' | 'running'>,
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

function getActiveSession(provider: ProviderName): ProviderAuthSessionInternal | null {
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

function getLatestSession(provider: ProviderName): ProviderAuthSessionInternal | null {
  let latest: ProviderAuthSessionInternal | null = null
  for (const session of sessionStore.values()) {
    if (session.provider !== provider) continue
    if (!latest) {
      latest = session
      continue
    }
    if (Date.parse(session.startedAt) > Date.parse(latest.startedAt)) {
      latest = session
    }
  }
  return latest
}

export function getProviderAuthSession(sessionId: string): ProviderAuthSessionView | null {
  pruneOldSessions()
  const session = sessionStore.get(sessionId)
  if (!session) return null
  return toSessionView(session, true)
}

export function getLatestProviderAuthSession(provider: ProviderName): ProviderAuthSessionView | null {
  pruneOldSessions()
  const session = getLatestSession(provider)
  if (!session) return null
  return toSessionView(session, true)
}

export function cancelProviderAuthSession(sessionId: string): ProviderAuthSessionView | null {
  const session = sessionStore.get(sessionId)
  if (!session) return null
  if (!isActiveStatus(session.status)) return toSessionView(session, true)

  session.stopReason = 'canceled'
  appendLine(session, 'system', 'Cancel requested. Stopping login process...')
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

export function startProviderAuthSession(provider: ProviderName): {
  session: ProviderAuthSessionView
  reused: boolean
} {
  pruneOldSessions()
  const existing = getActiveSession(provider)
  if (existing) {
    return { session: toSessionView(existing, true), reused: true }
  }

  const cmd = getProviderCommand(provider)
  const displayCommand = [cmd.command, ...cmd.args].join(' ')
  const child = spawn(cmd.command, cmd.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
  })

  const startedAt = nowIso()
  const session: ProviderAuthSessionInternal = {
    sessionId: randomUUID(),
    provider,
    command: displayCommand,
    status: 'starting',
    process: child,
    startedAt,
    updatedAt: startedAt,
    endedAt: null,
    exitCode: null,
    verificationUrl: null,
    deviceCode: null,
    lines: [],
    lineSeq: 0,
    stdoutBuffer: '',
    stderrBuffer: '',
    timeout: setTimeout(() => {
      if (!isActiveStatus(session.status)) return
      session.stopReason = 'timeout'
      appendLine(session, 'system', 'Login timed out. Start a new session to try again.')
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
    appendLine(session, 'stderr', err.message || `${provider} login failed to start`)
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
    if (code === 0) {
      appendLine(session, 'system', 'Login completed.')
      finalizeSession(session, 'completed', code)
      return
    }
    appendLine(session, 'system', `Login exited with code ${code ?? -1}.`)
    finalizeSession(session, 'failed', code)
  })

  return { session: toSessionView(session, true), reused: false }
}

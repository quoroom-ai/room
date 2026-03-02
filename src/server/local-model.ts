import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import { statfsSync } from 'node:fs'
import type Database from 'better-sqlite3'
import { eventBus } from './event-bus'
import { registerManagedChildProcess } from '../shared/process-supervisor'
import { getDeploymentMode } from './auth'
import * as queries from '../shared/db-queries'
import {
  getOllamaCommand,
  OLLAMA_MODEL_ID,
  OLLAMA_MODEL_TAG,
  parseOllamaList,
  probeOllamaRuntime,
} from '../shared/local-model'

const SESSION_TIMEOUT_MS = Math.max(30_000, Number(process.env.QUOROOM_LOCAL_MODEL_INSTALL_TIMEOUT_MS || 3_600_000))
const SESSION_TTL_MS = Math.max(60_000, Number(process.env.QUOROOM_LOCAL_MODEL_INSTALL_TTL_MS || 7_200_000))
const MAX_LINES = Math.max(100, Number(process.env.QUOROOM_LOCAL_MODEL_INSTALL_MAX_LINES || 1000))

const LIMITS = {
  minRamGb: 48,
  minFreeDiskGb: 30,
  minCpuCores: 8,
  maxMemUsedPct: 80,
  maxCpuLoadRatio: 0.85,
  minDarwinMajor: 23,
  minWindowsBuild: 19045,
} as const

export interface LocalModelStatusView {
  deploymentMode: 'local' | 'cloud'
  modelId: string
  modelTag: string
  supported: boolean
  ready: boolean
  blockers: string[]
  warnings: string[]
  requirements: {
    minRamGb: number
    minFreeDiskGb: number
    minCpuCores: number
    maxMemUsedPct: number
    maxCpuLoadRatio: number
    minDarwinMajor: number
    minWindowsBuild: number
  }
  system: {
    platform: NodeJS.Platform
    osRelease: string
    cpuCount: number
    loadAvg1m: number
    loadRatio: number
    memTotalGb: number
    memFreeGb: number
    memUsedPct: number
    diskFreeGb: number | null
  }
  runtime: {
    installed: boolean
    version: string | null
    daemonReachable: boolean
    modelAvailable: boolean
    ready: boolean
    error: string | null
  }
}

export type LocalModelInstallStatus = 'starting' | 'running' | 'completed' | 'failed' | 'canceled' | 'timeout'

export interface LocalModelInstallLine {
  id: number
  stream: 'stdout' | 'stderr' | 'system'
  text: string
  timestamp: string
}

export interface LocalModelInstallSessionView {
  sessionId: string
  status: LocalModelInstallStatus
  startedAt: string
  updatedAt: string
  endedAt: string | null
  active: boolean
  exitCode: number | null
  lines: LocalModelInstallLine[]
}

export interface LocalModelApplyRoomResult {
  roomId: number
  roomName: string
  status: 'updated'
  queenWorkerId: number
  queenModelBefore: string | null
  queenModelAfter: string
  workerModelBefore: string
  workerModelAfter: 'queen'
}

export interface LocalModelApplyAllResult {
  modelId: string
  clerkModelBefore: string | null
  clerkModelAfter: string
  queenDefaultBefore: string | null
  queenDefaultAfter: string
  activeRoomsUpdated: number
  rooms: LocalModelApplyRoomResult[]
}

interface LocalModelInstallSessionInternal {
  sessionId: string
  status: LocalModelInstallStatus
  process: ChildProcess | null
  stopReason: 'canceled' | 'timeout' | null
  startedAt: string
  updatedAt: string
  endedAt: string | null
  exitCode: number | null
  lineSeq: number
  lines: LocalModelInstallLine[]
  stdoutBuffer: string
  stderrBuffer: string
  timeout: NodeJS.Timeout
}

const sessions = new Map<string, LocalModelInstallSessionInternal>()
let activeSessionId: string | null = null

function nowIso(): string {
  return new Date().toISOString()
}

function isActiveStatus(status: LocalModelInstallStatus): boolean {
  return status === 'starting' || status === 'running'
}

function toSessionView(session: LocalModelInstallSessionInternal, includeLines = true): LocalModelInstallSessionView {
  return {
    sessionId: session.sessionId,
    status: session.status,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    endedAt: session.endedAt,
    active: isActiveStatus(session.status),
    exitCode: session.exitCode,
    lines: includeLines ? [...session.lines] : [],
  }
}

function emitSessionStatus(session: LocalModelInstallSessionInternal): void {
  eventBus.emit(`local-model-install:${session.sessionId}`, 'local_model_install:status', toSessionView(session, false))
  eventBus.emit('local-model', 'local_model:install_status', {
    sessionId: session.sessionId,
    status: session.status,
    active: isActiveStatus(session.status),
    updatedAt: session.updatedAt,
  })
}

function emitSessionLine(session: LocalModelInstallSessionInternal, line: LocalModelInstallLine): void {
  eventBus.emit(`local-model-install:${session.sessionId}`, 'local_model_install:line', {
    sessionId: session.sessionId,
    ...line,
  })
}

function appendLine(
  session: LocalModelInstallSessionInternal,
  stream: 'stdout' | 'stderr' | 'system',
  rawText: string
): void {
  const text = rawText.trim()
  if (!text) return
  const line: LocalModelInstallLine = {
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

function flushBuffers(session: LocalModelInstallSessionInternal): void {
  if (session.stdoutBuffer.trim()) appendLine(session, 'stdout', session.stdoutBuffer)
  if (session.stderrBuffer.trim()) appendLine(session, 'stderr', session.stderrBuffer)
  session.stdoutBuffer = ''
  session.stderrBuffer = ''
}

function consumeChunk(session: LocalModelInstallSessionInternal, stream: 'stdout' | 'stderr', chunk: Buffer): void {
  const text = chunk.toString('utf8')
  const raw = (stream === 'stdout' ? session.stdoutBuffer : session.stderrBuffer) + text
  const lines = raw.split(/\r?\n/)
  const remainder = lines.pop() ?? ''
  for (const line of lines) appendLine(session, stream, line)
  if (stream === 'stdout') session.stdoutBuffer = remainder
  else session.stderrBuffer = remainder
}

function finalizeSession(
  session: LocalModelInstallSessionInternal,
  status: Exclude<LocalModelInstallStatus, 'starting' | 'running'>,
  exitCode: number | null
): void {
  if (!isActiveStatus(session.status)) return
  clearTimeout(session.timeout)
  flushBuffers(session)
  session.status = status
  session.exitCode = exitCode
  session.endedAt = nowIso()
  session.updatedAt = session.endedAt
  session.process = null
  if (activeSessionId === session.sessionId) {
    activeSessionId = null
  }
  emitSessionStatus(session)
}

function pruneSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS
  for (const [id, session] of sessions.entries()) {
    if (isActiveStatus(session.status)) continue
    const endedMs = Date.parse(session.endedAt || session.updatedAt)
    if (Number.isFinite(endedMs) && endedMs < cutoff) {
      sessions.delete(id)
    }
  }
}

function detectWindowsBuild(release: string): number | null {
  const parts = release.split('.').map((part) => Number.parseInt(part, 10))
  if (parts.length < 3) return null
  const build = parts[2]
  return Number.isFinite(build) ? build : null
}

function detectDarwinMajor(release: string): number | null {
  const major = Number.parseInt(release.split('.')[0] || '', 10)
  return Number.isFinite(major) ? major : null
}

function detectDiskFreeGb(): number | null {
  try {
    const stat = statfsSync(process.cwd())
    const freeBytes = stat.bavail * stat.bsize
    return Math.round((freeBytes / (1024 ** 3)) * 10) / 10
  } catch {
    return null
  }
}

export function getLocalModelStatus(): LocalModelStatusView {
  const deploymentMode = getDeploymentMode()
  const cpuCount = os.cpus().length
  const [load1] = os.loadavg()
  const loadRatio = cpuCount > 0 ? load1 / cpuCount : 0
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const memTotalGb = Math.round((totalMem / (1024 ** 3)) * 10) / 10
  const memFreeGb = Math.round((freeMem / (1024 ** 3)) * 10) / 10
  const memUsedPct = Math.round((1 - (freeMem / totalMem)) * 100)
  const diskFreeGb = detectDiskFreeGb()

  const blockers: string[] = []
  const warnings: string[] = []
  const release = os.release()

  if (deploymentMode !== 'local') {
    blockers.push('Local free model is available only in local deployment mode.')
  }

  if (process.platform === 'darwin') {
    const darwin = detectDarwinMajor(release)
    if (darwin == null || darwin < LIMITS.minDarwinMajor) {
      blockers.push(`macOS 14+ required (Darwin ${LIMITS.minDarwinMajor}+). Current release: ${release}.`)
    }
  } else if (process.platform === 'win32') {
    const build = detectWindowsBuild(release)
    if (build == null || build < LIMITS.minWindowsBuild) {
      blockers.push(`Windows build ${LIMITS.minWindowsBuild}+ required. Current release: ${release}.`)
    }
  } else {
    blockers.push('Local free model setup currently supports only macOS and Windows.')
  }

  if (cpuCount < LIMITS.minCpuCores) {
    blockers.push(`At least ${LIMITS.minCpuCores} CPU cores required (detected ${cpuCount}).`)
  }
  if (memTotalGb < LIMITS.minRamGb) {
    blockers.push(`At least ${LIMITS.minRamGb}GB RAM required (detected ${memTotalGb}GB).`)
  }
  if (diskFreeGb == null) {
    blockers.push('Unable to determine free disk space.')
  } else if (diskFreeGb < LIMITS.minFreeDiskGb) {
    blockers.push(`At least ${LIMITS.minFreeDiskGb}GB free disk required (detected ${diskFreeGb}GB).`)
  }

  if (memUsedPct > LIMITS.maxMemUsedPct) {
    warnings.push(`Current RAM load is high (${memUsedPct}% used). Target is <= ${LIMITS.maxMemUsedPct}% for stable 30B runs.`)
  }
  if (loadRatio > LIMITS.maxCpuLoadRatio) {
    warnings.push(`Current CPU load is high (${Math.round(loadRatio * 100)}% of capacity). Target is <= ${Math.round(LIMITS.maxCpuLoadRatio * 100)}%.`)
  }

  if (process.platform === 'win32') {
    warnings.push('CPU load on Windows is estimated from Node load average and may under-report bursts.')
  }

  const runtime = probeOllamaRuntime()
  const ready = blockers.length === 0 && runtime.ready

  return {
    deploymentMode,
    modelId: OLLAMA_MODEL_ID,
    modelTag: OLLAMA_MODEL_TAG,
    supported: blockers.length === 0,
    ready,
    blockers,
    warnings,
    requirements: { ...LIMITS },
    system: {
      platform: process.platform,
      osRelease: release,
      cpuCount,
      loadAvg1m: Math.round(load1 * 100) / 100,
      loadRatio: Math.round(loadRatio * 1000) / 1000,
      memTotalGb,
      memFreeGb,
      memUsedPct,
      diskFreeGb,
    },
    runtime: {
      installed: runtime.installed,
      version: runtime.version,
      daemonReachable: runtime.daemonReachable,
      modelAvailable: runtime.modelAvailable,
      ready: runtime.ready,
      error: runtime.error,
    },
  }
}

function getInstallScriptCommand(): { command: string; args: string[] } {
  if (process.platform === 'darwin') {
    return {
      command: '/bin/sh',
      args: ['-c', 'curl -fsSL https://ollama.com/install.sh | sh'],
    }
  }
  return {
    command: 'powershell',
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'iwr -useb https://ollama.com/install.ps1 | iex'],
  }
}

function getDaemonStartCommand(): { command: string; args: string[] } | null {
  if (process.platform === 'darwin') {
    return { command: 'open', args: ['-a', 'Ollama'] }
  }
  if (process.platform === 'win32') {
    return {
      command: 'powershell',
      args: ['-NoProfile', '-Command', 'Start-Process -WindowStyle Hidden ollama.exe'],
    }
  }
  return null
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function runCommand(
  session: LocalModelInstallSessionInternal,
  label: string,
  command: string,
  args: string[]
): Promise<number | null> {
  appendLine(session, 'system', `${label}: ${command} ${args.join(' ')}`)
  return await new Promise<number | null>((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
      shell: process.platform === 'win32',
    })
    registerManagedChildProcess(child)
    session.process = child

    child.stdout.on('data', (chunk: Buffer) => consumeChunk(session, 'stdout', chunk))
    child.stderr.on('data', (chunk: Buffer) => consumeChunk(session, 'stderr', chunk))
    child.on('error', (err: Error) => {
      appendLine(session, 'stderr', err.message || `${label} failed to start`)
      resolve(1)
    })
    child.on('close', (code: number | null) => {
      session.process = null
      flushBuffers(session)
      resolve(code)
    })
  })
}

async function ensureOllamaDaemon(session: LocalModelInstallSessionInternal): Promise<boolean> {
  const before = probeOllamaRuntime()
  if (before.daemonReachable) return true

  const daemonStart = getDaemonStartCommand()
  if (daemonStart) {
    await runCommand(session, 'Starting Ollama daemon', daemonStart.command, daemonStart.args)
  }

  for (let attempt = 1; attempt <= 8; attempt++) {
    const probe = probeOllamaRuntime()
    if (probe.daemonReachable) return true
    appendLine(session, 'system', `Waiting for Ollama daemon... (${attempt}/8)`)
    await wait(2000)
  }
  return false
}

async function runInstall(session: LocalModelInstallSessionInternal): Promise<void> {
  const status = getLocalModelStatus()
  if (status.blockers.length > 0) {
    appendLine(session, 'system', `Blocked: ${status.blockers.join(' | ')}`)
    finalizeSession(session, 'failed', 1)
    return
  }

  const runtime = probeOllamaRuntime()
  if (!runtime.installed) {
    const installCmd = getInstallScriptCommand()
    const installCode = await runCommand(session, 'Installing Ollama', installCmd.command, installCmd.args)
    if (installCode !== 0) {
      appendLine(session, 'system', `Ollama install failed with code ${installCode ?? -1}.`)
      finalizeSession(session, 'failed', installCode)
      return
    }
  } else {
    appendLine(session, 'system', `Ollama already installed${runtime.version ? ` (${runtime.version})` : ''}.`)
  }

  const daemonReady = await ensureOllamaDaemon(session)
  if (!daemonReady) {
    appendLine(session, 'system', 'Ollama daemon did not become ready in time.')
    finalizeSession(session, 'failed', 1)
    return
  }

  const pullCode = await runCommand(session, 'Pulling model', getOllamaCommand(), ['pull', OLLAMA_MODEL_TAG])
  if (pullCode !== 0) {
    appendLine(session, 'system', `Model pull failed with code ${pullCode ?? -1}.`)
    finalizeSession(session, 'failed', pullCode)
    return
  }

  const verified = probeOllamaRuntime()
  if (!verified.ready) {
    appendLine(session, 'system', verified.error || 'Model verification failed.')
    finalizeSession(session, 'failed', 1)
    return
  }
  appendLine(session, 'system', `Local model ready: ${OLLAMA_MODEL_TAG}.`)
  finalizeSession(session, 'completed', 0)
}

export function startLocalModelInstallSession(): { session: LocalModelInstallSessionView; reused: boolean } {
  pruneSessions()
  if (activeSessionId) {
    const existing = sessions.get(activeSessionId)
    if (existing && isActiveStatus(existing.status)) {
      return { session: toSessionView(existing, true), reused: true }
    }
    activeSessionId = null
  }

  const startedAt = nowIso()
  const session: LocalModelInstallSessionInternal = {
    sessionId: randomUUID(),
    status: 'starting',
    process: null,
    stopReason: null,
    startedAt,
    updatedAt: startedAt,
    endedAt: null,
    exitCode: null,
    lineSeq: 0,
    lines: [],
    stdoutBuffer: '',
    stderrBuffer: '',
    timeout: setTimeout(() => {
      if (!isActiveStatus(session.status)) return
      session.stopReason = 'timeout'
      appendLine(session, 'system', 'Install timed out.')
      try { session.process?.kill('SIGTERM') } catch {}
      setTimeout(() => {
        try { session.process?.kill('SIGKILL') } catch {}
      }, 2000).unref()
      finalizeSession(session, 'timeout', null)
    }, SESSION_TIMEOUT_MS),
  }

  sessions.set(session.sessionId, session)
  activeSessionId = session.sessionId
  session.status = 'running'
  emitSessionStatus(session)

  void runInstall(session).catch((err) => {
    appendLine(session, 'stderr', err instanceof Error ? err.message : String(err))
    finalizeSession(session, 'failed', 1)
  })

  return { session: toSessionView(session, true), reused: false }
}

export function getLatestLocalModelInstallSession(): LocalModelInstallSessionView | null {
  pruneSessions()
  let latest: LocalModelInstallSessionInternal | null = null
  for (const session of sessions.values()) {
    if (!latest || Date.parse(session.startedAt) > Date.parse(latest.startedAt)) {
      latest = session
    }
  }
  return latest ? toSessionView(latest, true) : null
}

export function getLocalModelInstallSession(sessionId: string): LocalModelInstallSessionView | null {
  pruneSessions()
  const session = sessions.get(sessionId)
  if (!session) return null
  return toSessionView(session, true)
}

export function cancelLocalModelInstallSession(sessionId: string): LocalModelInstallSessionView | null {
  const session = sessions.get(sessionId)
  if (!session) return null
  if (!isActiveStatus(session.status)) return toSessionView(session, true)

  session.stopReason = 'canceled'
  appendLine(session, 'system', 'Cancel requested. Stopping installer...')
  try { session.process?.kill('SIGTERM') } catch {}
  setTimeout(() => {
    try { session.process?.kill('SIGKILL') } catch {}
  }, 2000).unref()
  finalizeSession(session, 'canceled', null)
  return toSessionView(session, true)
}

export function getLocalModelInstallScriptPreview(): { command: string; args: string[] } {
  return getInstallScriptCommand()
}

export function probeOllamaModelsForDiagnostics(): string[] {
  try {
    const cmd = getOllamaCommand()
    const output = execFileSync(cmd, ['list'], { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' }).toString()
    return parseOllamaList(output)
  } catch {
    return []
  }
}

export function applyLocalModelToAll(db: Database.Database): LocalModelApplyAllResult {
  const applyTransaction = db.transaction((): LocalModelApplyAllResult => {
    const activeRooms = queries.listRooms(db, 'active')
    const roomInputs = activeRooms.map((room) => {
      if (!room.queenWorkerId) {
        throw new Error(`Room "${room.name}" has no queen worker configured.`)
      }
      const queen = queries.getWorker(db, room.queenWorkerId)
      if (!queen) {
        throw new Error(`Room "${room.name}" queen worker is missing.`)
      }
      return { room, queen }
    })

    const clerkModelBefore = queries.getSetting(db, 'clerk_model')
    const queenDefaultBefore = queries.getSetting(db, 'queen_model')

    queries.setSetting(db, 'clerk_model', OLLAMA_MODEL_ID)
    queries.setSetting(db, 'queen_model', OLLAMA_MODEL_ID)

    const clerk = queries.ensureClerkWorker(db)
    queries.updateWorker(db, clerk.id, { model: OLLAMA_MODEL_ID })

    const rooms: LocalModelApplyRoomResult[] = []
    for (const { room, queen } of roomInputs) {
      queries.updateWorker(db, queen.id, { model: OLLAMA_MODEL_ID })
      queries.updateRoom(db, room.id, { workerModel: 'queen' })
      rooms.push({
        roomId: room.id,
        roomName: room.name,
        status: 'updated',
        queenWorkerId: queen.id,
        queenModelBefore: queen.model ?? null,
        queenModelAfter: OLLAMA_MODEL_ID,
        workerModelBefore: room.workerModel,
        workerModelAfter: 'queen',
      })
    }

    return {
      modelId: OLLAMA_MODEL_ID,
      clerkModelBefore: clerkModelBefore ?? null,
      clerkModelAfter: OLLAMA_MODEL_ID,
      queenDefaultBefore: queenDefaultBefore ?? null,
      queenDefaultAfter: OLLAMA_MODEL_ID,
      activeRoomsUpdated: rooms.length,
      rooms,
    }
  })

  return applyTransaction()
}

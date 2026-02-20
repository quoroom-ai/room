import type Database from 'better-sqlite3'
import type { Worker, AgentState } from './types'
import type { AgentExecutionResult } from './agent-executor'
import type { RateLimitInfo } from './rate-limit'
import * as queries from './db-queries'
import { executeAgent } from './agent-executor'
import { loadSkillsForAgent } from './skills'
import { checkExpiredDecisions } from './quorum'
import { getRoomStatus } from './room'
import { detectRateLimit, sleep } from './rate-limit'

interface LoopState {
  running: boolean
  abort: AbortController | null
}

function isInQuietHours(from: string, until: string): boolean {
  const now = new Date()
  const nowMins = now.getHours() * 60 + now.getMinutes()
  const [fh, fm] = from.split(':').map(Number)
  const [uh, um] = until.split(':').map(Number)
  const fromMins = fh * 60 + fm
  const untilMins = uh * 60 + um
  if (fromMins <= untilMins) {
    return nowMins >= fromMins && nowMins < untilMins
  }
  // Overnight span (e.g. 22:00–08:00)
  return nowMins >= fromMins || nowMins < untilMins
}

function msUntilQuietEnd(until: string): number {
  const [uh, um] = until.split(':').map(Number)
  const now = new Date()
  const end = new Date(now)
  end.setHours(uh, um, 0, 0)
  if (end <= now) end.setDate(end.getDate() + 1)
  return end.getTime() - now.getTime()
}

const runningLoops = new Map<number, LoopState>()

export class RateLimitError extends Error {
  constructor(public info: RateLimitInfo) {
    super(`Rate limited: wait ${Math.round(info.waitMs / 1000)}s`)
    this.name = 'RateLimitError'
  }
}

export async function startAgentLoop(
  db: Database.Database, roomId: number, workerId: number
): Promise<void> {
  const room = queries.getRoom(db, roomId)
  if (!room) throw new Error(`Room ${roomId} not found`)
  if (room.status !== 'active') throw new Error(`Room ${roomId} is not active (status: ${room.status})`)

  const worker = queries.getWorker(db, workerId)
  if (!worker) throw new Error(`Worker ${workerId} not found`)
  if (worker.roomId !== roomId) throw new Error(`Worker ${workerId} does not belong to room ${roomId}`)

  // If already running, skip
  const existing = runningLoops.get(workerId)
  if (existing?.running) return

  const loop: LoopState = { running: true, abort: null }
  runningLoops.set(workerId, loop)

  try {
    while (loop.running) {
      // Re-fetch room to check if still active
      const currentRoom = queries.getRoom(db, roomId)
      if (!currentRoom || currentRoom.status !== 'active') break

      const currentWorker = queries.getWorker(db, workerId)
      if (!currentWorker) break

      // Quiet hours guard — sleep until quiet window ends
      if (currentRoom.queenQuietFrom && currentRoom.queenQuietUntil &&
          isInQuietHours(currentRoom.queenQuietFrom, currentRoom.queenQuietUntil)) {
        queries.updateAgentState(db, workerId, 'idle')
        queries.logRoomActivity(db, roomId, 'system',
          `Queen sleeping (quiet hours until ${currentRoom.queenQuietUntil})`, undefined, workerId)
        const wait = msUntilQuietEnd(currentRoom.queenQuietUntil)
        try {
          const abort = new AbortController()
          loop.abort = abort
          await sleep(wait, abort.signal)
        } catch {
          // Aborted (e.g. quiet hours disabled, or room paused)
        } finally {
          loop.abort = null
        }
        continue
      }

      try {
        await runCycle(db, roomId, currentWorker, currentRoom.queenMaxTurns)
      } catch (err) {
        if (!loop.running) break

        if (err instanceof RateLimitError) {
          // Enter rate_limited state and wait
          queries.updateAgentState(db, workerId, 'rate_limited')
          const resetTimeStr = err.info.resetAt
            ? err.info.resetAt.toLocaleTimeString()
            : `~${Math.round(err.info.waitMs / 1000 / 60)}min`
          queries.logRoomActivity(db, roomId, 'system',
            `Agent rate limited, waiting until ${resetTimeStr} (${currentWorker.name})`,
            err.info.rawMessage, workerId)

          try {
            const abort = new AbortController()
            loop.abort = abort
            await sleep(err.info.waitMs, abort.signal)
          } catch {
            // Aborted by triggerAgent — continue immediately
          } finally {
            loop.abort = null
          }

          if (loop.running) {
            queries.updateAgentState(db, workerId, 'idle')
          }
          continue
        }

        // Non-rate-limit error: log and continue
        const message = err instanceof Error ? err.message : String(err)
        queries.logRoomActivity(db, roomId, 'error',
          `Agent cycle error (${currentWorker.name}): ${message.slice(0, 200)}`,
          message, workerId)
        queries.updateAgentState(db, workerId, 'idle')
      }

      if (!loop.running) break

      // Configurable sleep between cycles (token burn safeguard)
      const gap = currentRoom.queenCycleGapMs
      try {
        const abort = new AbortController()
        loop.abort = abort
        await sleep(gap, abort.signal)
      } catch {
        // Aborted by triggerAgent — skip gap, start next cycle immediately
      } finally {
        loop.abort = null
      }
    }
  } finally {
    runningLoops.delete(workerId)
    queries.updateAgentState(db, workerId, 'idle')
  }
}

export function pauseAgent(db: Database.Database, workerId: number): void {
  const loop = runningLoops.get(workerId)
  if (loop) {
    loop.running = false
    if (loop.abort) loop.abort.abort()
    runningLoops.delete(workerId)
  }
  queries.updateAgentState(db, workerId, 'idle')
}

export function resumeAgent(db: Database.Database, roomId: number, workerId: number): void {
  pauseAgent(db, workerId) // Clear any existing loop
  startAgentLoop(db, roomId, workerId).catch(() => {
    pauseAgent(db, workerId)
  })
}

export function triggerAgent(db: Database.Database, roomId: number, workerId: number): void {
  const loop = runningLoops.get(workerId)
  if (loop?.running) {
    // Abort any current wait (gap or rate limit) to start next cycle immediately
    if (loop.abort) loop.abort.abort()
    return
  }
  // Not running — start fresh
  startAgentLoop(db, roomId, workerId).catch(() => {
    pauseAgent(db, workerId)
  })
}

export function getAgentState(db: Database.Database, workerId: number): AgentState {
  const worker = queries.getWorker(db, workerId)
  return worker?.agentState ?? 'idle'
}

export function isAgentRunning(workerId: number): boolean {
  return runningLoops.get(workerId)?.running === true
}

/**
 * Adapt AgentExecutionResult to the format detectRateLimit expects.
 */
function checkRateLimit(result: AgentExecutionResult): RateLimitInfo | null {
  if (result.exitCode === 0) return null
  if (result.timedOut) return null
  return detectRateLimit({
    exitCode: result.exitCode,
    stdout: result.output,
    stderr: result.output,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    sessionId: result.sessionId
  })
}

export async function runCycle(
  db: Database.Database, roomId: number, worker: Worker, maxTurns?: number
): Promise<string> {
  // 1. OBSERVE
  queries.updateAgentState(db, worker.id, 'thinking')

  checkExpiredDecisions(db)

  const status = getRoomStatus(db, roomId)
  const pendingEscalations = queries.getPendingEscalations(db, roomId, worker.id)
  const recentActivity = queries.getRoomActivity(db, roomId, 10)
  const goalUpdates = status.activeGoals.slice(0, 5).map(g => ({
    goal: g.description,
    progress: g.progress,
    status: g.status
  }))
  const roomWorkers = queries.listRoomWorkers(db, roomId)
  const roomTasks = queries.listTasks(db, roomId, 'active').slice(0, 10)
  const unreadMessages = queries.listRoomMessages(db, roomId, 'unread').slice(0, 5)

  // 2. BUILD PROMPT
  const skillContent = loadSkillsForAgent(db, roomId, status.room.goal ?? '')

  const systemPrompt = [
    worker.systemPrompt,
    skillContent ? `\n\n# Active Skills\n\n${skillContent}` : ''
  ].join('')

  const contextParts: string[] = []

  // Identity — always first so agents know their roomId and workerId for MCP tool calls
  contextParts.push(
    `## Your Identity\n- Room ID: ${roomId}\n- Your Worker ID: ${worker.id}\n- Your Name: ${worker.name}`
  )

  if (status.room.goal) {
    contextParts.push(`## Room Objective\n${status.room.goal}`)
  }

  if (goalUpdates.length > 0) {
    contextParts.push(`## Active Goals\n${goalUpdates.map(g =>
      `- [${Math.round(g.progress * 100)}%] ${g.goal} (${g.status})`
    ).join('\n')}`)
  }

  if (status.pendingDecisions > 0) {
    const decisions = queries.listDecisions(db, roomId, 'voting')
    contextParts.push(`## Pending Decisions (${decisions.length})\n${decisions.map(d =>
      `- #${d.id}: ${d.proposal} (${d.decisionType})`
    ).join('\n')}`)
  }

  if (pendingEscalations.length > 0) {
    contextParts.push(`## Escalations Awaiting Your Response\n${pendingEscalations.map(e =>
      `- #${e.id}: ${e.question}`
    ).join('\n')}`)
  }

  if (recentActivity.length > 0) {
    contextParts.push(`## Recent Activity\n${recentActivity.map(a =>
      `- [${a.eventType}] ${a.summary}`
    ).join('\n')}`)
  }

  if (roomWorkers.length > 0) {
    contextParts.push(`## Room Workers\n${roomWorkers.map(w =>
      `- #${w.id} ${w.name}${w.role ? ` (${w.role})` : ''} — ${w.agentState}`
    ).join('\n')}`)
  }

  if (roomTasks.length > 0) {
    contextParts.push(`## Room Tasks\n${roomTasks.map(t =>
      `- #${t.id} "${t.name}" [${t.triggerType}] — ${t.status}`
    ).join('\n')}`)
  }

  if (unreadMessages.length > 0) {
    contextParts.push(`## Unread Messages\n${unreadMessages.map(m =>
      `- #${m.id} from ${m.fromRoomId ?? 'unknown'}: ${m.subject}`
    ).join('\n')}`)
  }

  contextParts.push(`## Instructions\nBased on the current state, decide what to do next. You can:\n- Update goal progress\n- Create sub-goals\n- Propose decisions to the quorum\n- Create new workers\n- Escalate questions\n- Report observations\n\nRespond with your analysis and any actions you want to take.`)

  const prompt = contextParts.join('\n\n')

  // 3. EXECUTE
  queries.updateAgentState(db, worker.id, 'acting')

  const model = worker.model ?? 'claude'
  const result = await executeAgent({
    model,
    prompt,
    systemPrompt,
    timeoutMs: 5 * 60 * 1000, // 5 minutes per cycle
    maxTurns: maxTurns ?? 10
  })

  // Check for rate limit
  const rateLimitInfo = checkRateLimit(result)
  if (rateLimitInfo) {
    throw new RateLimitError(rateLimitInfo)
  }

  // 4. PERSIST
  queries.logRoomActivity(db, roomId, 'system',
    `Agent cycle completed (${worker.name})`,
    result.output.slice(0, 500),
    worker.id)

  queries.updateAgentState(db, worker.id, 'idle')

  return result.output
}

// For testing: stop all loops
export function _stopAllLoops(): void {
  for (const [, loop] of runningLoops) {
    loop.running = false
    if (loop.abort) loop.abort.abort()
  }
  runningLoops.clear()
}

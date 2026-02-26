import type Database from 'better-sqlite3'
import type { Worker, AgentState } from './types'
import type { AgentExecutionResult } from './agent-executor'
import type { RateLimitInfo } from './rate-limit'
import * as queries from './db-queries'
import { executeAgent, compressSession } from './agent-executor'
import { checkExpiredDecisions } from './quorum'
import { getRoomStatus } from './room'
import { detectRateLimit, sleep } from './rate-limit'
import { resolveApiKeyForModel, getModelProvider } from './model-provider'
import { createCycleLogBuffer, type CycleLogEntryCallback } from './console-log-buffer'
import { QUEEN_TOOLS, WORKER_TOOLS, executeQueenTool } from './queen-tools'
import { WORKER_ROLE_PRESETS } from './constants'

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

export interface AgentLoopOptions {
  onCycleLogEntry?: CycleLogEntryCallback
  onCycleLifecycle?: (event: 'created' | 'completed' | 'failed', cycleId: number, roomId: number) => void
}

export class RateLimitError extends Error {
  constructor(public info: RateLimitInfo) {
    super(`Rate limited: wait ${Math.round(info.waitMs / 1000)}s`)
    this.name = 'RateLimitError'
  }
}

export async function startAgentLoop(
  db: Database.Database, roomId: number, workerId: number, options?: AgentLoopOptions
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
        // Floor: never less than 50 turns — let agents finish their work
        const effectiveMaxTurns = Math.max(currentWorker.maxTurns ?? currentRoom.queenMaxTurns, 50)
        await runCycle(db, roomId, currentWorker, effectiveMaxTurns, options)
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

      // Adaptive gap: short when agent has active WIP (momentum), normal otherwise
      const MOMENTUM_GAP = 10_000  // 10s — maintain action momentum
      const baseGap = currentWorker.cycleGapMs ?? currentRoom.queenCycleGapMs
      const freshWorker = queries.getWorker(db, workerId)
      const gap = freshWorker?.wip ? Math.min(baseGap, MOMENTUM_GAP) : baseGap
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
    try { queries.updateAgentState(db, workerId, 'idle') } catch { /* DB may be closed */ }
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

export function resumeAgent(db: Database.Database, roomId: number, workerId: number, options?: AgentLoopOptions): void {
  pauseAgent(db, workerId) // Clear any existing loop
  startAgentLoop(db, roomId, workerId, options).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`Agent loop failed for worker ${workerId}: ${msg}`)
    try {
      queries.logRoomActivity(db, roomId, 'error',
        `Agent loop failed to start: ${msg.slice(0, 200)}`, msg, workerId)
    } catch { /* DB may be closed */ }
    try { pauseAgent(db, workerId) } catch { /* DB may be closed */ }
  })
}

export function triggerAgent(db: Database.Database, roomId: number, workerId: number, options?: AgentLoopOptions): void {
  const loop = runningLoops.get(workerId)
  if (loop?.running) {
    // Abort any current wait (gap or rate limit) to start next cycle immediately
    if (loop.abort) loop.abort.abort()
    return
  }
  // Not running — start fresh
  startAgentLoop(db, roomId, workerId, options).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`Agent loop failed for worker ${workerId}: ${msg}`)
    try {
      queries.logRoomActivity(db, roomId, 'error',
        `Agent loop failed to start: ${msg.slice(0, 200)}`, msg, workerId)
    } catch { /* DB may be closed */ }
    try { pauseAgent(db, workerId) } catch { /* DB may be closed */ }
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

function isCliContextOverflowError(message: string): boolean {
  return /compact|compaction|context.*(window|limit|overflow|too large)|model_visible_bytes|token.*limit.*exceed/i.test(message)
}

export async function runCycle(
  db: Database.Database, roomId: number, worker: Worker, maxTurns?: number, options?: AgentLoopOptions
): Promise<string> {
  queries.logRoomActivity(db, roomId, 'system',
    `Agent cycle started (${worker.name})`, undefined, worker.id)

  const model = worker.model ?? 'claude'

  // Create cycle record + log buffer
  const cycle = queries.createWorkerCycle(db, worker.id, roomId, model)
  const logBuffer = createCycleLogBuffer(
    cycle.id,
    (entries) => queries.insertCycleLogs(db, entries),
    options?.onCycleLogEntry
  )
  options?.onCycleLifecycle?.('created', cycle.id, roomId)

  try {
    // 0. PRE-FLIGHT: ensure API key is available for API-backed models
    const provider = getModelProvider(model)
    if (provider === 'openai_api' || provider === 'anthropic_api' || provider === 'gemini_api') {
      const apiKeyCheck = resolveApiKeyForModel(db, roomId, model)
      if (!apiKeyCheck) {
        const label = provider === 'openai_api' ? 'OpenAI' : provider === 'gemini_api' ? 'Gemini' : 'Anthropic'
        const msg = `Missing ${label} API key. Set it in Room Settings or the Setup Guide.`
        logBuffer.addSynthetic('error', msg)
        logBuffer.flush()
        queries.completeWorkerCycle(db, cycle.id, msg, undefined)
        options?.onCycleLifecycle?.('failed', cycle.id, roomId)
        queries.updateAgentState(db, worker.id, 'idle')
        return msg
      }
    }

    // 1. OBSERVE
    queries.updateAgentState(db, worker.id, 'thinking')
    logBuffer.addSynthetic('system', `Cycle started — observing room state...`)

    checkExpiredDecisions(db)

    const status = getRoomStatus(db, roomId)
    const pendingEscalations = queries.getPendingEscalations(db, roomId, worker.id)
    const recentKeeperAnswers = queries.getRecentKeeperAnswers(db, roomId, worker.id, 5)
    const goalUpdates = status.activeGoals.slice(0, 5).map(g => ({
      id: g.id,
      goal: g.description,
      status: g.status,
      assignedWorkerId: g.assignedWorkerId
    }))
    const roomWorkers = queries.listRoomWorkers(db, roomId)
    const unreadMessages = queries.listRoomMessages(db, roomId, 'unread').slice(0, 5)

    // 2. BUILD PROMPT

    const rolePreset = worker.role ? WORKER_ROLE_PRESETS[worker.role] : undefined
    const isQueen = worker.id === status.room.queenWorkerId
    const namePrefix = worker.name ? `Your name is ${worker.name}.\n\n` : ''
    const systemPrompt = [
      namePrefix,
      rolePreset?.systemPromptPrefix ? `${rolePreset.systemPromptPrefix}\n\n` : '',
      worker.systemPrompt,
    ].join('')

    const isCli = model === 'claude' || model.startsWith('claude-') || model === 'codex'
    const CLI_SESSION_MAX_TURNS = 20

    // ─── Load agent session ────────────────────────────────────────────────────
    // Group A (CLI): load sessionId for --resume
    // Group B (API): load messages_json for previousMessages
    let resumeSessionId: string | undefined
    let previousMessages: Array<{ role: string; content: string }> | undefined

    const agentSession = queries.getAgentSession(db, worker.id)
    if (agentSession) {
      const updatedAt = new Date(agentSession.updatedAt)
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      const cliSessionTooLong = isCli
        && !!agentSession.sessionId
        && agentSession.turnCount >= CLI_SESSION_MAX_TURNS
      if (updatedAt < sevenDaysAgo || agentSession.model !== model || cliSessionTooLong) {
        // Stale session, model switch, or long-running CLI thread → start fresh.
        queries.deleteAgentSession(db, worker.id)
        if (cliSessionTooLong) {
          logBuffer.addSynthetic(
            'system',
            `Session rotated after ${agentSession.turnCount} cycles to avoid context overflow`
          )
        }
      } else if (isCli && agentSession.sessionId) {
        resumeSessionId = agentSession.sessionId
      } else if (!isCli && agentSession.messagesJson) {
        try {
          previousMessages = JSON.parse(agentSession.messagesJson) as Array<{ role: string; content: string }>
        } catch { /* corrupt session — start fresh */ }
      }
    }

    // ─── Context compression (OpenClaw pattern) ────────────────────────────────
    // When the session history grows large, compress it into a summary before the
    // next cycle instead of blindly trimming old messages.
    const COMPRESS_THRESHOLD = 30
    const MAX_MESSAGES = 40
    const apiKeyEarly = resolveApiKeyForModel(db, roomId, model)

    if (!isCli && previousMessages && previousMessages.length >= COMPRESS_THRESHOLD) {
      logBuffer.addSynthetic('system', `Session history ${previousMessages.length} msgs — compressing...`)
      logBuffer.flush()
      const summary = await compressSession(model, apiKeyEarly, previousMessages)
      if (summary) {
        // Persist summary as a room memory so it appears in future queen prompts
        try {
          const existing = queries.listEntities(db, roomId).find(e => e.name === 'queen_session_summary')
          if (existing) {
            const obs = queries.getObservations(db, existing.id)
            if (obs.length > 0) {
              db.prepare('UPDATE observations SET content = ?, created_at = datetime(\'now\',\'localtime\') WHERE id = ?').run(summary, obs[0].id)
            } else {
              queries.addObservation(db, existing.id, summary, 'queen')
            }
          } else {
            const entity = queries.createEntity(db, 'queen_session_summary', 'fact', 'work', roomId)
            queries.addObservation(db, entity.id, summary, 'queen')
          }
        } catch { /* non-fatal */ }

        // Reset messages to just the summary entry
        previousMessages = [{ role: 'user', content: `Your compressed session memory from previous cycles: ${summary}` }]
        queries.saveAgentSession(db, worker.id, { messagesJson: JSON.stringify(previousMessages), model })
        logBuffer.addSynthetic('system', 'Session compressed and saved.')
      } else {
        // Compression failed — hard trim as fallback
        previousMessages = previousMessages.slice(-MAX_MESSAGES)
      }
      logBuffer.flush()
    }

    // ─── Build context prompt ──────────────────────────────────────────────────
    const contextParts: string[] = []

    // 1. Identity — always first so agents know their roomId and workerId for MCP tool calls
    contextParts.push(
      `## Your Identity\n- Room ID: ${roomId}\n- Your Worker ID: ${worker.id}\n- Your Name: ${worker.name}`
    )

    // 2. WIP — resume directive (highest priority, before everything else)
    const wip = worker.wip
    if (wip) {
      contextParts.push(`## >>> CONTINUE FORWARD <<<
Last cycle you accomplished / were working on:

${wip}

NOW take the NEXT action. Do NOT repeat what's already done — build on it.
If the above action is complete, start a new one toward the room objective.
At the end of this cycle, call quoroom_save_wip to save your updated position.`)
    }

    // 3. Room Objective + Goals + Assigned Tasks
    if (status.room.goal) {
      contextParts.push(`## Room Objective\n${status.room.goal}`)
    }

    if (goalUpdates.length > 0) {
      const workerMap = new Map(roomWorkers.map(w => [w.id, w.name]))
      contextParts.push(`## Active Goals\n${goalUpdates.map(g => {
        const assignee = g.assignedWorkerId ? ` → ${workerMap.get(g.assignedWorkerId) ?? `Worker #${g.assignedWorkerId}`}` : ''
        return `- [#${g.id}] ${g.goal} (${g.status})${assignee}`
      }).join('\n')}`)

      // Show tasks assigned specifically to this worker
      const myTasks = status.activeGoals.filter(g => g.assignedWorkerId === worker.id)
      if (myTasks.length > 0) {
        contextParts.push(`## Your Assigned Tasks\n${myTasks.map(g =>
          `- [#${g.id}] ${g.description}`
        ).join('\n')}\n\nThese tasks were delegated to you. Prioritize completing them.`)
      }
    }

    // 4. Room Memory — relevance-based (top 5 by hybrid search against WIP/goal)
    const searchQuery = wip || status.room.goal || ''
    const memoryResults = searchQuery
      ? queries.hybridSearch(db, searchQuery, null, 20)
          .filter(r => r.entity.roomId === roomId).slice(0, 5)
      : queries.listEntities(db, roomId).slice(0, 5).map(e => ({ entity: e, rank: 0 }))
    if (memoryResults.length > 0) {
      const memLines = memoryResults
        .map(r => {
          const obs = queries.getObservations(db, r.entity.id)
          const content = obs[0]?.content ?? ''
          return content ? `- **${r.entity.name}**: ${content.slice(0, 300)}` : null
        })
        .filter((l): l is string => l !== null)
      if (memLines.length > 0) {
        contextParts.push(`## Room Memory\n${memLines.join('\n')}`)
      }
    }

    // 5. Stuck detector
    const STUCK_THRESHOLD_CYCLES = 2
    const productiveCallCount = queries.countProductiveToolCalls(db, worker.id, STUCK_THRESHOLD_CYCLES)
    const recentCompletedCycles = queries.listRoomCycles(db, roomId, 5)
      .filter(c => c.workerId === worker.id && c.status === 'completed')
    const isStuck = recentCompletedCycles.length >= STUCK_THRESHOLD_CYCLES && productiveCallCount === 0
    if (isStuck) {
      if (wip) {
        contextParts.push(`## ⚠ ACTION STALLED\nYour last ${STUCK_THRESHOLD_CYCLES} cycles had a WIP but no external results. Try a different approach or report the blocker.`)
      } else {
        contextParts.push(`## ⚠ STUCK — TAKE ACTION NOW\nYour last ${STUCK_THRESHOLD_CYCLES} cycles produced no results. Pick ONE concrete action and execute it NOW.`)
      }
      logBuffer.addSynthetic('system', `Stuck detector: 0 productive tool calls in last ${STUCK_THRESHOLD_CYCLES} cycles`)
    }

    // 6. Instructions (lean)
    const isClaude = model === 'claude' || model.startsWith('claude-')
    const toolCallInstruction = isClaude
      ? 'Always call tools to take action.'
      : 'IMPORTANT: You MUST call at least one tool in your response.'

    const hasWip = !!wip
    const actionPriority = hasWip
      ? 'You have an active WIP above — CONTINUE that action.'
      : 'Take concrete action toward the room objective.'

    contextParts.push(`## Instructions\n${actionPriority}\nYou have plenty of turns — run your action to completion.\nBefore your cycle ends, save progress: quoroom_save_wip(...).\n${toolCallInstruction}`)

    // 7. Housekeeping — messages and announcements (for all workers)
    const housekeepingParts: string[] = []

    // Announced decisions (workers can object)
    const announcedDecisions = queries.listDecisions(db, roomId, 'announced')
    if (announcedDecisions.length > 0) {
      housekeepingParts.push(`**Announced Decisions** — object with quoroom_object if you disagree\n${announcedDecisions.map(d =>
        `- #${d.id}: ${d.proposal} (effective at ${d.effectiveAt ?? 'soon'})`
      ).join('\n')}`)
    }

    // Messages
    const myKeeperMessages = pendingEscalations.filter(e => e.fromAgentId === worker.id && !e.toAgentId)
    const incomingWorkerMessages = pendingEscalations.filter(e => e.toAgentId === worker.id && e.fromAgentId !== worker.id)

    if (incomingWorkerMessages.length > 0) {
      const senderNames = new Map(roomWorkers.map(w => [w.id, w.name]))
      housekeepingParts.push(`**Messages from Workers**\n${incomingWorkerMessages.map(e => {
        const sender = senderNames.get(e.fromAgentId ?? 0) ?? `Worker #${e.fromAgentId}`
        return `- #${e.id} from ${sender}: ${e.question}`
      }).join('\n')}`)
    }

    if (recentKeeperAnswers.length > 0) {
      housekeepingParts.push(`**Keeper Answers**\n${recentKeeperAnswers.map(e =>
        `- Q: ${e.question}\n  A: ${e.answer}`
      ).join('\n')}`)
    }

    if (myKeeperMessages.length > 0) {
      housekeepingParts.push(`**Pending to Keeper** (awaiting reply)\n${myKeeperMessages.map(e =>
        `- #${e.id}: ${e.question}`
      ).join('\n')}`)
    }

    // Queen-only: show workers list
    if (isQueen && roomWorkers.length > 1) {
      housekeepingParts.push(`**Room Workers**\n${roomWorkers.filter(w => w.id !== worker.id).map(w =>
        `- #${w.id} ${w.name}${w.role ? ` (${w.role})` : ''} — ${w.agentState}${w.wip ? ` | WIP: ${w.wip.slice(0, 100)}` : ''}`
      ).join('\n')}`)
    }

    if (housekeepingParts.length > 0) {
      contextParts.push(`## Housekeeping\n${housekeepingParts.join('\n\n')}`)
    }

    // 8. Unread inter-room messages
    if (unreadMessages.length > 0) {
      contextParts.push(`## Unread Messages\n${unreadMessages.map(m =>
        `- #${m.id} from ${m.fromRoomId ?? 'unknown'}: ${m.subject}`
      ).join('\n')}`)
    }

    const prompt = contextParts.join('\n\n')

    // 3. EXECUTE
    queries.updateAgentState(db, worker.id, 'acting')
    const promptTokenEstimate = Math.round(prompt.length / 4)
    logBuffer.addSynthetic('system', `Sending to ${model}... (~${promptTokenEstimate} tokens)`)
    logBuffer.flush()

    const apiKey = apiKeyEarly  // already resolved above for compression check

    // Build tool allow-list (null = all tools available)
    const allowListRaw = status.room.allowedTools?.trim() || null
    const allowSet = allowListRaw ? new Set(allowListRaw.split(',').map(s => s.trim())) : null

    // Role-based tool separation: queen gets coordinator tools, workers get executor tools
    const needsQueenTools = model === 'openai' || model.startsWith('openai:')
      || model === 'anthropic' || model.startsWith('anthropic:') || model.startsWith('claude-api:')

    const roleToolDefs = isQueen ? QUEEN_TOOLS : WORKER_TOOLS
    const filteredToolDefs = allowSet
      ? roleToolDefs.filter(t => allowSet.has(t.function.name))
      : roleToolDefs

    const apiToolOpts = needsQueenTools
      ? {
          toolDefs: filteredToolDefs,
          onToolCall: async (toolName: string, args: Record<string, unknown>): Promise<string> => {
            logBuffer.addSynthetic('tool_call', `→ ${toolName}(${JSON.stringify(args)})`)
            const result = await executeQueenTool(db, roomId, worker.id, toolName, args)
            logBuffer.addSynthetic('tool_result', result.content)
            return result.content
          }
        }
      : {}

    const executeWithSession = (sessionId?: string) => executeAgent({
      model,
      prompt,
      systemPrompt,
      apiKey,
      timeoutMs: worker.role === 'executor' ? 30 * 60 * 1000 : 15 * 60 * 1000,
      maxTurns: maxTurns ?? 50,
      onConsoleLog: logBuffer.onConsoleLog,
      // CLI models: block non-quoroom MCP tools (daymon, etc.)
      disallowedTools: isCli ? 'mcp__daymon*' : undefined,
      // CLI models: bypass permission prompts for headless operation
      permissionMode: isCli ? 'bypassPermissions' : undefined,
      // CLI models: pass resumeSessionId for native --resume
      resumeSessionId: sessionId,
      // API models: pass conversation history + persistence callback
      previousMessages: isCli ? undefined : previousMessages,
      onSessionUpdate: isCli ? undefined : (msgs: Array<{ role: string; content: string }>) => {
        // Hard trim as safety net (compression should have already run above threshold)
        const trimmed = msgs.length > MAX_MESSAGES ? msgs.slice(-MAX_MESSAGES) : msgs
        queries.saveAgentSession(db, worker.id, { messagesJson: JSON.stringify(trimmed), model })
      },
      ...apiToolOpts
    })

    let result = await executeWithSession(resumeSessionId)
    if (isCli && result.exitCode !== 0) {
      const failure = result.output?.trim() || ''
      if (isCliContextOverflowError(failure)) {
        queries.deleteAgentSession(db, worker.id)
        logBuffer.addSynthetic('system', 'Session overflow detected — retrying this cycle with a fresh session')
        logBuffer.flush()
        result = await executeWithSession(undefined)
      }
    }

    // Check for rate limit
    const rateLimitInfo = checkRateLimit(result)
    if (rateLimitInfo) {
      throw new RateLimitError(rateLimitInfo)
    }

    // Check for non-rate-limit execution failure
    if (result.exitCode !== 0) {
      const errorDetail = result.output?.trim() || `exit code ${result.exitCode}`
      logBuffer.addSynthetic('error', `Agent execution failed: ${errorDetail.slice(0, 500)}`)
      logBuffer.flush()
      queries.completeWorkerCycle(db, cycle.id, errorDetail.slice(0, 500), result.usage)
      options?.onCycleLifecycle?.('failed', cycle.id, roomId)
      queries.logRoomActivity(db, roomId, 'error',
        `Agent cycle failed (${worker.name}): ${errorDetail.slice(0, 200)}`,
        errorDetail, worker.id)
      queries.updateAgentState(db, worker.id, 'idle')

      // If a CLI model failed due to context overflow / compaction, reset the session
      // so the next cycle starts fresh instead of resuming a broken context forever.
      if (isCli) {
        if (isCliContextOverflowError(errorDetail)) {
          queries.deleteAgentSession(db, worker.id)
          logBuffer.addSynthetic('system', 'Session reset due to context overflow — next cycle will start fresh')
          logBuffer.flush()
        }
      }

      return result.output
    }

    // CLI models: save returned sessionId for --resume in next cycle
    if (isCli && result.sessionId) {
      queries.saveAgentSession(db, worker.id, { sessionId: result.sessionId, model })
    }

    // For non-Claude models that don't stream: add synthetic output entry
    if (result.output && model !== 'claude' && !model.startsWith('codex')) {
      logBuffer.addSynthetic('assistant_text', result.output)
    }

    // 4. PERSIST
    logBuffer.addSynthetic('system', 'Cycle completed')
    if (result.usage && (result.usage.inputTokens > 0 || result.usage.outputTokens > 0)) {
      logBuffer.addSynthetic('system', `Tokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out`)
    }
    logBuffer.flush()
    queries.completeWorkerCycle(db, cycle.id, undefined, result.usage)
    options?.onCycleLifecycle?.('completed', cycle.id, roomId)

    queries.logRoomActivity(db, roomId, 'system',
      `Agent cycle completed (${worker.name})`,
      result.output.slice(0, 500),
      worker.id)

    queries.updateAgentState(db, worker.id, 'idle')

    // Auto-WIP fallback: if agent didn't call save_wip, extract from last output
    try {
      const freshWorker = queries.getWorker(db, worker.id)
      if (!freshWorker?.wip && result.output) {
        const autoWip = result.output.slice(0, 500).replace(/\n/g, ' ').trim()
        if (autoWip.length > 20) {
          queries.updateWorkerWip(db, worker.id, `[auto] ${autoWip}`)
        }
      }
    } catch { /* non-fatal */ }

    // Prune old cycles periodically
    try { queries.pruneOldCycles(db) } catch { /* non-fatal */ }

    return result.output
  } catch (err) {
    // Complete cycle as failed
    const errorMsg = err instanceof Error ? err.message : String(err)
    logBuffer.addSynthetic('error', errorMsg.slice(0, 500))
    logBuffer.flush()
    try { queries.completeWorkerCycle(db, cycle.id, errorMsg.slice(0, 500)) } catch { /* DB may be closed */ }
    options?.onCycleLifecycle?.('failed', cycle.id, roomId)
    throw err
  }
}

// For testing: stop all loops
export function _stopAllLoops(): void {
  for (const [, loop] of runningLoops) {
    loop.running = false
    if (loop.abort) loop.abort.abort()
  }
  runningLoops.clear()
}

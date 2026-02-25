import type Database from 'better-sqlite3'
import type { Worker, AgentState } from './types'
import type { AgentExecutionResult } from './agent-executor'
import type { RateLimitInfo } from './rate-limit'
import * as queries from './db-queries'
import { executeAgent, compressSession } from './agent-executor'
import { loadSkillsForAgent } from './skills'
import { checkExpiredDecisions } from './quorum'
import { getRoomStatus } from './room'
import { detectRateLimit, sleep } from './rate-limit'
import { fetchPublicRooms, getRoomCloudId, listCloudStations, type PublicRoom, type CloudStation } from './cloud-sync'
import { resolveApiKeyForModel, getModelProvider } from './model-provider'
import { createCycleLogBuffer, type CycleLogEntryCallback } from './console-log-buffer'
import { QUEEN_TOOL_DEFINITIONS, executeQueenTool } from './queen-tools'
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
        await runCycle(db, roomId, currentWorker, currentWorker.maxTurns ?? currentRoom.queenMaxTurns, options)
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
      const gap = currentWorker.cycleGapMs ?? currentRoom.queenCycleGapMs
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
    if (provider === 'openai_api' || provider === 'anthropic_api') {
      const apiKeyCheck = resolveApiKeyForModel(db, roomId, model)
      if (!apiKeyCheck) {
        const label = provider === 'openai_api' ? 'OpenAI' : 'Anthropic'
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
    const recentActivity = queries.getRoomActivity(db, roomId, 15)
    const goalUpdates = status.activeGoals.slice(0, 5).map(g => ({
      id: g.id,
      goal: g.description,
      progress: g.progress,
      status: g.status,
      assignedWorkerId: g.assignedWorkerId
    }))
    const roomWorkers = queries.listRoomWorkers(db, roomId)
    const roomTasks = queries.listTasks(db, roomId, 'active').slice(0, 10)
    const unreadMessages = queries.listRoomMessages(db, roomId, 'unread').slice(0, 5)

    // Fetch room's cloud stations — 3s cap so cycles don't hang when cloud is unreachable
    let cloudStations: CloudStation[] = []
    try {
      const cloudRoomId = getRoomCloudId(roomId)
      cloudStations = await Promise.race([
        listCloudStations(cloudRoomId),
        new Promise<CloudStation[]>(r => setTimeout(() => r([]), 3000))
      ])
    } catch {
      // Cloud unavailability never affects local operation
    }

    // Cross-room learning — 3s cap
    let publicRooms: PublicRoom[] = []
    try {
      publicRooms = await Promise.race([
        fetchPublicRooms(),
        new Promise<PublicRoom[]>(r => setTimeout(() => r([]), 3000))
      ])
    } catch {
      // Cloud unavailability never affects local operation
    }

    // 2. BUILD PROMPT
    const skillContent = loadSkillsForAgent(db, roomId, status.room.goal ?? '')

    const rolePreset = worker.role ? WORKER_ROLE_PRESETS[worker.role] : undefined
    const namePrefix = worker.name ? `Your name is ${worker.name}.\n\n` : ''
    const systemPrompt = [
      namePrefix,
      rolePreset?.systemPromptPrefix ? `${rolePreset.systemPromptPrefix}\n\n` : '',
      worker.systemPrompt,
      skillContent ? `\n\n# Active Skills\n\n${skillContent}` : ''
    ].join('')

    const isCli = model === 'claude' || model.startsWith('claude-') || model === 'codex'

    // ─── Load agent session ────────────────────────────────────────────────────
    // Group A (CLI): load sessionId for --resume
    // Group B (API): load messages_json for previousMessages
    let resumeSessionId: string | undefined
    let previousMessages: Array<{ role: string; content: string }> | undefined

    const agentSession = queries.getAgentSession(db, worker.id)
    if (agentSession) {
      const updatedAt = new Date(agentSession.updatedAt)
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      if (updatedAt < sevenDaysAgo || agentSession.model !== model) {
        // Stale session (>7 days) or model changed → start fresh
        queries.deleteAgentSession(db, worker.id)
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

    // Identity — always first so agents know their roomId and workerId for MCP tool calls
    contextParts.push(
      `## Your Identity\n- Room ID: ${roomId}\n- Your Worker ID: ${worker.id}\n- Your Name: ${worker.name}`
    )

    const keeperReferralCode = queries.getSetting(db, 'keeper_referral_code')?.trim()
    if (keeperReferralCode) {
      const encodedKeeperCode = encodeURIComponent(keeperReferralCode)
      contextParts.push(
        `## Keeper Referral\n- Keeper code: ${keeperReferralCode}\n- Invite link: https://quoroom.ai/invite/${encodedKeeperCode}\n- Share link: https://quoroom.ai/share/v2/${encodedKeeperCode}`
      )
    }

    if (status.room.goal) {
      contextParts.push(`## Room Objective\n${status.room.goal}`)
    }

    if (goalUpdates.length > 0) {
      const workerMap = new Map(roomWorkers.map(w => [w.id, w.name]))
      contextParts.push(`## Active Goals\n${goalUpdates.map(g => {
        const assignee = g.assignedWorkerId ? ` → ${workerMap.get(g.assignedWorkerId) ?? `Worker #${g.assignedWorkerId}`}` : ''
        return `- [#${g.id}] [${Math.round(g.progress * 100)}%] ${g.goal} (${g.status})${assignee}`
      }).join('\n')}`)

      // Show tasks assigned specifically to this worker
      const myTasks = status.activeGoals.filter(g => g.assignedWorkerId === worker.id)
      if (myTasks.length > 0) {
        contextParts.push(`## Your Assigned Tasks\n${myTasks.map(g =>
          `- [#${g.id}] [${Math.round(g.progress * 100)}%] ${g.description}`
        ).join('\n')}\n\nThese tasks were delegated to you. Prioritize completing them and report progress.`)
      }
    }

    // Auto-load room memories for all models — queens build knowledge across cycles
    const memoryEntities = queries.listEntities(db, roomId).slice(0, 20)
    if (memoryEntities.length > 0) {
      const memLines = memoryEntities
        .map(e => {
          const obs = queries.getObservations(db, e.id)
          const content = obs[0]?.content ?? ''
          return content ? `- **${e.name}**: ${content.slice(0, 300)}` : null
        })
        .filter((l): l is string => l !== null)
      if (memLines.length > 0) {
        contextParts.push(`## Room Memory (use quoroom_remember to add)\n${memLines.join('\n')}`)
      }
    }

    const votingDecisions = queries.listDecisions(db, roomId, 'voting')
    if (votingDecisions.length > 0) {
      const decisionLines = votingDecisions.map(d => {
        const votes = queries.getVotes(db, d.id)
        const alreadyVoted = votes.some(v => v.workerId === worker.id)
        const proposerW = d.proposerId ? roomWorkers.find(w => w.id === d.proposerId) : null
        const by = proposerW ? ` (by ${proposerW.name})` : ''
        const voteStatus = alreadyVoted ? ' ✓ you voted' : ' ← VOTE NEEDED'
        return `- #${d.id}: ${d.proposal}${by} [${votes.length} votes so far, need ${d.minVoters}+]${voteStatus}`
      })
      contextParts.push(`## Pending Proposals — Use quoroom_vote to cast your vote\n${decisionLines.join('\n')}`)
    }

    // Show recent resolved decisions so queen knows what's already been decided
    const recentResolved = queries.listRecentDecisions(db, roomId, 5)
    if (recentResolved.length > 0) {
      contextParts.push(`## Recent Decisions (already done — do NOT repeat these)\n${recentResolved.map(d => {
        const icon = d.status === 'approved' ? '✓' : '✗'
        return `- ${icon} ${d.status}: "${d.proposal.slice(0, 120)}"`
      }).join('\n')}`)
    }

    // Split messages: my messages to keeper vs. messages from other workers directed at me
    const myKeeperMessages = pendingEscalations.filter(e => e.fromAgentId === worker.id && !e.toAgentId)
    const incomingWorkerMessages = pendingEscalations.filter(e => e.toAgentId === worker.id && e.fromAgentId !== worker.id)

    if (myKeeperMessages.length > 0) {
      contextParts.push(`## Pending Messages to Keeper (awaiting reply)\n${myKeeperMessages.map(e =>
        `- #${e.id}: ${e.question}`
      ).join('\n')}`)
    }

    if (incomingWorkerMessages.length > 0) {
      const senderNames = new Map(roomWorkers.map(w => [w.id, w.name]))
      contextParts.push(`## Messages from Other Workers\n${incomingWorkerMessages.map(e => {
        const sender = senderNames.get(e.fromAgentId ?? 0) ?? `Worker #${e.fromAgentId}`
        return `- #${e.id} from ${sender}: ${e.question}`
      }).join('\n')}`)
    }

    if (recentKeeperAnswers.length > 0) {
      contextParts.push(`## Keeper Answers (recent)\n${recentKeeperAnswers.map(e =>
        `- Q: ${e.question}\n  A: ${e.answer}`
      ).join('\n')}`)
    }

    // All models get 15 most recent activity items for goal tracking
    const activitySlice = recentActivity.slice(0, 15)
    if (activitySlice.length > 0) {
      contextParts.push(`## Recent Activity\n${activitySlice.map(a =>
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

    // Wallet awareness — every queen sees their room's financial state
    const wallet = queries.getWalletByRoom(db, roomId)
    if (wallet) {
      const summary = queries.getWalletTransactionSummary(db, wallet.id)
      const net = (parseFloat(summary.received) - parseFloat(summary.sent)).toFixed(2)
      contextParts.push(`## Wallet\nAddress: ${wallet.address}\nBalance: ${net} USDC (received: ${summary.received}, spent: ${summary.sent})`)
    }

    if (unreadMessages.length > 0) {
      contextParts.push(`## Unread Messages\n${unreadMessages.map(m =>
        `- #${m.id} from ${m.fromRoomId ?? 'unknown'}: ${m.subject}`
      ).join('\n')}`)
    }

    // Station awareness — all models get this (relevant for planning worker execution)
    const activeStations = cloudStations.filter(s => s.status === 'active')
    if (cloudStations.length > 0) {
      const stationLines = cloudStations.map(s =>
        `- #${s.id} "${s.stationName}" (${s.tier}) — ${s.status} — $${s.monthlyCost}/mo`
      )
      contextParts.push(`## Stations (${activeStations.length} active)\n${stationLines.join('\n')}`)

      }

    if (publicRooms.length > 0) {
      const top3 = publicRooms.slice(0, 3)
      contextParts.push(
        `## Public Rooms (cross-room learning)\nOther rooms you can learn strategies from:\n${top3.map((r, i) =>
          `${i + 1}. "${r.name}" — ${r.earnings} USDC | Goal: ${r.goal ?? 'No goal set'}`
        ).join('\n')}`
      )
    }

    // Execution settings + rate limit awareness — all models
    const rateLimitEvents = recentActivity.filter(a =>
      a.eventType === 'system' && a.summary.includes('rate limited')
    )
    const settingsParts = [
      `- Cycle gap: ${Math.round(status.room.queenCycleGapMs / 1000)}s`,
      `- Max turns per cycle: ${status.room.queenMaxTurns}`,
      `- Max concurrent tasks: ${status.room.maxConcurrentTasks}`
    ]
    if (rateLimitEvents.length > 0) {
      settingsParts.push(`- **Rate limits hit recently: ${rateLimitEvents.length}** (in last ${recentActivity.length} events)`)
    }
    contextParts.push(`## Execution Settings\n${settingsParts.join('\n')}`)

    // Stuck detector: if last 2 completed cycles had zero productive tool calls, inject pivot directive
    const STUCK_THRESHOLD_CYCLES = 2
    const productiveCallCount = queries.countProductiveToolCalls(db, worker.id, STUCK_THRESHOLD_CYCLES)
    const recentCompletedCycles = queries.listRoomCycles(db, roomId, 5)
      .filter(c => c.workerId === worker.id && c.status === 'completed')
    const isStuck = recentCompletedCycles.length >= STUCK_THRESHOLD_CYCLES && productiveCallCount === 0
    if (isStuck) {
      contextParts.push(`## ⚠ STUCK DETECTED\nYour last ${STUCK_THRESHOLD_CYCLES} cycles produced no external results (no web searches, no memories stored, no goal progress, no keeper messages). You MUST change strategy NOW:\n- Try a different web search query\n- Store what you know in memory even if incomplete\n- Update goal progress with what you've learned\n- Message the keeper if you're blocked\nDo NOT repeat the same approach. Pivot immediately.`)
      logBuffer.addSynthetic('system', `Stuck detector: 0 productive tool calls in last ${STUCK_THRESHOLD_CYCLES} cycles — injecting pivot directive`)
    }

    const selfRegulateHint = rateLimitEvents.length > 0
      ? '\n- **Self-regulate**: You are hitting rate limits. Use quoroom_configure_room to increase your cycle gap or reduce max turns to stay within API limits.'
      : ''

    const isClaude = model === 'claude' || model.startsWith('claude-')
    const toolCallInstruction = isClaude
      ? 'Always call tools to take action — do not just describe what you would do.'
      : 'IMPORTANT: You MUST call at least one tool in your response. Respond ONLY with a tool call — do not write explanatory text without a tool call.'

    // Build tool allow-list (null = all tools available)
    const allowListRaw = status.room.allowedTools?.trim() || null
    const allowSet = allowListRaw ? new Set(allowListRaw.split(',').map(s => s.trim())) : null
    const has = (name: string) => !allowSet || allowSet.has(name)

    // Build dynamic tool list for prompt (only mention available tools)
    const toolLines: string[] = []
    const goalTools = ['quoroom_set_goal', 'quoroom_update_progress', 'quoroom_create_subgoal', 'quoroom_delegate_task', 'quoroom_complete_goal', 'quoroom_abandon_goal'].filter(has)
    if (goalTools.length) toolLines.push(`**Goals:** ${goalTools.join(', ')}`)
    const govTools = ['quoroom_propose', 'quoroom_vote'].filter(has)
    if (govTools.length) toolLines.push(`**Governance:** ${govTools.join(', ')}`)
    const workerTools = ['quoroom_create_worker', 'quoroom_update_worker'].filter(has)
    if (workerTools.length) toolLines.push(`**Workers:** ${workerTools.join(', ')}`)
    if (has('quoroom_schedule')) toolLines.push('**Tasks:** quoroom_schedule')
    const memTools = ['quoroom_remember', 'quoroom_recall'].filter(has)
    if (memTools.length) toolLines.push(`**Memory:** ${memTools.join(', ')}`)
    const walletToolNames = isCli
      ? ['quoroom_wallet_balance', 'quoroom_wallet_send', 'quoroom_wallet_history', 'quoroom_wallet_topup']
      : ['quoroom_wallet_balance', 'quoroom_wallet_send', 'quoroom_wallet_history']
    const filteredWallet = walletToolNames.filter(has)
    if (filteredWallet.length) toolLines.push(`**Wallet:** ${filteredWallet.join(', ')}`)
    const webToolNames = isCli
      ? null  // CLI uses built-in web tools
      : ['quoroom_web_search', 'quoroom_web_fetch', 'quoroom_browser']
    if (isCli) {
      if (has('quoroom_web_search') || has('quoroom_web_fetch')) toolLines.push('**Web:** (use your built-in web search and fetch tools)')
      if (has('quoroom_browser')) toolLines.push('**Browser:** quoroom_browser (interactive — navigate, click, fill forms, submit, scroll, screenshot, persistent sessions via sessionId)')
    } else {
      const filteredWeb = (webToolNames || []).filter(has)
      if (filteredWeb.length) toolLines.push(`**Web:** ${filteredWeb.join(', ')}`)
    }
    const commsToolNames = isCli
      ? ['quoroom_send_message', 'quoroom_inbox_list', 'quoroom_inbox_send_room', 'quoroom_inbox_reply']
      : ['quoroom_send_message']
    const filteredComms = commsToolNames.filter(has)
    if (filteredComms.length) {
      if (isCli) toolLines.push(`**Comms:** ${filteredComms.map(t => t === 'quoroom_send_message' ? `${t} (message keeper or worker)` : t === 'quoroom_inbox_list' ? `${t} (inter-room)` : t).join(', ')}`)
      else toolLines.push(`**Comms:** ${filteredComms.join(', ')}`)
    }
    if (has('quoroom_configure_room')) toolLines.push(`**Settings:** quoroom_configure_room${selfRegulateHint}`)
    const skillToolNames = ['quoroom_create_skill', 'quoroom_list_skills', 'quoroom_edit_skill', 'quoroom_activate_skill', 'quoroom_deactivate_skill'].filter(has)
    if (skillToolNames.length) toolLines.push(`**Skills:** ${skillToolNames.join(', ')} — write execution reports (MANDATORY each cycle)`)
    const toolList = toolLines.join('\n')

    contextParts.push(`## Instructions\nBased on the current state, decide what to do next and call the appropriate tools. Available tools:\n\n${toolList}\n\nDo NOT "stand by" or wait for anyone — every cycle must make progress. Act autonomously: make decisions and execute. Inform the keeper of progress or important updates using quoroom_send_message (to="keeper"), but never block on a response. If the keeper hasn't replied, proceed with your best judgment.\n\nRevenue is always a priority. Every room must sustain itself financially. Actively seek ways to earn: offer services to the keeper, propose paid work to other rooms, or find monetizable opportunities in your domain. Check your wallet balance and report financial status to the keeper.\n\n${toolCallInstruction}`)

    // Browser tips — shown whenever quoroom_browser is available
    if (has('quoroom_browser')) {
      contextParts.push(`## Browser Tool — quoroom_browser
You have a persistent browser tool. Use it to interact with websites: navigate, click, fill forms, submit, scroll, take screenshots.

**Session persistence:**
- First call: omit sessionId → starts fresh session. Note the returned sessionId.
- Follow-up calls: pass sessionId back → keeps cookies, login state, localStorage.
- Sessions expire after 10 min of inactivity. If expired, start a new session and re-login.

**Reliable form filling (learned techniques):**
- Always end action sequences with a \`snapshot\` to see current page state.
- Use \`fill\` for standard inputs. Use \`type\` for JS-heavy SPAs (types char-by-char, triggers events).
- For checkboxes: use \`click\` with text selector first. If intercepted by label, try CSS \`selector\` (e.g. \`input[type=checkbox]\`).
- For contenteditable/rich text areas (email body, editors): use \`click\` on the area first, then \`type\` to enter text. \`fill\` often fails on contenteditable.
- Use \`waitForSelector\` before interacting with dynamically loaded elements.
- Use \`press\` with key name (Tab, Enter, Escape) to navigate forms.

**CAPTCHAs:**
- Some sites show visual CAPTCHAs. Use \`screenshot\` to save a PNG, then use Read tool to view the image and answer.
- Clock CAPTCHAs: read the hour/minute hands and enter time as hh:mm.
- If a CAPTCHA is unsolvable, try a different service.

**Screenshots:** Use \`screenshot\` action → saves PNG to /tmp. View with Read tool (it can display images).

**Store everything:** After creating accounts, finding contacts, or completing any action — immediately use quoroom_remember to save credentials, URLs, and results so the team and future cycles can access them.`)
    }

    // Knowledge persistence — skills + memory
    if (skillToolNames.length || memTools.length) {
      const parts: string[] = ['## Knowledge Persistence']
      parts.push('You lose context between cycles. Save important discoveries so you and your teammates can reuse them.')
      if (memTools.length) {
        parts.push(`\n**Memory** (quoroom_remember/recall): Store facts, credentials, contacts, research results. Check memory with quoroom_recall before starting work — don't repeat what's already done. Also call quoroom_list_skills — skills contain the team's execution algorithms and may have exactly the recipe you need.`)
      }
      if (skillToolNames.length) {
        parts.push(`\n**Skills — Execution Reports** (quoroom_create_skill): At the END of each cycle, create a skill documenting what you did. Skills are injected into every agent's system prompt — the whole team reads them next cycle.

**MANDATORY: Before your cycle ends, call quoroom_create_skill with a report:**
- Title: "[task]: [site/service name]" (e.g. "Tuta signup", "Email scraping from GitHub")
- Body: step-by-step algorithm you used, including:
  1. What you tried FIRST (and why it failed, with exact error or behavior)
  2. What you tried NEXT (and whether it worked)
  3. The WORKING approach with exact selectors, URLs, field names
  4. Gotchas and warnings (e.g. "checkbox click intercepted by label — use CSS selector instead")
- Set \`autoActivate: true\` and \`activationContext\` with keywords (e.g. ["tuta", "signup", "email", "checkbox"])

Example skill body:
"## Tuta Free Account Signup\\n1. Navigate to app.tuta.com → click 'Sign up'\\n2. Select Free plan (3rd radio) → click 'Continue'\\n3. Username: use 'fill' on textbox labeled 'Email address'\\n4. Password: use 'type' (not fill) — SPA input needs char-by-char\\n5. Checkboxes: text click fails (label intercepts). USE CSS: input[type=checkbox]:nth-of-type(1) and :nth-of-type(2)\\n6. CAPTCHA: clock type — screenshot it, read time as hh:mm\\nFAILED: Ctrl+A to clear field (doesn't work in this SPA). Use triple-click or reload page instead."

This is NOT optional — every cycle must produce at least one skill report.`)
      }
      contextParts.push(parts.join('\n'))
    }

    const prompt = contextParts.join('\n\n')

    // 3. EXECUTE
    queries.updateAgentState(db, worker.id, 'acting')
    const promptTokenEstimate = Math.round(prompt.length / 4)
    logBuffer.addSynthetic('system', `Sending to ${model}... (~${promptTokenEstimate} tokens)`)
    logBuffer.flush()

    const apiKey = apiKeyEarly  // already resolved above for compression check

    // For non-Claude models: provide queen tools so they can take real actions
    // (Claude uses MCP natively; codex doesn't support tool calling)
    const needsQueenTools = model === 'openai' || model.startsWith('openai:')
      || model === 'anthropic' || model.startsWith('anthropic:') || model.startsWith('claude-api:')

    const filteredToolDefs = allowSet
      ? QUEEN_TOOL_DEFINITIONS.filter(t => allowSet.has(t.function.name))
      : QUEEN_TOOL_DEFINITIONS

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

    const result = await executeAgent({
      model,
      prompt,
      systemPrompt,
      apiKey,
      timeoutMs: 5 * 60 * 1000,
      maxTurns: maxTurns ?? 10,
      onConsoleLog: logBuffer.onConsoleLog,
      // CLI models: block non-quoroom MCP tools (daymon, etc.)
      disallowedTools: isCli ? 'mcp__daymon*' : undefined,
      // CLI models: bypass permission prompts for headless operation
      permissionMode: isCli ? 'bypassPermissions' : undefined,
      // CLI models: pass resumeSessionId for native --resume
      resumeSessionId,
      // API models: pass conversation history + persistence callback
      previousMessages: isCli ? undefined : previousMessages,
      onSessionUpdate: isCli ? undefined : (msgs: Array<{ role: string; content: string }>) => {
        // Hard trim as safety net (compression should have already run above threshold)
        const trimmed = msgs.length > MAX_MESSAGES ? msgs.slice(-MAX_MESSAGES) : msgs
        queries.saveAgentSession(db, worker.id, { messagesJson: JSON.stringify(trimmed), model })
      },
      ...apiToolOpts
    })

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
      if (isCli && resumeSessionId) {
        const isContextError = /compact|compaction|context.*(window|limit|overflow|too large)|model_visible_bytes|token.*limit.*exceed/i.test(errorDetail)
        if (isContextError) {
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

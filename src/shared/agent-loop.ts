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
import { resolveApiKeyForModel } from './model-provider'
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
      status: g.status
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
    const systemPrompt = [
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
      contextParts.push(`## Active Goals\n${goalUpdates.map(g =>
        `- [#${g.id}] [${Math.round(g.progress * 100)}%] ${g.goal} (${g.status})`
      ).join('\n')}`)
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
      contextParts.push(`## Pending Decisions (voting — cast your vote)\n${votingDecisions.map(d =>
        `- #${d.id}: ${d.proposal} (${d.decisionType})`
      ).join('\n')}`)
    }

    // Show recent resolved decisions so queen knows what's already been decided
    const recentResolved = queries.listRecentDecisions(db, roomId, 5)
    if (recentResolved.length > 0) {
      contextParts.push(`## Recent Decisions (already done — do NOT repeat these)\n${recentResolved.map(d => {
        const icon = d.status === 'approved' ? '✓' : '✗'
        return `- ${icon} ${d.status}: "${d.proposal.slice(0, 120)}"`
      }).join('\n')}`)
    }

    // Split escalations: questions the Queen sent to keeper vs. escalations directed at the Queen
    const pendingToKeeper = pendingEscalations.filter(e => e.fromAgentId === worker.id && !e.toAgentId)
    const pendingFromOthers = pendingEscalations.filter(e => e.fromAgentId !== worker.id)

    if (pendingToKeeper.length > 0) {
      contextParts.push(`## Pending Questions to Keeper (awaiting keeper reply)\n${pendingToKeeper.map(e =>
        `- #${e.id}: ${e.question}`
      ).join('\n')}`)
    }

    if (pendingFromOthers.length > 0) {
      contextParts.push(`## Escalations Awaiting Your Response\n${pendingFromOthers.map(e =>
        `- #${e.id}: ${e.question}`
      ).join('\n')}`)
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

    const selfRegulateHint = rateLimitEvents.length > 0
      ? '\n- **Self-regulate**: You are hitting rate limits. Use quoroom_configure_room to increase your cycle gap or reduce max turns to stay within API limits.'
      : ''

    const isClaude = model === 'claude' || model.startsWith('claude-')
    const toolCallInstruction = isClaude
      ? 'Always call tools to take action — do not just describe what you would do.'
      : 'IMPORTANT: You MUST call at least one tool in your response. Respond ONLY with a tool call — do not write explanatory text without a tool call.'

    const commsTools = isCli
      ? 'quoroom_inbox_send_keeper (message keeper), quoroom_inbox_list (inter-room), quoroom_inbox_send_room, quoroom_inbox_reply'
      : 'quoroom_ask_keeper'
    const webTools = isCli
      ? '(use your built-in web search and fetch tools)'
      : 'quoroom_web_search, quoroom_web_fetch, quoroom_browser'
    const walletTools = isCli
      ? 'quoroom_wallet_balance, quoroom_wallet_send, quoroom_wallet_history, quoroom_wallet_topup'
      : 'quoroom_wallet_balance, quoroom_wallet_send, quoroom_wallet_history'
    const toolList = `**Goals:** quoroom_set_goal, quoroom_update_progress, quoroom_create_subgoal, quoroom_complete_goal, quoroom_abandon_goal\n**Governance:** quoroom_propose, quoroom_vote\n**Workers:** quoroom_create_worker, quoroom_update_worker\n**Tasks:** quoroom_schedule\n**Memory:** quoroom_remember, quoroom_recall\n**Wallet:** ${walletTools}\n**Web:** ${webTools}\n**Comms:** ${commsTools}\n**Settings:** quoroom_configure_room${selfRegulateHint}`

    const sendKeeperTool = isCli ? 'quoroom_inbox_send_keeper' : 'quoroom_ask_keeper'
    contextParts.push(`## Instructions\nBased on the current state, decide what to do next and call the appropriate tools. Available tools:\n\n${toolList}\n\nDo NOT "stand by" or wait for anyone — every cycle must make progress. Act autonomously: make decisions and execute. Inform the keeper of progress or important updates using ${sendKeeperTool}, but never block on a response. If the keeper hasn't replied, proceed with your best judgment.\n\nRevenue is always a priority. Every room must sustain itself financially. Actively seek ways to earn: offer services to the keeper, propose paid work to other rooms, or find monetizable opportunities in your domain. Check your wallet balance and report financial status to the keeper.\n\n${toolCallInstruction}`)

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

    const apiToolOpts = needsQueenTools
      ? {
          toolDefs: QUEEN_TOOL_DEFINITIONS,
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

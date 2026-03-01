import { join } from 'path'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { executeClaudeCode } from './claude-code'
import type { ConsoleLogCallback, ExecutionOptions, ExecutionResult } from './claude-code'
import * as queries from './db-queries'
import { DEFAULTS } from './constants'
import { shouldDistill, distillLearnedContext } from './learned-context'
import { detectRateLimit, sleep, RATE_LIMIT_MAX_RETRIES } from './rate-limit'
import type Database from 'better-sqlite3'
import type { Task } from './types'

export interface TaskExecutionOptions {
  db: Database.Database
  resultsDir: string
  onComplete?: (task: Task, output: string, durationMs: number) => void
  onFailed?: (task: Task, error: string) => void
  onConsoleLogEntry?: (entry: { runId: number; seq: number; entryType: string; content: string }) => void
}

export interface TaskExecutionResult {
  success: boolean
  output: string
  errorMessage?: string
  durationMs: number
  resultFilePath?: string
}

const runningTasks = new Set<number>()
const taskAbortControllers = new Map<number, AbortController>()

const SESSION_MAX_RUNS = 20
const CONSOLE_LOG_FLUSH_INTERVAL_MS = 1000
const DEFAULT_MAX_CONCURRENT_TASKS = 3

function keeperReferralContext(db: Database.Database): string | null {
  const code = queries.getSetting(db, 'keeper_referral_code')?.trim()
  if (!code) return null
  const encoded = encodeURIComponent(code)
  return `## Keeper Referral
- Keeper code: ${code}
- Invite link: https://quoroom.io/invite/${encoded}
- Share link: https://quoroom.io/share/v2/${encoded}`
}

function prependKeeperReferral(prompt: string, db: Database.Database): string {
  const referral = keeperReferralContext(db)
  if (!referral) return prompt
  return `${referral}\n\n---\n\n${prompt}`
}

// ─── Concurrency limiter ─────────────────────────────────────
// Prevents spawning unlimited Claude CLI processes when many tasks fire at once.
// Uses its own counter (not runningTasks.size) to avoid race conditions between
// acquireSlot() and runningTasks.add().
let activeSlots = 0
const concurrencyQueue: Array<() => void> = []

function acquireSlot(maxSlots: number): Promise<void> {
  if (activeSlots < maxSlots) {
    activeSlots++
    return Promise.resolve()
  }
  return new Promise<void>(resolve => {
    concurrencyQueue.push(resolve)
  })
}

function getMaxConcurrentTasks(db: Database.Database, roomId?: number | null): number {
  // Per-room setting takes priority
  if (roomId != null) {
    const room = queries.getRoom(db, roomId)
    if (room) return Math.max(1, Math.min(10, room.maxConcurrentTasks))
  }
  // Fallback to global setting for tasks without a room
  const raw = queries.getSetting(db, 'max_concurrent_tasks')
  if (raw === null) return DEFAULT_MAX_CONCURRENT_TASKS
  const parsed = parseInt(raw, 10)
  if (isNaN(parsed) || parsed < 1) return 1
  if (parsed > 10) return 10
  return parsed
}

function releaseSlot(): void {
  const next = concurrencyQueue.shift()
  if (next) {
    // Transfer slot to next waiter (don't decrement — they inherit our slot)
    next()
  } else {
    activeSlots--
  }
}

function createConsoleLogBuffer(
  db: Database.Database,
  runId: number,
  onConsoleLogEntry?: (entry: { runId: number; seq: number; entryType: string; content: string }) => void
): {
  onConsoleLog: ConsoleLogCallback
  flush: () => void
} {
  let seq = 0
  let lastFlush = 0
  const buffer: Array<{ runId: number; seq: number; entryType: string; content: string }> = []

  function flush(): void {
    if (buffer.length === 0) return
    try {
      const toWrite = buffer.splice(0)
      queries.insertConsoleLogs(db, toWrite)
    } catch (err) {
      console.warn('Non-fatal: console log flush failed:', err)
    }
    lastFlush = Date.now()
  }

  return {
    onConsoleLog: (entry) => {
      seq++
      const next = { runId, seq, entryType: entry.entryType, content: entry.content }
      buffer.push(next)
      onConsoleLogEntry?.(next)
      const now = Date.now()
      if (now - lastFlush >= CONSOLE_LOG_FLUSH_INTERVAL_MS) {
        flush()
      }
    },
    flush
  }
}

/**
 * Execute Claude Code with automatic rate limit retry.
 * If the CLI fails due to a rate/usage limit, waits for the reset time and retries.
 */
async function executeWithRateLimitRetry(
  prompt: string,
  execOptions: ExecutionOptions,
  db: Database.Database,
  runId: number,
  taskId: number,
  onConsoleLogEntry?: (entry: { runId: number; seq: number; entryType: string; content: string }) => void,
  abortSignal?: AbortSignal
): Promise<ExecutionResult> {
  if (abortSignal?.aborted) {
    return {
      stdout: '',
      stderr: 'Execution aborted',
      exitCode: 130,
      durationMs: 0,
      timedOut: false,
      sessionId: null
    }
  }
  let result = await executeClaudeCode(prompt, execOptions)

  let retries = 0
  while (result.exitCode !== 0 && retries < RATE_LIMIT_MAX_RETRIES) {
    const rateLimitInfo = detectRateLimit(result)
    if (!rateLimitInfo) break

    retries++
    const retryLabel = `(attempt ${retries + 1}/${RATE_LIMIT_MAX_RETRIES + 1})`
    const waitSec = Math.round(rateLimitInfo.waitMs / 1000)
    const resetTimeStr = rateLimitInfo.resetAt
      ? rateLimitInfo.resetAt.toLocaleTimeString()
      : `~${Math.round(waitSec / 60)}min`

    console.log(`Task ${taskId}: Rate limit detected. Waiting ${waitSec}s until ${resetTimeStr} ${retryLabel}`)

    queries.updateTaskRunProgress(db, runId, null, `Rate limited. Retrying at ${resetTimeStr} ${retryLabel}`)

    // Log to console so it appears in task progress history
    try {
      const entry = {
        runId,
        seq: 999999 + retries,
        entryType: 'error',
        content: `Rate limit reached. Waiting ${waitSec}s until reset ${retryLabel}`
      }
      queries.insertConsoleLogs(db, [entry])
      onConsoleLogEntry?.(entry)
    } catch { /* non-fatal */ }

    await sleep(rateLimitInfo.waitMs, abortSignal)

    queries.updateTaskRunProgress(db, runId, null, `Retrying after rate limit ${retryLabel}`)

    // Re-create console log buffer for the retry
    const retryConsoleLog = createConsoleLogBuffer(db, runId, onConsoleLogEntry)
    let lastProgressUpdate = 0
    result = await executeClaudeCode(prompt, {
      ...execOptions,
      onConsoleLog: retryConsoleLog.onConsoleLog,
      onProgress: (progress) => {
        const now = Date.now()
        if (now - lastProgressUpdate >= DEFAULTS.PROGRESS_THROTTLE_MS) {
          queries.updateTaskRunProgress(db, runId, progress.fraction, progress.message)
          lastProgressUpdate = now
        }
      },
      abortSignal
    })
    retryConsoleLog.flush()
  }

  return result
}

export function isTaskRunning(taskId: number): boolean {
  return runningTasks.has(taskId)
}

export function cancelRunningTasksForRoom(db: Database.Database, roomId: number): number {
  let canceled = 0
  for (const taskId of runningTasks) {
    const task = queries.getTask(db, taskId)
    if (!task || task.roomId !== roomId) continue
    const controller = taskAbortControllers.get(taskId)
    if (!controller || controller.signal.aborted) continue
    controller.abort()
    canceled++
  }
  return canceled
}

export async function executeTask(
  taskId: number,
  options: TaskExecutionOptions
): Promise<TaskExecutionResult> {
  const { db, resultsDir, onComplete, onFailed, onConsoleLogEntry } = options

  if (runningTasks.has(taskId)) {
    return { success: false, output: '', errorMessage: 'Task is already running', durationMs: 0 }
  }

  // Cross-process safety: check DB for an existing running execution
  const existingRun = queries.getLatestTaskRun(db, taskId)
  if (existingRun?.status === 'running') {
    return { success: false, output: '', errorMessage: 'Task has a running execution in another process', durationMs: 0 }
  }

  const task = queries.getTask(db, taskId)
  if (!task) {
    return { success: false, output: '', errorMessage: `Task ${taskId} not found`, durationMs: 0 }
  }

  if (task.status !== 'active') {
    return { success: false, output: '', errorMessage: `Task ${taskId} is ${task.status}, not active`, durationMs: 0 }
  }

  const startTime = Date.now()
  const taskAbort = new AbortController()

  if (task.executor === 'keeper_contact_check') {
    runningTasks.add(taskId)
    taskAbortControllers.set(taskId, taskAbort)
    const run = queries.createTaskRun(db, taskId)
    try {
      if (taskAbort.signal.aborted) throw new Error('Execution aborted')
      const contactEmail = queries.getSetting(db, 'contact_email')?.trim() ?? ''
      const emailVerifiedAt = queries.getSetting(db, 'contact_email_verified_at')?.trim() ?? ''
      const telegramId = queries.getSetting(db, 'contact_telegram_id')?.trim() ?? ''
      const telegramVerifiedAt = queries.getSetting(db, 'contact_telegram_verified_at')?.trim() ?? ''

      const hasEmail = Boolean(contactEmail && emailVerifiedAt)
      const hasTelegram = Boolean(telegramId && telegramVerifiedAt)

      let output: string
      if (!hasEmail || !hasTelegram) {
        const missing = [
          !hasEmail ? 'email' : null,
          !hasTelegram ? 'telegram' : null
        ].filter(Boolean).join(' and ')
        output = `Keeper action needed: Please add your ${missing} in Settings -> Contacts so Clerk can always stay connected.`
        queries.insertClerkMessage(db, 'commentary', output, 'task')
      } else {
        output = 'Contact check: keeper already connected via email/telegram; no reminder sent.'
      }

      queries.completeTaskRun(db, run.id, output)
      queries.incrementRunCount(db, taskId)

      const durationMs = Date.now() - startTime
      onComplete?.(task, output, durationMs)
      return { success: true, output, durationMs }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      queries.completeTaskRun(db, run.id, '', undefined, errorMsg)
      onFailed?.(task, errorMsg)
      return { success: false, output: '', errorMessage: errorMsg, durationMs: Date.now() - startTime }
    } finally {
      runningTasks.delete(taskId)
      taskAbortControllers.delete(taskId)
    }
  }

  if (task.executor === 'keeper_reminder') {
    runningTasks.add(taskId)
    taskAbortControllers.set(taskId, taskAbort)
    const run = queries.createTaskRun(db, taskId)
    try {
      if (taskAbort.signal.aborted) throw new Error('Execution aborted')
      const reminderBody = task.prompt.trim() || task.description?.trim() || task.name.trim() || 'Scheduled reminder.'
      const roomName = task.roomId != null
        ? (queries.getRoom(db, task.roomId)?.name ?? `room #${task.roomId}`)
        : null
      const output = roomName
        ? `Reminder (${roomName}): ${reminderBody}`
        : `Reminder: ${reminderBody}`

      queries.insertClerkMessage(db, 'commentary', output, 'task')
      queries.completeTaskRun(db, run.id, output)
      queries.incrementRunCount(db, taskId)

      const durationMs = Date.now() - startTime
      onComplete?.(task, output, durationMs)
      return { success: true, output, durationMs }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      queries.completeTaskRun(db, run.id, '', undefined, errorMsg)
      onFailed?.(task, errorMsg)
      return { success: false, output: '', errorMessage: errorMsg, durationMs: Date.now() - startTime }
    } finally {
      runningTasks.delete(taskId)
      taskAbortControllers.delete(taskId)
    }
  }

  // ─── Resolve worker model EARLY to decide execution path ──────
  // worker.model > room.workerModel > 'claude' (default)
  let systemPrompt: string | undefined
  let model: string | undefined
  try {
    if (task.workerId) {
      const worker = queries.getWorker(db, task.workerId)
      if (worker) {
        systemPrompt = worker.systemPrompt
        model = worker.model ?? undefined
      }
    }
    if (!systemPrompt) {
      const defaultWorker = queries.getDefaultWorker(db)
      if (defaultWorker) {
        systemPrompt = defaultWorker.systemPrompt
        if (!model) model = defaultWorker.model ?? undefined
      }
    }
    // Fall back to room-level workerModel if worker has no explicit model
    if (!model && task.roomId) {
      const room = queries.getRoom(db, task.roomId)
      if (room?.workerModel && room.workerModel !== 'claude') {
        if (room.workerModel === 'queen') {
          const queen = room.queenWorkerId ? queries.getWorker(db, room.queenWorkerId) : null
          model = queen?.model ?? 'claude'
        } else {
          model = room.workerModel
        }
      }
    }
  } catch (err) {
    console.warn('Non-fatal: worker resolution failed:', err)
  }

  // ─── Runtime-host execution path (local mode local machine; cloud mode swarm host) ───
  await acquireSlot(getMaxConcurrentTasks(db, task.roomId))

  runningTasks.add(taskId)
  taskAbortControllers.set(taskId, taskAbort)
  const run = queries.createTaskRun(db, taskId)

  try {
    // Determine session resume ID
    let resumeSessionId: string | undefined
    if (task.sessionContinuity && task.sessionId) {
      // Check session rotation: start fresh after SESSION_MAX_RUNS consecutive runs
      try {
        const sessionRunCount = queries.getSessionRunCount(db, taskId, task.sessionId)
        if (sessionRunCount < SESSION_MAX_RUNS) {
          resumeSessionId = task.sessionId
        }
        // If >= SESSION_MAX_RUNS, leave resumeSessionId undefined to start fresh
      } catch (err) {
        console.warn('Non-fatal: session run count check failed:', err)
      }
    }

    // Inject learned context (methodology from previous runs)
    let augmentedPrompt = prependKeeperReferral(task.prompt, db)
    try {
      if (task.learnedContext) {
        augmentedPrompt = `## Approach (learned from previous runs):\n${task.learnedContext}\n\n---\n\n${augmentedPrompt}`
      }
    } catch (err) {
      console.warn('Non-fatal: learned context injection failed:', err)
    }

    // Inject memory context into prompt
    try {
      if (task.sessionContinuity && resumeSessionId) {
        // Session-continuous task with existing session: only inject cross-task knowledge
        // (the session already has own history from previous runs)
        const crossTaskContext = queries.getCrossTaskMemoryContext(db, taskId)
        if (crossTaskContext) {
          augmentedPrompt = `${crossTaskContext}\n\n---\n\n${augmentedPrompt}`
        }
      } else {
        // First run, stateless task, or session rotation: full memory injection
        const memoryContext = queries.getTaskMemoryContext(db, taskId)
        if (memoryContext) {
          augmentedPrompt = `${memoryContext}\n\n---\n\n${augmentedPrompt}`
        }
      }
    } catch (err) {
      console.warn('Non-fatal: memory injection failed:', err)
    }

    // Resolve execution constraints
    const timeoutMs = task.timeoutMinutes != null ? task.timeoutMinutes * 60 * 1000 : undefined
    const maxTurns = task.maxTurns ?? undefined
    const allowedTools = task.allowedTools ?? undefined
    const disallowedTools = task.disallowedTools ?? undefined

    const consoleLog = createConsoleLogBuffer(db, run.id, onConsoleLogEntry)
    let lastProgressUpdate = 0

    const execOptions: ExecutionOptions = {
      systemPrompt,
      model,
      resumeSessionId,
      timeoutMs,
      maxTurns,
      allowedTools,
      disallowedTools,
      permissionMode: 'bypassPermissions',
      onConsoleLog: consoleLog.onConsoleLog,
      onProgress: (progress) => {
        const now = Date.now()
        if (now - lastProgressUpdate >= DEFAULTS.PROGRESS_THROTTLE_MS) {
          queries.updateTaskRunProgress(db, run.id, progress.fraction, progress.message)
          lastProgressUpdate = now
        }
      },
      abortSignal: taskAbort.signal
    }
    const result = await executeWithRateLimitRetry(
      augmentedPrompt,
      execOptions,
      db,
      run.id,
      taskId,
      onConsoleLogEntry,
      taskAbort.signal
    )
    consoleLog.flush()
    if (taskAbort.signal.aborted) {
      const errorMsg = 'Execution aborted'
      queries.completeTaskRun(db, run.id, result.stdout || '', undefined, errorMsg)
      onFailed?.(task, errorMsg)
      return { success: false, output: result.stdout || '', errorMessage: errorMsg, durationMs: Date.now() - startTime }
    }

    // If resume failed, retry without session
    if (result.exitCode !== 0 && resumeSessionId && !taskAbort.signal.aborted) {
      try {
        queries.clearTaskSession(db, taskId)
      } catch (err) { console.warn('Non-fatal: clear session failed:', err) }

      // Re-inject learned context + full memory context for the fresh run
      let retryPrompt = prependKeeperReferral(task.prompt, db)
      try {
        if (task.learnedContext) {
          retryPrompt = `## Approach (learned from previous runs):\n${task.learnedContext}\n\n---\n\n${retryPrompt}`
        }
      } catch (err) { console.warn('Non-fatal: learned context retry failed:', err) }
      try {
        const memoryContext = queries.getTaskMemoryContext(db, taskId)
        if (memoryContext) {
          retryPrompt = `${memoryContext}\n\n---\n\n${retryPrompt}`
        }
      } catch (err) { console.warn('Non-fatal: memory context retry failed:', err) }

      const retryConsoleLog = createConsoleLogBuffer(db, run.id, onConsoleLogEntry)
      lastProgressUpdate = 0
      const retryExecOptions: ExecutionOptions = {
        systemPrompt,
        model,
        timeoutMs,
        maxTurns,
        allowedTools,
        disallowedTools,
        permissionMode: 'bypassPermissions',
        onConsoleLog: retryConsoleLog.onConsoleLog,
        onProgress: (progress) => {
          const now = Date.now()
          if (now - lastProgressUpdate >= DEFAULTS.PROGRESS_THROTTLE_MS) {
            queries.updateTaskRunProgress(db, run.id, progress.fraction, progress.message)
            lastProgressUpdate = now
          }
        },
        abortSignal: taskAbort.signal
      }
      const retryResult = await executeWithRateLimitRetry(
        retryPrompt,
        retryExecOptions,
        db,
        run.id,
        taskId,
        onConsoleLogEntry,
        taskAbort.signal
      )
      retryConsoleLog.flush()
      if (taskAbort.signal.aborted) {
        const errorMsg = 'Execution aborted'
        queries.completeTaskRun(db, run.id, retryResult.stdout || '', undefined, errorMsg)
        onFailed?.(task, errorMsg)
        return { success: false, output: retryResult.stdout || '', errorMessage: errorMsg, durationMs: Date.now() - startTime }
      }

      return finishRun(db, run.id, taskId, task, retryResult, resultsDir, onComplete, onFailed)
    }

    return finishRun(db, run.id, taskId, task, result, resultsDir, onComplete, onFailed)
  } catch (err) {
    const errorMsg = taskAbort.signal.aborted ? 'Execution aborted' : (err instanceof Error ? err.message : String(err))
    queries.completeTaskRun(db, run.id, '', undefined, errorMsg)
    onFailed?.(task, errorMsg)
    return { success: false, output: '', errorMessage: errorMsg, durationMs: Date.now() - startTime }
  } finally {
    runningTasks.delete(taskId)
    taskAbortControllers.delete(taskId)
    releaseSlot()
  }
}

function finishRun(
  db: Database.Database,
  runId: number,
  taskId: number,
  task: Task,
  result: { stdout: string; stderr: string; exitCode: number; durationMs: number; timedOut: boolean; sessionId: string | null },
  resultsDir: string,
  onComplete?: (task: Task, output: string, durationMs: number) => void,
  onFailed?: (task: Task, error: string) => void
): TaskExecutionResult {
  const output = result.stdout || result.stderr || '(no output)'
  const resultFilePath = saveResult(resultsDir, task.name, output, result)

  // Store session ID on run and task for future runs
  if (result.sessionId) {
    try {
      queries.updateTaskRunSessionId(db, runId, result.sessionId)
      if (task.sessionContinuity) {
        queries.updateTask(db, taskId, { sessionId: result.sessionId })
      }
    } catch (err) { console.warn('Non-fatal: session ID storage failed:', err) }
  }

  if (result.exitCode === 0 && !result.timedOut) {
    queries.completeTaskRun(db, runId, output, resultFilePath)
    try { queries.storeTaskResultInMemory(db, taskId, output, true) } catch (err) { console.warn('Non-fatal: memory storage failed:', err) }
    queries.incrementRunCount(db, taskId)

    // Fire-and-forget: distill methodology from run history
    try {
      const updatedTask = queries.getTask(db, taskId)
      if (updatedTask && shouldDistill(updatedTask)) {
        distillLearnedContext(db, taskId).catch(err =>
          console.warn('Non-fatal: learned context distillation failed:', err)
        )
      }
    } catch (err) { console.warn('Non-fatal: distillation check failed:', err) }

    onComplete?.(task, output.slice(0, 200), result.durationMs)
    return { success: true, output, durationMs: result.durationMs, resultFilePath }
  } else {
    const errorMsg = result.timedOut
      ? `Timed out after ${result.durationMs}ms`
      : `Exit code ${result.exitCode}: ${result.stderr || '(no stderr)'}`
    queries.completeTaskRun(db, runId, output, resultFilePath, errorMsg)
    try { queries.storeTaskResultInMemory(db, taskId, output, false) } catch (err) { console.warn('Non-fatal: memory storage failed:', err) }

    // Auto-pause tasks with terminal errors that won't resolve on retry
    // (e.g. CLI not installed, missing API key, bad model name)
    const fullError = (output + ' ' + errorMsg).toLowerCase()
    const isTerminalError = !result.timedOut && (
      fullError.includes('failed to spawn') ||
      fullError.includes('enoent') ||
      fullError.includes('missing openai api key') ||
      fullError.includes('missing anthropic api key') ||
      fullError.includes('missing api key')
    )
    if (isTerminalError) {
      try {
        queries.updateTask(db, taskId, { status: 'paused' })
        console.log(`Task ${taskId} auto-paused: terminal error (won't retry): ${errorMsg.slice(0, 100)}`)
      } catch { /* non-fatal */ }
    }

    onFailed?.(task, errorMsg)
    return { success: false, output, errorMessage: errorMsg, durationMs: result.durationMs, resultFilePath }
  }
}

function saveResult(
  resultsDir: string,
  taskName: string,
  output: string,
  result: { exitCode: number; durationMs: number; timedOut: boolean }
): string {
  if (!existsSync(resultsDir)) {
    mkdirSync(resultsDir, { recursive: true })
  }

  const safeName = taskName.replace(/[^a-zA-Z0-9-_]/g, '_').substring(0, 50)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const fileName = `${safeName}-${timestamp}.md`
  const filePath = join(resultsDir, fileName)

  const markdown = `# Task: ${taskName}

**Date:** ${new Date().toLocaleString()}
**Duration:** ${(result.durationMs / 1000).toFixed(1)}s
**Status:** ${result.timedOut ? 'Timed Out' : result.exitCode === 0 ? 'Success' : `Failed (exit ${result.exitCode})`}

---

${output}
`

  writeFileSync(filePath, markdown, 'utf-8')
  return filePath
}

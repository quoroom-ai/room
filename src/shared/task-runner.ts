import { join } from 'path'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { executeClaudeCode } from './claude-code'
import type { ConsoleLogCallback, ExecutionOptions, ExecutionResult } from './claude-code'
import { executeAgent } from './agent-executor'
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
}

export interface TaskExecutionResult {
  success: boolean
  output: string
  errorMessage?: string
  durationMs: number
  resultFilePath?: string
}

const runningTasks = new Set<number>()

const SESSION_MAX_RUNS = 20
const CONSOLE_LOG_FLUSH_INTERVAL_MS = 1000
const DEFAULT_MAX_CONCURRENT_TASKS = 3

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

function createConsoleLogBuffer(db: Database.Database, runId: number): {
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
      buffer.push({ runId, seq, entryType: entry.entryType, content: entry.content })
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
  taskId: number
): Promise<ExecutionResult> {
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
      queries.insertConsoleLogs(db, [{
        runId,
        seq: 999999 + retries,
        entryType: 'error',
        content: `Rate limit reached. Waiting ${waitSec}s until reset ${retryLabel}`
      }])
    } catch { /* non-fatal */ }

    await sleep(rateLimitInfo.waitMs)

    queries.updateTaskRunProgress(db, runId, null, `Retrying after rate limit ${retryLabel}`)

    // Re-create console log buffer for the retry
    const retryConsoleLog = createConsoleLogBuffer(db, runId)
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
      }
    })
    retryConsoleLog.flush()
  }

  return result
}

export function isTaskRunning(taskId: number): boolean {
  return runningTasks.has(taskId)
}

export async function executeTask(
  taskId: number,
  options: TaskExecutionOptions
): Promise<TaskExecutionResult> {
  const { db, resultsDir, onComplete, onFailed } = options

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

  // Wait for a concurrency slot before spawning a Claude process
  await acquireSlot(getMaxConcurrentTasks(db, task.roomId))

  runningTasks.add(taskId)
  const startTime = Date.now()
  const run = queries.createTaskRun(db, taskId)

  try {
    // Resolve worker system prompt and model:
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
          model = room.workerModel
        }
      }
    } catch (err) {
      console.warn('Non-fatal: worker resolution failed:', err)
    }

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
    let augmentedPrompt = task.prompt
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

    const consoleLog = createConsoleLogBuffer(db, run.id)
    let lastProgressUpdate = 0

    // Ollama models: route through executeAgent() — no tool use, no session continuity
    if (model?.startsWith('ollama:')) {
      const agentResult = await executeAgent({
        model,
        prompt: augmentedPrompt,
        systemPrompt,
        timeoutMs,
      })
      consoleLog.flush()
      const result = ollamaResultToExecutionResult(agentResult)
      return finishRun(db, run.id, taskId, task, result, resultsDir, onComplete, onFailed)
    }

    const execOptions: ExecutionOptions = {
      systemPrompt,
      model,
      resumeSessionId,
      timeoutMs,
      maxTurns,
      allowedTools,
      disallowedTools,
      onConsoleLog: consoleLog.onConsoleLog,
      onProgress: (progress) => {
        const now = Date.now()
        if (now - lastProgressUpdate >= DEFAULTS.PROGRESS_THROTTLE_MS) {
          queries.updateTaskRunProgress(db, run.id, progress.fraction, progress.message)
          lastProgressUpdate = now
        }
      }
    }
    const result = await executeWithRateLimitRetry(augmentedPrompt, execOptions, db, run.id, taskId)
    consoleLog.flush()

    // If resume failed, retry without session
    if (result.exitCode !== 0 && resumeSessionId) {
      try {
        queries.clearTaskSession(db, taskId)
      } catch (err) { console.warn('Non-fatal: clear session failed:', err) }

      // Re-inject learned context + full memory context for the fresh run
      let retryPrompt = task.prompt
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

      const retryConsoleLog = createConsoleLogBuffer(db, run.id)
      lastProgressUpdate = 0
      const retryExecOptions: ExecutionOptions = {
        systemPrompt,
        model,
        timeoutMs,
        maxTurns,
        allowedTools,
        disallowedTools,
        onConsoleLog: retryConsoleLog.onConsoleLog,
        onProgress: (progress) => {
          const now = Date.now()
          if (now - lastProgressUpdate >= DEFAULTS.PROGRESS_THROTTLE_MS) {
            queries.updateTaskRunProgress(db, run.id, progress.fraction, progress.message)
            lastProgressUpdate = now
          }
        }
      }
      const retryResult = await executeWithRateLimitRetry(retryPrompt, retryExecOptions, db, run.id, taskId)
      retryConsoleLog.flush()

      return finishRun(db, run.id, taskId, task, retryResult, resultsDir, onComplete, onFailed)
    }

    return finishRun(db, run.id, taskId, task, result, resultsDir, onComplete, onFailed)
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    queries.completeTaskRun(db, run.id, '', undefined, errorMsg)
    onFailed?.(task, errorMsg)
    return { success: false, output: '', errorMessage: errorMsg, durationMs: Date.now() - startTime }
  } finally {
    runningTasks.delete(taskId)
    releaseSlot()
  }
}

function ollamaResultToExecutionResult(result: { output: string; exitCode: number; durationMs: number; sessionId: string | null; timedOut: boolean }): ExecutionResult {
  return {
    stdout: result.output,
    stderr: '',
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    sessionId: result.sessionId,
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

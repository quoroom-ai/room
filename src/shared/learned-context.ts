import type Database from 'better-sqlite3'
import type { Task } from './types'
import { executeClaudeCode } from './claude-code'
import * as queries from './db-queries'

const DISTILL_AFTER_RUNS = 3
const DISTILL_EVERY_N_RUNS = 3
const DISTILL_TIMEOUT_MS = 60_000
const MAX_LEARNED_CONTEXT_LENGTH = 1500
const MAX_RESULT_CHARS_PER_RUN = 1000
const MAX_TOOL_CALL_CHARS = 1500

/**
 * Check if a task should have its learned context distilled.
 * Returns true when:
 * - Task is recurring (not one-shot)
 * - runCount >= 3 (enough history)
 * - Either no learned context yet, or it's time for a periodic refresh
 */
export function shouldDistill(task: Task): boolean {
  // Skip one-shot tasks
  if (task.triggerType === 'once') return false
  if (task.maxRuns != null && task.maxRuns <= 1) return false

  // Need enough history
  if (task.runCount < DISTILL_AFTER_RUNS) return false

  // First distillation or periodic refresh
  if (!task.learnedContext) return true
  return task.runCount % DISTILL_EVERY_N_RUNS === 0
}

/**
 * Distill methodology from a task's run history into a concise learned context.
 * Makes a lightweight Claude call (maxTurns: 1, no tool use) to summarize
 * the approach that works for this task.
 *
 * Fire-and-forget — caller should .catch() errors.
 */
export async function distillLearnedContext(
  db: Database.Database,
  taskId: number
): Promise<string | null> {
  const task = queries.getTask(db, taskId)
  if (!task) return null

  // Gather last 3 successful run results
  const runs = queries.getTaskRuns(db, taskId, 10)
  const successfulRuns = runs.filter(r => r.status === 'completed' && r.result)
  if (successfulRuns.length < 2) return null

  const runSummaries = successfulRuns.slice(0, 3).map((r, i) => {
    const result = (r.result ?? '').slice(0, MAX_RESULT_CHARS_PER_RUN)
    return `--- Run ${i + 1} (${r.startedAt}) ---\n${result}`
  }).join('\n\n')

  // Gather tool calls from the most recent successful run
  let toolCallsText = '(no tool logs available)'
  try {
    const latestRun = successfulRuns[0]
    const logs = queries.getConsoleLogs(db, latestRun.id, 0, 50)
    const toolCalls = logs
      .filter(l => l.entryType === 'tool_call')
      .map(l => l.content)
    if (toolCalls.length > 0) {
      toolCallsText = toolCalls.join('\n').slice(0, MAX_TOOL_CALL_CHARS)
    }
  } catch {
    // Non-fatal: console logs may not be available
  }

  const distillationPrompt = `You are analyzing a recurring automated task to extract its methodology.

Task name: "${task.name}"
Task prompt: "${task.prompt.slice(0, 500)}"

Recent successful results (most recent first):
${runSummaries}

Tool usage from latest run:
${toolCallsText}

Based on this history, write a concise "methodology memo" (max 5 bullet points) that captures:
1. The specific approach/tools/APIs/URLs that work for this task
2. Any key parameters, endpoints, or search queries that produce good results
3. Pitfalls to avoid (if apparent from the history)

Write ONLY the memo as a bulleted list. No preamble, no explanation. Be specific and actionable.`

  const result = await executeClaudeCode(distillationPrompt, {
    maxTurns: 1,
    timeoutMs: DISTILL_TIMEOUT_MS
  })

  if (result.exitCode === 0 && result.stdout) {
    const context = result.stdout.trim().slice(0, MAX_LEARNED_CONTEXT_LENGTH)
    if (context.length > 0) {
      queries.updateTask(db, taskId, { learnedContext: context })
      return context
    }
  }

  return null
}

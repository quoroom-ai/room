import { join, dirname } from 'path'
import { homedir } from 'os'
import { readFileSync, existsSync } from 'fs'
import { randomBytes } from 'crypto'
import { request as httpRequest } from 'http'
import { z } from 'zod'
import cron from 'node-cron'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getMcpDatabase } from '../db'
import * as queries from '../../shared/db-queries'
import { APP_NAME, TASK_STATUSES, TRIGGER_TYPES } from '../../shared/constants'
import { executeTask, isTaskRunning } from '../../shared/task-runner'

function getServerPort(): number | null {
  try {
    const dbPath = process.env.QUOROOM_DB_PATH
    const dataDir = process.env.QUOROOM_DATA_DIR || (dbPath ? dirname(dbPath) : join(homedir(), `.${APP_NAME.toLowerCase()}`))
    const portFile = join(dataDir, 'api.port')
    if (existsSync(portFile)) {
      const port = parseInt(readFileSync(portFile, 'utf-8').trim(), 10)
      return Number.isFinite(port) && port > 0 ? port : null
    }
  } catch { /* non-fatal */ }
  return null
}

export function generateTaskName(prompt: string): string {
  const cleaned = prompt.replace(/^(please |can you |i want you to |i need you to )/i, '').trim()
  const firstSentence = cleaned.split(/[.\n]/)[0].trim()
  if (firstSentence.length <= 40) return firstSentence
  return firstSentence.substring(0, 37) + '...'
}

export function registerSchedulerTools(server: McpServer): void {
  server.registerTool(
    'quoroom_schedule',
    {
      title: 'Schedule Task',
      description:
        'Create a task — recurring (cron), one-time (specific datetime), on-demand (manual trigger), or webhook-triggered. '
        + 'Provide cronExpression for recurring, scheduledAt for one-time, triggerType="webhook" for HTTP-triggered tasks, or neither for on-demand. '
        + 'RESPONSE STYLE: After calling this tool, confirm to the user in 1 short sentence. '
        + 'Do NOT add notes, tips, caveats, or advice. Do NOT mention task IDs, cron syntax, session continuity, workers, timeouts, Electron, or internal tool names.',
      inputSchema: {
        name: z.string().max(200).optional().describe(
          'Short descriptive name for the task. If omitted, a name will be generated from the prompt. Examples: "HN Morning Digest", "Inbox Summary", "Download Organizer".'
        ),
        prompt: z.string().max(50000).describe(
          'IMPORTANT: This prompt will be executed by a SEPARATE Claude instance via `claude -p "prompt"` with NO access to the current conversation. '
          + 'The prompt MUST be completely self-contained — include ALL context, requirements, file paths, preferences, and output format. '
          + 'Do NOT reference "the file I mentioned" or "as discussed" — the executing Claude has no memory of this conversation. '
          + 'Good: "Read ~/Documents/notes.md and create a 3-bullet summary, save to ~/Quoroom/results/summary.md" '
          + 'Bad: "Summarize that file" (which file? save where?)'
        ),
        cronExpression: z.string().max(100).optional().describe(
          'Cron expression for recurring tasks. Translate user\'s natural language to cron: '
          + '"every morning" → "0 9 * * *", "weekdays at 5pm" → "0 17 * * 1-5", "every hour" → "0 * * * *". '
          + 'Omit for one-time or on-demand tasks.'
        ),
        scheduledAt: z.string().optional().describe(
          'ISO-8601 datetime for one-time tasks. Compute from user\'s intent: '
          + '"in 30 minutes" → now + 30min as ISO-8601, "at 3pm today" → today 15:00 as ISO-8601. '
          + 'Omit for recurring or on-demand tasks.'
        ),
        description: z.string().max(1000).optional().describe('Optional description of what the task does'),
        maxRuns: z.number().int().positive().optional().describe(
          'Maximum number of successful runs before the task auto-completes. Omit for unlimited.'
        ),
        workerId: z.number().int().positive().optional().describe(
          'Assign this task to a specific worker by ID. The worker\'s system prompt will be passed via --system-prompt at execution time. '
          + 'If omitted, the default worker (if any) will be used.'
        ),
        sessionContinuity: z.boolean().optional().describe(
          'Enable session continuity across runs. When true, each run continues the previous Claude CLI session, '
          + 'allowing the task to build on prior context naturally (e.g., "compared to yesterday\'s results..."). '
          + 'Default: false (each run is stateless).'
        ),
        timeout: z.number().int().positive().max(1440).optional().describe(
          'Maximum execution time in minutes. Omit for the default (30 minutes). '
          + 'Set higher for complex tasks like research or multi-step analysis. '
          + 'Example: 60 for one hour, 120 for two hours.'
        ),
        maxTurns: z.number().int().positive().max(1000).optional().describe(
          'Maximum number of agentic turns (tool use rounds) per run. '
          + 'Prevents runaway tasks. Omit for unlimited. Example: 25 for a typical web research task.'
        ),
        allowedTools: z.string().max(500).optional().describe(
          'Comma-separated list of tools the task is allowed to use. '
          + 'When set, ONLY these tools are available. '
          + 'Common tools: WebSearch, WebFetch, Read, Edit, Write, Bash, Grep, Glob. '
          + 'Example: "WebSearch,Read,Grep" for research-only tasks.'
        ),
        disallowedTools: z.string().max(500).optional().describe(
          'Comma-separated list of tools the task is NOT allowed to use. '
          + 'Example: "WebFetch" to force WebSearch-only (avoids slow URL fetches). '
          + '"Edit,Write" to make a task read-only.'
        ),
        triggerType: z.enum(['cron', 'once', 'manual', 'webhook']).optional().describe(
          'Override the trigger type. "webhook": task runs when an external service POSTs to its webhook URL. '
          + 'Usually inferred automatically — only set this explicitly for webhook tasks.'
        ),
        roomId: z.number().int().positive().optional().describe(
          'Assign this task to a room by ID. When set, the task is scoped to that room.'
        )
      }
    },
    async ({ name, prompt, cronExpression, scheduledAt, description, maxRuns, workerId, sessionContinuity, timeout, maxTurns, allowedTools, disallowedTools, triggerType: triggerTypeInput, roomId }) => {
      const db = getMcpDatabase()

      // Auto-determine trigger type
      let triggerType: 'cron' | 'once' | 'manual' | 'webhook' = triggerTypeInput ?? 'manual'
      if (!triggerTypeInput) {
        if (cronExpression) triggerType = 'cron'
        else if (scheduledAt) triggerType = 'once'
      }

      // Auto-generate name if not provided
      const taskName = (name || generateTaskName(prompt) || 'Untitled task').trim()

      // Validate cron expression
      if (triggerType === 'cron' && cronExpression && !cron.validate(cronExpression)) {
        return {
          content: [{
            type: 'text' as const,
            text: `Invalid cron expression: "${cronExpression}". Use standard cron format (e.g. "0 9 * * *" for daily at 9am).`
          }]
        }
      }

      // Validate one-time task datetime
      if (triggerType === 'once') {
        const date = new Date(scheduledAt!)
        if (isNaN(date.getTime())) {
          return {
            content: [{
              type: 'text' as const,
              text: `Invalid datetime: "${scheduledAt}". Please use ISO-8601 format (e.g. "2026-02-14T15:00:00").`
            }]
          }
        }
        if (date <= new Date()) {
          return {
            content: [{
              type: 'text' as const,
              text: `Scheduled time "${scheduledAt}" is in the past. Please provide a future datetime.`
            }]
          }
        }
      }

      if (workerId) {
        const worker = queries.getWorker(db, workerId)
        if (!worker) {
          return {
            content: [{
              type: 'text' as const,
              text: `No worker found with id ${workerId}. Use quoroom_list_workers to see valid IDs.`
            }],
            isError: true
          }
        }
      }

      const webhookToken = triggerType === TRIGGER_TYPES.WEBHOOK
        ? randomBytes(16).toString('hex')
        : undefined

      const task = queries.createTask(db, {
        name: taskName,
        prompt,
        cronExpression: cronExpression ?? undefined,
        scheduledAt: scheduledAt ?? undefined,
        triggerType,
        triggerConfig: JSON.stringify({ source: process.env.QUOROOM_SOURCE || 'claude-desktop' }),
        webhookToken,
        description,
        executor: 'claude_code',
        maxRuns: maxRuns ?? undefined,
        workerId: workerId ?? undefined,
        sessionContinuity: sessionContinuity ?? false,
        timeoutMinutes: timeout ?? undefined,
        maxTurns: maxTurns ?? undefined,
        allowedTools: allowedTools ?? undefined,
        disallowedTools: disallowedTools ?? undefined,
        roomId: roomId ?? undefined
      })

      if (triggerType === TRIGGER_TYPES.WEBHOOK) {
        const port = getServerPort()
        const webhookUrl = port
          ? `http://localhost:${port}/api/hooks/task/${webhookToken}`
          : `/api/hooks/task/${webhookToken}`
        return {
          content: [{
            type: 'text' as const,
            text: `Created webhook task "${taskName}" (id: ${task.id}).\nWebhook URL: ${webhookUrl}\nTrigger it with: curl -X POST ${webhookUrl}`
          }]
        }
      } else if (triggerType === TRIGGER_TYPES.CRON) {
        return {
          content: [{
            type: 'text' as const,
            text: `Scheduled recurring task "${taskName}".`
          }]
        }
      } else if (triggerType === TRIGGER_TYPES.ONCE) {
        return {
          content: [{
            type: 'text' as const,
            text: `Scheduled one-time task "${taskName}" for ${scheduledAt}.`
          }]
        }
      } else {
        return {
          content: [{
            type: 'text' as const,
            text: `Created on-demand task "${taskName}".`
          }]
        }
      }
    }
  )

  server.registerTool(
    'quoroom_list_tasks',
    {
      title: 'List Tasks',
      description: 'List all scheduled tasks, optionally filtered by status.',
      inputSchema: {
        status: z.enum(['active', 'paused', 'completed']).optional().describe('Filter by status: active, paused, completed (omit for all)')
      }
    },
    async ({ status }) => {
      const db = getMcpDatabase()
      const tasks = queries.listTasks(db, undefined, status)

      if (tasks.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No tasks found.' }]
        }
      }

      const list = tasks.map((t) => {
        const worker = t.workerId ? queries.getWorker(db, t.workerId) : null
        return {
          id: t.id,
          name: t.name,
          status: t.status,
          triggerType: t.triggerType,
          schedule: t.cronExpression,
          scheduledAt: t.scheduledAt,
          lastRun: t.lastRun,
          errorCount: t.errorCount,
          maxRuns: t.maxRuns,
          runCount: t.runCount,
          description: t.description,
          workerId: t.workerId,
          workerName: worker?.name ?? null,
          workerRole: worker?.role ?? null,
          sessionContinuity: t.sessionContinuity,
          learnedContext: t.learnedContext ? t.learnedContext.slice(0, 200) + (t.learnedContext.length > 200 ? '...' : '') : null
        }
      })

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(list, null, 2)
          }
        ]
      }
    }
  )

  server.registerTool(
    'quoroom_run_task',
    {
      title: 'Run Task Now',
      description: 'Execute a task immediately. Returns right away — use quoroom_task_progress to check status.',
      inputSchema: {
        id: z.number().describe('The task ID to run')
      }
    },
    async ({ id }) => {
      const db = getMcpDatabase()
      const task = queries.getTask(db, id)
      if (!task) {
        return {
          content: [{ type: 'text' as const, text: `No task found with id ${id}.` }]
        }
      }

      if (isTaskRunning(id)) {
        return {
          content: [{ type: 'text' as const, text: `Task "${task.name}" is already running. Use quoroom_task_progress to check status.` }]
        }
      }

      // For ad-hoc runs, temporarily allow execution without changing persistent status
      const originalStatus = task.status
      if (task.status !== TASK_STATUSES.ACTIVE) {
        queries.updateTask(db, id, { status: TASK_STATUSES.ACTIVE })
      }

      const resultsDir = process.env.QUOROOM_RESULTS_DIR || join(homedir(), APP_NAME, 'results')

      // Fire and forget — execute in background
      executeTask(id, { db, resultsDir })
        .then((result) => {
          // Restore original status if it was changed for ad-hoc execution
          if (originalStatus !== TASK_STATUSES.ACTIVE) {
            const currentTask = queries.getTask(db, id)
            if (currentTask && currentTask.status === TASK_STATUSES.ACTIVE) {
              queries.updateTask(db, id, { status: originalStatus })
            }
          }
          if (!result.success) {
            console.error(`Task ${id} ("${task.name}") failed: ${result.errorMessage}`)
          }

          // Relay to sidecar for Electron push notifications (best-effort)
          try {
            const dbPath = process.env.QUOROOM_DB_PATH
            if (dbPath) {
              const dataDir = process.env.QUOROOM_DATA_DIR || dirname(dbPath)
              const port = parseInt(readFileSync(join(dataDir, 'sidecar.port'), 'utf-8').trim(), 10)
              if (port > 0) {
                const event = result.success ? 'task:complete' : 'task:failed'
                const payload = JSON.stringify({
                  event,
                  taskId: id,
                  taskName: task.name,
                  success: result.success,
                  ...(result.success
                    ? { outputPreview: result.output?.slice(0, 200), durationMs: result.durationMs }
                    : { errorMessage: result.errorMessage })
                })
                const req = httpRequest({
                  hostname: '127.0.0.1', port, path: '/notify', method: 'POST',
                  headers: { 'Content-Type': 'application/json' }
                })
                req.on('error', () => {}) // non-fatal
                req.write(payload)
                req.end()
              }
            }
          } catch { /* non-fatal — sidecar may not be running */ }
        })
        .catch((err) => {
          console.error(`Task ${id} ("${task.name}") execution error:`, err)
          if (originalStatus !== TASK_STATUSES.ACTIVE) {
            try {
              const currentTask = queries.getTask(db, id)
              if (currentTask && currentTask.status === TASK_STATUSES.ACTIVE) {
                queries.updateTask(db, id, { status: originalStatus })
              }
            } catch { /* non-fatal */ }
          }
        })

      return {
        content: [{
          type: 'text' as const,
          text: `Task "${task.name}" started. Use quoroom_task_progress to check status.`
        }]
      }
    }
  )

  server.registerTool(
    'quoroom_pause_task',
    {
      title: 'Pause Task',
      description: 'Pause a scheduled task by its ID. The task will not run until resumed. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence. No notes, tips, or implementation details.',
      inputSchema: {
        id: z.number().describe('The task ID to pause')
      }
    },
    async ({ id }) => {
      const db = getMcpDatabase()
      const task = queries.getTask(db, id)
      if (!task) {
        return {
          content: [{ type: 'text' as const, text: `No task found with id ${id}.` }]
        }
      }
      queries.pauseTask(db, id)
      return {
        content: [
          {
            type: 'text' as const,
            text: `Paused "${task.name}".`
          }
        ]
      }
    }
  )

  server.registerTool(
    'quoroom_resume_task',
    {
      title: 'Resume Task',
      description: 'Resume a paused task by its ID. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence. No notes, tips, or implementation details.',
      inputSchema: {
        id: z.number().describe('The task ID to resume')
      }
    },
    async ({ id }) => {
      const db = getMcpDatabase()
      const task = queries.getTask(db, id)
      if (!task) {
        return {
          content: [{ type: 'text' as const, text: `No task found with id ${id}.` }]
        }
      }
      queries.resumeTask(db, id)
      return {
        content: [
          {
            type: 'text' as const,
            text: `Resumed "${task.name}".`
          }
        ]
      }
    }
  )

  server.registerTool(
    'quoroom_delete_task',
    {
      title: 'Delete Task',
      description: 'Delete a scheduled task by its ID. This also removes all run history. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence. No notes, tips, or implementation details.',
      inputSchema: {
        id: z.number().describe('The task ID to delete')
      }
    },
    async ({ id }) => {
      const db = getMcpDatabase()
      const task = queries.getTask(db, id)
      if (!task) {
        return {
          content: [{ type: 'text' as const, text: `No task found with id ${id}.` }]
        }
      }
      queries.deleteTask(db, id)
      return {
        content: [
          {
            type: 'text' as const,
            text: `Deleted "${task.name}".`
          }
        ]
      }
    }
  )

  server.registerTool(
    'quoroom_task_history',
    {
      title: 'Task History',
      description: 'Show recent execution history for a task.',
      inputSchema: {
        taskId: z.number().int().positive().describe('The task ID to get history for'),
        limit: z.number().int().positive().max(100).default(10).describe('Maximum number of runs to return')
      }
    },
    async ({ taskId, limit }) => {
      const db = getMcpDatabase()
      const task = queries.getTask(db, taskId)
      if (!task) {
        return {
          content: [{ type: 'text' as const, text: `No task found with id ${taskId}.` }]
        }
      }

      const runs = queries.getTaskRuns(db, taskId, limit)

      if (runs.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No runs found for task "${task.name}".` }]
        }
      }

      const history = runs.map((r) => ({
        id: r.id,
        status: r.status,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        durationMs: r.durationMs,
        error: r.errorMessage,
        resultFile: r.resultFile
      }))

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              task: task.name,
              learnedContext: task.learnedContext ?? null,
              runs: history
            }, null, 2)
          }
        ]
      }
    }
  )

  server.registerTool(
    'quoroom_task_progress',
    {
      title: 'Task Progress',
      description: 'Check the current execution progress of a running task.',
      inputSchema: {
        taskId: z.number().describe('The task ID to check progress for')
      }
    },
    async ({ taskId }) => {
      const db = getMcpDatabase()
      const task = queries.getTask(db, taskId)
      if (!task) {
        return {
          content: [{ type: 'text' as const, text: `No task found with id ${taskId}.` }]
        }
      }

      const latestRun = queries.getLatestTaskRun(db, taskId)
      if (!latestRun) {
        return {
          content: [{ type: 'text' as const, text: `No runs found for task "${task.name}".` }]
        }
      }

      if (latestRun.status !== 'running') {
        const consoleLogs = queries.getConsoleLogs(db, latestRun.id, 0, 10)
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              task: task.name,
              runId: latestRun.id,
              status: latestRun.status,
              progress: latestRun.progress,
              progressMessage: latestRun.progressMessage,
              finishedAt: latestRun.finishedAt,
              durationMs: latestRun.durationMs,
              recentConsoleLogs: consoleLogs.map(l => ({ type: l.entryType, content: l.content }))
            }, null, 2)
          }]
        }
      }

      const elapsedMs = Date.now() - new Date(latestRun.startedAt).getTime()
      const consoleLogs = queries.getConsoleLogs(db, latestRun.id, 0, 10)
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            task: task.name,
            runId: latestRun.id,
            status: 'running',
            progress: latestRun.progress,
            progressMessage: latestRun.progressMessage,
            elapsedMs,
            elapsedFormatted: `${(elapsedMs / 1000).toFixed(1)}s`,
            recentConsoleLogs: consoleLogs.map(l => ({ type: l.entryType, content: l.content }))
          }, null, 2)
        }]
      }
    }
  )

  server.registerTool(
    'quoroom_reset_session',
    {
      title: 'Reset Task Session',
      description: 'Clear the session for a task, forcing the next run to start a fresh conversation. Only relevant for tasks with session continuity enabled. '
        + 'RESPONSE STYLE: Confirm briefly in 1 sentence. No notes, tips, or implementation details.',
      inputSchema: {
        id: z.number().describe('The task ID to reset the session for')
      }
    },
    async ({ id }) => {
      const db = getMcpDatabase()
      const task = queries.getTask(db, id)
      if (!task) {
        return { content: [{ type: 'text' as const, text: `No task found with id ${id}.` }] }
      }
      queries.clearTaskSession(db, id)
      return {
        content: [{
          type: 'text' as const,
          text: `Session cleared for "${task.name}".`
        }]
      }
    }
  )

  server.registerTool(
    'quoroom_webhook_url',
    {
      title: 'Get Webhook URL',
      description: 'Get the webhook URL for a task or room. '
        + 'For tasks: use the URL to trigger the task from external services (GitHub, Stripe, monitoring tools, etc.). '
        + 'For rooms: use the URL to inject a message and immediately wake the queen.',
      inputSchema: {
        taskId: z.number().int().positive().optional().describe('Task ID to get the webhook URL for'),
        roomId: z.number().int().positive().optional().describe('Room ID to get the queen-wake webhook URL for'),
        generateIfMissing: z.boolean().optional().describe('If the task/room has no webhook token, generate one. Default: false.')
      }
    },
    async ({ taskId, roomId, generateIfMissing }) => {
      const db = getMcpDatabase()
      const port = getServerPort()

      if (taskId) {
        const task = queries.getTask(db, taskId)
        if (!task) {
          return { content: [{ type: 'text' as const, text: `No task found with id ${taskId}.` }] }
        }
        let token = task.webhookToken
        if (!token && generateIfMissing) {
          token = randomBytes(16).toString('hex')
          queries.updateTask(db, taskId, { webhookToken: token })
        }
        if (!token) {
          return {
            content: [{ type: 'text' as const, text: `Task "${task.name}" has no webhook token. Pass generateIfMissing: true to create one.` }]
          }
        }
        const url = port
          ? `http://localhost:${port}/api/hooks/task/${token}`
          : `/api/hooks/task/${token}`
        return {
          content: [{
            type: 'text' as const,
            text: `Webhook URL for task "${task.name}":\n${url}\n\nTrigger: curl -X POST ${url}\nWith payload: curl -X POST ${url} -H "Content-Type: application/json" -d '{"message":"triggered by github"}'`
          }]
        }
      }

      if (roomId) {
        const room = queries.getRoom(db, roomId)
        if (!room) {
          return { content: [{ type: 'text' as const, text: `No room found with id ${roomId}.` }] }
        }
        let token = room.webhookToken
        if (!token && generateIfMissing) {
          token = randomBytes(16).toString('hex')
          queries.updateRoom(db, roomId, { webhookToken: token })
        }
        if (!token) {
          return {
            content: [{ type: 'text' as const, text: `Room "${room.name}" has no webhook token. Pass generateIfMissing: true to create one.` }]
          }
        }
        const url = port
          ? `http://localhost:${port}/api/hooks/queen/${token}`
          : `/api/hooks/queen/${token}`
        return {
          content: [{
            type: 'text' as const,
            text: `Queen-wake webhook URL for room "${room.name}":\n${url}\n\nTrigger: curl -X POST ${url} -H "Content-Type: application/json" -d '{"message":"your event description here"}'`
          }]
        }
      }

      return { content: [{ type: 'text' as const, text: 'Provide either taskId or roomId.' }] }
    }
  )
}

import { watch as fsWatch, statSync, existsSync, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import cron from 'node-cron'
import type Database from 'better-sqlite3'
import * as queries from '../shared/db-queries'
import { APP_NAME } from '../shared/constants'
import { executeTask, isTaskRunning } from '../shared/task-runner'
import { executeAgent } from '../shared/agent-executor'
import { resolveApiKeyForModel } from '../shared/model-provider'
import { triggerAgent } from '../shared/agent-loop'
import {
  ensureCloudRoomToken,
  fetchCloudRoomMessages,
  getRoomCloudId,
  sendCloudRoomMessage,
} from '../shared/cloud-sync'
import { pollQueenInbox } from './routes/contacts'
import type { Watch } from '../shared/types'
import { eventBus } from './event-bus'

const SCHEDULER_REFRESH_MS = 15_000
const WATCH_REFRESH_MS = 15_000
const TASK_MAINTENANCE_MS = 60_000
const CLOUD_MESSAGE_SYNC_MS = 60_000
const QUEEN_INBOX_POLL_MS = 60_000
const WATCH_DEBOUNCE_MS = 1_500

const cronJobs = new Map<number, { expression: string; job: cron.ScheduledTask }>()
const pendingTaskStarts = new Set<number>()

interface WatchRuntimeState {
  watcher: FSWatcher
  debounceTimer: ReturnType<typeof setTimeout> | null
  pending: { eventType: string; changedPath: string } | null
  running: boolean
}

const watchStates = new Map<number, WatchRuntimeState>()

let schedulerTimer: ReturnType<typeof setInterval> | null = null
let watcherTimer: ReturnType<typeof setInterval> | null = null
let maintenanceTimer: ReturnType<typeof setInterval> | null = null
let cloudMessageTimer: ReturnType<typeof setInterval> | null = null
let queenInboxTimer: ReturnType<typeof setInterval> | null = null
let cloudSyncInFlight = false
let queenInboxInFlight = false

function getResultsDir(): string {
  return process.env.QUOROOM_RESULTS_DIR || join(homedir(), APP_NAME, 'results')
}

interface QueueTaskOptions {
  allowInactive: boolean
  source: 'manual' | 'cron' | 'once'
}

function queueTaskExecution(
  db: Database.Database,
  taskId: number,
  options: QueueTaskOptions
): { started: boolean; reason?: string } {
  const task = queries.getTask(db, taskId)
  if (!task) return { started: false, reason: `Task ${taskId} not found` }

  if (!options.allowInactive && task.status !== 'active') {
    return { started: false, reason: `Task ${taskId} is ${task.status}` }
  }

  if (pendingTaskStarts.has(taskId) || isTaskRunning(taskId)) {
    return { started: false, reason: 'Task is already running' }
  }

  const originalStatus = task.status
  if (options.allowInactive && task.status !== 'active') {
    queries.updateTask(db, taskId, { status: 'active' })
  }

  pendingTaskStarts.add(taskId)
  eventBus.emit('runs', 'run:created', { taskId, source: options.source })

  void executeTask(taskId, {
    db,
    resultsDir: getResultsDir(),
    onComplete: (t) => eventBus.emit('runs', 'run:completed', { taskId: t.id, roomId: t.roomId }),
    onFailed: (t, error) => eventBus.emit('runs', 'run:failed', { taskId: t.id, roomId: t.roomId, error }),
    onConsoleLogEntry: (entry) => {
      eventBus.emit(`run:${entry.runId}`, 'run:log', entry)
    },
  })
    .catch((err) => {
      console.error(`Task ${taskId} execution error:`, err)
    })
    .finally(() => {
      pendingTaskStarts.delete(taskId)
      if (options.allowInactive && originalStatus !== 'active') {
        const current = queries.getTask(db, taskId)
        if (current && current.status === 'active') {
          queries.updateTask(db, taskId, { status: originalStatus })
        }
      }
    })

  return { started: true }
}

export function runTaskNow(
  db: Database.Database,
  taskId: number
): { started: boolean; reason?: string } {
  return queueTaskExecution(db, taskId, { allowInactive: true, source: 'manual' })
}

function refreshCronJobs(db: Database.Database): void {
  const activeTasks = queries.listTasks(db, undefined, 'active')
  const cronTasks = activeTasks.filter((task) => task.triggerType === 'cron' && task.cronExpression)
  const activeIds = new Set(cronTasks.map((task) => task.id))

  for (const [taskId, entry] of cronJobs.entries()) {
    const task = cronTasks.find((candidate) => candidate.id === taskId)
    if (!task || task.cronExpression !== entry.expression) {
      entry.job.stop()
      cronJobs.delete(taskId)
    }
  }

  for (const task of cronTasks) {
    if (cronJobs.has(task.id)) continue
    const expression = task.cronExpression!
    if (!cron.validate(expression)) continue

    const job = cron.schedule(expression, () => {
      queueTaskExecution(db, task.id, { allowInactive: false, source: 'cron' })
    })

    cronJobs.set(task.id, { expression, job })
  }

  for (const [taskId, entry] of cronJobs.entries()) {
    if (!activeIds.has(taskId)) {
      entry.job.stop()
      cronJobs.delete(taskId)
    }
  }
}

function runDueOneTimeTasks(db: Database.Database): void {
  const due = queries.getDueOnceTasks(db)
  for (const task of due) {
    queueTaskExecution(db, task.id, { allowInactive: false, source: 'once' })
    queries.updateTask(db, task.id, { status: 'completed' })
  }
}

function runTaskMaintenance(db: Database.Database): void {
  queries.cleanupStaleRuns(db)
  queries.pruneOldRuns(db)
}

function closeWatch(id: number): void {
  const state = watchStates.get(id)
  if (!state) return
  if (state.debounceTimer) clearTimeout(state.debounceTimer)
  try { state.watcher.close() } catch { /* ignore */ }
  watchStates.delete(id)
}

function executeWatchAction(db: Database.Database, watch: Watch, eventType: string, changedPath: string): Promise<void> {
  return (async () => {
    queries.markWatchTriggered(db, watch.id)

    if (!watch.actionPrompt?.trim()) {
      return
    }

    let model = 'claude'
    let systemPrompt: string | undefined
    let apiKey: string | undefined

    if (watch.roomId != null) {
      const room = queries.getRoom(db, watch.roomId)
      if (room?.queenWorkerId) {
        const queen = queries.getWorker(db, room.queenWorkerId)
        if (queen) {
          model = queen.model ?? 'claude'
          systemPrompt = queen.systemPrompt
        }
      }
      apiKey = resolveApiKeyForModel(db, watch.roomId, model)
    }

    const prompt = [
      watch.actionPrompt.trim(),
      '',
      '## Watch Event',
      `- Event: ${eventType}`,
      `- Watched path: ${watch.path}`,
      `- Changed path: ${changedPath}`
    ].join('\n')

    const result = await executeAgent({
      model,
      prompt,
      systemPrompt,
      apiKey,
      maxTurns: 6,
      timeoutMs: 3 * 60 * 1000
    })

    if (watch.roomId != null) {
      if (result.exitCode === 0 && !result.timedOut) {
        queries.logRoomActivity(
          db,
          watch.roomId,
          'system',
          `Watch triggered: ${watch.path}`,
          result.output.slice(0, 500)
        )
      } else {
        queries.logRoomActivity(
          db,
          watch.roomId,
          'error',
          `Watch action failed: ${watch.path}`,
          result.output.slice(0, 500)
        )
      }
    }
  })().catch((err) => {
    console.error(`Watch ${watch.id} execution error:`, err)
  })
}

function scheduleWatchExecution(db: Database.Database, watch: Watch, eventType: string, changedPath: string): void {
  const state = watchStates.get(watch.id)
  if (!state) return

  const execute = (): void => {
    if (state.running) {
      state.pending = { eventType, changedPath }
      return
    }
    state.running = true
    void executeWatchAction(db, watch, eventType, changedPath)
      .finally(() => {
        state.running = false
        if (state.pending) {
          const pending = state.pending
          state.pending = null
          scheduleWatchExecution(db, watch, pending.eventType, pending.changedPath)
        }
      })
  }

  if (state.debounceTimer) clearTimeout(state.debounceTimer)
  state.debounceTimer = setTimeout(execute, WATCH_DEBOUNCE_MS)
}

function startWatch(db: Database.Database, watch: Watch): void {
  if (watchStates.has(watch.id)) return
  if (!existsSync(watch.path)) return

  const isDirectory = (() => {
    try {
      return statSync(watch.path).isDirectory()
    } catch {
      return false
    }
  })()

  let watcher: FSWatcher
  const onChange = (eventType: string, filename: string | null): void => {
    const changed = filename ? join(watch.path, filename.toString()) : watch.path
    scheduleWatchExecution(db, watch, eventType, changed)
  }

  try {
    watcher = fsWatch(watch.path, { recursive: isDirectory, encoding: 'utf8' }, onChange)
  } catch {
    try {
      watcher = fsWatch(watch.path, { encoding: 'utf8' }, onChange)
    } catch {
      return
    }
  }

  watchStates.set(watch.id, {
    watcher,
    debounceTimer: null,
    pending: null,
    running: false
  })
}

function refreshWatches(db: Database.Database): void {
  const active = queries.listWatches(db, undefined, 'active')
  const activeIds = new Set(active.map((watch) => watch.id))

  for (const watch of active) {
    if (!watchStates.has(watch.id)) startWatch(db, watch)
  }

  for (const id of watchStates.keys()) {
    if (!activeIds.has(id)) closeWatch(id)
  }
}

async function syncCloudRoomMessages(db: Database.Database): Promise<void> {
  const rooms = queries.listRooms(db)
  const keeperReferralCode = queries.getSetting(db, 'keeper_referral_code')
  for (const room of rooms) {
    const cloudRoomId = getRoomCloudId(room.id)
    const hasToken = await ensureCloudRoomToken({
      roomId: cloudRoomId,
      name: room.name,
      goal: room.goal ?? null,
      visibility: room.visibility,
      referredByCode: room.referredByCode,
      keeperReferralCode,
    })
    if (!hasToken) continue

    const outbound = queries.listRoomMessages(db, room.id, 'unread')
      .filter((message) => message.direction === 'outbound' && message.toRoomId)

    for (const message of outbound) {
      const sent = await sendCloudRoomMessage(
        cloudRoomId,
        message.toRoomId!,
        message.subject,
        message.body
      )
      if (!sent) continue
      queries.markRoomMessageRead(db, message.id)
      eventBus.emit(`room:${room.id}`, 'room_message:updated', { id: message.id, status: 'read' })
    }

    const inbound = await fetchCloudRoomMessages(cloudRoomId)
    for (const message of inbound) {
      const saved = queries.createRoomMessage(db, room.id, 'inbound', message.subject, message.body, {
        fromRoomId: message.fromRoomId,
        toRoomId: message.toRoomId
      })
      eventBus.emit(`room:${room.id}`, 'room_message:created', saved)
    }
  }
}

export function startServerRuntime(db: Database.Database): void {
  stopServerRuntime()

  refreshCronJobs(db)
  runDueOneTimeTasks(db)
  runTaskMaintenance(db)
  refreshWatches(db)
  void syncCloudRoomMessages(db)

  schedulerTimer = setInterval(() => {
    refreshCronJobs(db)
    runDueOneTimeTasks(db)
  }, SCHEDULER_REFRESH_MS)

  watcherTimer = setInterval(() => {
    refreshWatches(db)
  }, WATCH_REFRESH_MS)

  maintenanceTimer = setInterval(() => {
    runTaskMaintenance(db)
  }, TASK_MAINTENANCE_MS)

  cloudMessageTimer = setInterval(() => {
    if (cloudSyncInFlight) return
    cloudSyncInFlight = true
    void syncCloudRoomMessages(db).finally(() => {
      cloudSyncInFlight = false
    })
  }, CLOUD_MESSAGE_SYNC_MS)

  queenInboxTimer = setInterval(() => {
    if (queenInboxInFlight) return
    queenInboxInFlight = true
    void pollQueenInbox(db).finally(() => {
      queenInboxInFlight = false
    })
  }, QUEEN_INBOX_POLL_MS)

  resumeActiveQueens(db)
}

function makeCycleCallbacks() {
  return {
    onCycleLogEntry: (entry: { cycleId: number; seq: number; entryType: string; content: string }) => {
      eventBus.emit(`cycle:${entry.cycleId}`, 'cycle:log', entry)
    },
    onCycleLifecycle: (event: 'created' | 'completed' | 'failed', cycleId: number, roomId: number) => {
      eventBus.emit(`room:${roomId}`, `cycle:${event}`, { cycleId, roomId })
    }
  }
}

function resumeActiveQueens(db: Database.Database): void {
  // Cleanup stale cycles from previous server run
  const cleaned = queries.cleanupStaleCycles(db)
  if (cleaned > 0) console.log(`Cleaned up ${cleaned} stale worker cycles`)

  const rooms = queries.listRooms(db, 'active')
  const callbacks = makeCycleCallbacks()
  for (const room of rooms) {
    if (!room.queenWorkerId) continue
    console.log(`Auto-resuming queen for room "${room.name}" (#${room.id})`)
    triggerAgent(db, room.id, room.queenWorkerId, callbacks)
  }
}

export function stopServerRuntime(): void {
  if (schedulerTimer) clearInterval(schedulerTimer)
  if (watcherTimer) clearInterval(watcherTimer)
  if (maintenanceTimer) clearInterval(maintenanceTimer)
  if (cloudMessageTimer) clearInterval(cloudMessageTimer)
  if (queenInboxTimer) clearInterval(queenInboxTimer)
  schedulerTimer = null
  watcherTimer = null
  maintenanceTimer = null
  cloudMessageTimer = null
  queenInboxTimer = null
  cloudSyncInFlight = false
  queenInboxInFlight = false

  for (const [, entry] of cronJobs) {
    entry.job.stop()
  }
  cronJobs.clear()
  pendingTaskStarts.clear()

  for (const id of [...watchStates.keys()]) {
    closeWatch(id)
  }
}

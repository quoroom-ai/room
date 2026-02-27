import { join } from 'node:path'
import { homedir } from 'node:os'
import cron from 'node-cron'
import type Database from 'better-sqlite3'
import * as queries from '../shared/db-queries'
import { APP_NAME } from '../shared/constants'
import { executeTask, isTaskRunning } from '../shared/task-runner'
import { startCommentaryEngine, stopCommentaryEngine } from './clerk-commentary'
import { triggerAgent } from '../shared/agent-loop'
import {
  ensureCloudRoomToken,
  fetchCloudRoomMessages,
  getRoomCloudId,
  sendCloudRoomMessage,
} from '../shared/cloud-sync'
import { pollQueenInbox } from './routes/contacts'
import { relayPendingKeeperRequests } from './clerk-notifications'
import { eventBus } from './event-bus'

const SCHEDULER_REFRESH_MS = 15_000
const TASK_MAINTENANCE_MS = 60_000
const CLOUD_MESSAGE_SYNC_MS = 60_000
const QUEEN_INBOX_POLL_MS = getBoundedIntervalMs('QUOROOM_QUEEN_INBOX_POLL_MS', 2_500, 1_000, 30_000)
const CLERK_ALERT_RELAY_MS = getBoundedIntervalMs('QUOROOM_CLERK_ALERT_RELAY_MS', 15_000, 3_000, 120_000)
const CLERK_CONTACT_ONBOARDING_START_KEY = 'clerk_contact_onboarding_started_at'

const cronJobs = new Map<number, { expression: string; job: cron.ScheduledTask }>()
const pendingTaskStarts = new Set<number>()

let schedulerTimer: ReturnType<typeof setInterval> | null = null
let maintenanceTimer: ReturnType<typeof setInterval> | null = null
let cloudMessageTimer: ReturnType<typeof setInterval> | null = null
let queenInboxTimer: ReturnType<typeof setInterval> | null = null
let clerkAlertTimer: ReturnType<typeof setInterval> | null = null
let cloudSyncInFlight = false
let queenInboxInFlight = false
let queenInboxRepollRequested = false
let clerkAlertInFlight = false
let clerkAlertRepollRequested = false

function getBoundedIntervalMs(envKey: string, fallback: number, min: number, max: number): number {
  const raw = Number.parseInt((process.env[envKey] || '').trim(), 10)
  if (!Number.isFinite(raw)) return fallback
  return Math.min(max, Math.max(min, raw))
}

function queueQueenInboxPoll(db: Database.Database): void {
  if (queenInboxInFlight) {
    queenInboxRepollRequested = true
    return
  }

  queenInboxInFlight = true
  void pollQueenInbox(db).finally(() => {
    queenInboxInFlight = false
    if (queenInboxRepollRequested) {
      queenInboxRepollRequested = false
      queueQueenInboxPoll(db)
    }
  })
}

function queueClerkAlertRelay(db: Database.Database): void {
  if (clerkAlertInFlight) {
    clerkAlertRepollRequested = true
    return
  }

  clerkAlertInFlight = true
  void relayPendingKeeperRequests(db).finally(() => {
    clerkAlertInFlight = false
    if (clerkAlertRepollRequested) {
      clerkAlertRepollRequested = false
      queueClerkAlertRelay(db)
    }
  })
}

function getResultsDir(): string {
  return process.env.QUOROOM_RESULTS_DIR || join(homedir(), APP_NAME, 'results')
}

interface QueueTaskOptions {
  allowInactive: boolean
  source: 'manual' | 'cron' | 'once' | 'webhook'
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
    onComplete: (t, output) => {
      eventBus.emit('runs', 'run:completed', { taskId: t.id, roomId: t.roomId })
      if (t.executor === 'keeper_reminder') {
        eventBus.emit('clerk', 'clerk:commentary', { content: output, source: 'task' })
      } else if (t.executor === 'keeper_contact_check' && output.startsWith('Keeper action needed:')) {
        eventBus.emit('clerk', 'clerk:commentary', { content: output, source: 'task' })
      }
    },
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

function toSqliteLocalDateTime(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  const second = String(date.getSeconds()).padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`
}

function getOrInitContactOnboardingStart(db: Database.Database): Date {
  const raw = queries.getSetting(db, CLERK_CONTACT_ONBOARDING_START_KEY)?.trim() ?? ''
  if (raw) {
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) return new Date(parsed)
  }
  const now = new Date()
  queries.setSetting(db, CLERK_CONTACT_ONBOARDING_START_KEY, now.toISOString())
  return now
}

function hasContactCheckTask(db: Database.Database, day: 1 | 7): boolean {
  const marker = `"day":${day}`
  return queries.listTasks(db).some((task) =>
    task.executor === 'keeper_contact_check'
    && (task.triggerConfig ?? '').includes(marker)
  )
}

function ensureClerkContactCheckTasks(db: Database.Database): void {
  const start = getOrInitContactOnboardingStart(db)
  const checkpoints: Array<{ day: 1 | 7; offsetDays: number; name: string }> = [
    { day: 1, offsetDays: 1, name: 'Clerk contact check (day 1)' },
    { day: 7, offsetDays: 7, name: 'Clerk contact check (day 7)' },
  ]

  for (const checkpoint of checkpoints) {
    if (hasContactCheckTask(db, checkpoint.day)) continue
    const runAt = new Date(start.getTime() + checkpoint.offsetDays * 24 * 60 * 60 * 1000)
    queries.createTask(db, {
      name: checkpoint.name,
      description: 'Auto-check keeper contact connection (email/telegram).',
      prompt: 'Check keeper contact channels and ask to connect if missing.',
      triggerType: 'once',
      scheduledAt: toSqliteLocalDateTime(runAt),
      executor: 'keeper_contact_check',
      maxRuns: 1,
      triggerConfig: JSON.stringify({
        source: 'runtime',
        kind: 'keeper_contact_check',
        day: checkpoint.day
      })
    })
  }
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

  ensureClerkContactCheckTasks(db)
  refreshCronJobs(db)
  runDueOneTimeTasks(db)
  runTaskMaintenance(db)
  void syncCloudRoomMessages(db)
  queueQueenInboxPoll(db)
  queueClerkAlertRelay(db)

  schedulerTimer = setInterval(() => {
    refreshCronJobs(db)
    runDueOneTimeTasks(db)
  }, SCHEDULER_REFRESH_MS)

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
    queueQueenInboxPoll(db)
  }, QUEEN_INBOX_POLL_MS)

  clerkAlertTimer = setInterval(() => {
    queueClerkAlertRelay(db)
  }, CLERK_ALERT_RELAY_MS)

  resumeActiveQueens(db)

  // Start clerk commentary engine
  startCommentaryEngine(db)
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
  stopCommentaryEngine()
  if (schedulerTimer) clearInterval(schedulerTimer)
  if (maintenanceTimer) clearInterval(maintenanceTimer)
  if (cloudMessageTimer) clearInterval(cloudMessageTimer)
  if (queenInboxTimer) clearInterval(queenInboxTimer)
  if (clerkAlertTimer) clearInterval(clerkAlertTimer)
  schedulerTimer = null
  maintenanceTimer = null
  cloudMessageTimer = null
  queenInboxTimer = null
  clerkAlertTimer = null
  cloudSyncInFlight = false
  queenInboxInFlight = false
  clerkAlertInFlight = false
  queenInboxRepollRequested = false
  clerkAlertRepollRequested = false

  for (const [, entry] of cronJobs) {
    entry.job.stop()
  }
  cronJobs.clear()
  pendingTaskStarts.clear()
}

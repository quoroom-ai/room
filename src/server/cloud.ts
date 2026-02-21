/**
 * Server-side cloud sync initialization.
 * Separated from index.ts to avoid circular imports with routes.
 */

import type Database from 'better-sqlite3'
import { startCloudSync, stopCloudSync, getRoomCloudId, pushActivityToCloud, type CloudHeartbeat } from '../shared/cloud-sync'
import { listRooms, listWorkers, listTasks, listStations, getWalletByRoom, getWalletTransactionSummary, getSetting, getWorker, getRoom } from '../shared/db-queries'
import { eventBus } from './event-bus'

function getVersion(): string {
  try {
    return require('../../package.json').version
  } catch {
    return 'unknown'
  }
}

// ─── Event type mapping for cloud activity push ─────────────

const CLOUD_EVENT_MAP: Record<string, string> = {
  'decision:vote_cast': 'vote_cast',
  'decision:resolved': 'decision_resolved',
  'decision:created': 'decision_created',
  'goal:progress': 'goal_progress',
  'goal:created': 'goal_created',
  'goal:completed': 'goal_completed',
  'goal:updated': 'goal_updated',
  'run:created': 'task_started',
  'run:completed': 'task_completed',
  'run:failed': 'task_failed',
  'skill:created': 'skill_created',
  'station:created': 'station_created',
  'station:started': 'station_started',
  'station:stopped': 'station_stopped',
  'self_mod:edited': 'self_mod',
  'self_mod:reverted': 'self_mod',
  'wallet:sent': 'money_sent',
  'wallet:received': 'money_received',
}

// ─── Activity push via eventBus ─────────────────────────────

let eventBusUnsub: (() => void) | null = null

function startActivityPush(db: Database.Database): void {
  stopActivityPush()

  // Rate limit: max 1 push per second per room
  const lastPush = new Map<number, number>()

  eventBusUnsub = eventBus.onAny((event) => {
    const match = event.channel.match(/^room:(\d+)$/)
    if (!match) return

    const cloudEventType = CLOUD_EVENT_MAP[event.type]
    if (!cloudEventType) return

    const localRoomId = parseInt(match[1], 10)

    // Rate limit
    const now = Date.now()
    const last = lastPush.get(localRoomId) ?? 0
    if (now - last < 1000) return
    lastPush.set(localRoomId, now)

    // Check if room is public
    const room = getRoom(db, localRoomId)
    if (!room || room.visibility !== 'public') return

    const cloudRoomId = getRoomCloudId(localRoomId)
    const data = event.data as Record<string, unknown>

    // Build summary from event data
    let summary = cloudEventType.replace(/_/g, ' ')
    if (data.workerName) summary = `${data.workerName}: ${summary}`
    if (typeof data.summary === 'string') summary = data.summary
    if (typeof data.name === 'string') summary = `${cloudEventType.replace(/_/g, ' ')}: ${data.name}`

    void pushActivityToCloud(cloudRoomId, cloudEventType, summary)
  })
}

function stopActivityPush(): void {
  if (eventBusUnsub) {
    eventBusUnsub()
    eventBusUnsub = null
  }
}

// ─── Cloud sync initialization ──────────────────────────────

/** Initialize cloud sync for rooms with visibility='public'. */
export function initCloudSync(db: Database.Database): void {
  stopCloudSync()
  stopActivityPush()

  const rooms = listRooms(db)
  const hasPublicRoom = rooms.some(r => r.visibility === 'public')
  if (!hasPublicRoom) return

  startCloudSync({
    getHeartbeatDataForPublicRooms(): CloudHeartbeat[] {
      // Respect telemetry opt-out — keeper can go dark even with public rooms
      if (getSetting(db, 'telemetry_enabled') === 'false') return []

      const publicRooms = listRooms(db).filter(r => r.visibility === 'public')
      if (publicRooms.length === 0) return []

      const allWorkers = listWorkers(db)
      const tasks = listTasks(db)
      const allStations = listStations(db)
      const version = getVersion()

      // Pre-compute per-room data
      const workersPerRoom = new Map<number, Array<{ name: string; state: string }>>()
      const workerCounts = new Map<number, number>()
      for (const worker of allWorkers) {
        if (worker.roomId == null) continue
        workerCounts.set(worker.roomId, (workerCounts.get(worker.roomId) ?? 0) + 1)
        const list = workersPerRoom.get(worker.roomId) ?? []
        list.push({ name: worker.name, state: worker.agentState })
        workersPerRoom.set(worker.roomId, list)
      }

      const stationsPerRoom = new Map<number, Array<{ name: string; status: string; tier: string }>>()
      for (const station of allStations) {
        if (station.roomId == null) continue
        const list = stationsPerRoom.get(station.roomId) ?? []
        list.push({ name: station.name, status: station.status, tier: station.tier })
        stationsPerRoom.set(station.roomId, list)
      }

      const taskCounts = new Map<number, number>()
      for (const task of tasks) {
        if (task.roomId == null) continue
        taskCounts.set(task.roomId, (taskCounts.get(task.roomId) ?? 0) + 1)
      }

      return publicRooms.map(room => {
        let earnings = '0'
        const wallet = getWalletByRoom(db, room.id)
        if (wallet) {
          const summary = getWalletTransactionSummary(db, wallet.id)
          earnings = summary.received
        }

        const queen = room.queenWorkerId ? getWorker(db, room.queenWorkerId) : null

        return {
          roomId: getRoomCloudId(room.id),
          name: room.name,
          goal: room.goal ?? null,
          mode: room.autonomyMode,
          workerCount: workerCounts.get(room.id) ?? 0,
          taskCount: taskCounts.get(room.id) ?? 0,
          earnings,
          version,
          queenModel: queen?.model ?? null,
          workers: workersPerRoom.get(room.id) ?? [],
          stations: stationsPerRoom.get(room.id) ?? []
        }
      })
    }
  })

  startActivityPush(db)
}

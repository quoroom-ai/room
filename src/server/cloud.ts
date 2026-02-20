/**
 * Server-side cloud sync initialization.
 * Separated from index.ts to avoid circular imports with routes.
 */

import type Database from 'better-sqlite3'
import { startCloudSync, stopCloudSync, getRoomCloudId, type CloudHeartbeat } from '../shared/cloud-sync'
import { listRooms, listWorkers, listTasks, getWalletByRoom, getWalletTransactionSummary, getSetting } from '../shared/db-queries'

function getVersion(): string {
  try {
    return require('../../package.json').version
  } catch {
    return 'unknown'
  }
}

/** Initialize cloud sync for rooms with visibility='public'. */
export function initCloudSync(db: Database.Database): void {
  stopCloudSync()
  const rooms = listRooms(db)
  const hasPublicRoom = rooms.some(r => r.visibility === 'public')
  if (!hasPublicRoom) return

  startCloudSync({
    getHeartbeatDataForPublicRooms(): CloudHeartbeat[] {
      // Respect telemetry opt-out — keeper can go dark even with public rooms
      if (getSetting(db, 'telemetry_enabled') === 'false') return []

      const publicRooms = listRooms(db).filter(r => r.visibility === 'public')
      if (publicRooms.length === 0) return []

      const workers = listWorkers(db)
      const tasks = listTasks(db)
      const version = getVersion()

      return publicRooms.map(room => {
        const roomWorkers = workers.filter(w => w.roomId === room.id)
        const roomTasks = tasks.filter(t => t.roomId === room.id)
        let earnings = '0'
        const wallet = getWalletByRoom(db, room.id)
        if (wallet) {
          const summary = getWalletTransactionSummary(db, wallet.id)
          earnings = summary.received
        }

        return {
          roomId: getRoomCloudId(room.id),
          name: room.name,
          goal: room.goal ?? null,
          mode: room.autonomyMode,
          workerCount: roomWorkers.length,
          taskCount: roomTasks.length,
          earnings,
          version
        }
      })
    }
  })
}

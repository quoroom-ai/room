/**
 * Server-side cloud sync initialization.
 * Separated from index.ts to avoid circular imports with routes.
 */

import type Database from 'better-sqlite3'
import { startCloudSync, stopCloudSync, getRoomId, type CloudHeartbeat } from '../shared/cloud-sync'
import { listRooms, listWorkers, listTasks, getWalletByRoom, getWalletTransactionSummary } from '../shared/db-queries'

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
  const publicRoom = rooms.find(r => r.visibility === 'public')
  if (!publicRoom) return
  const publicRoomId = publicRoom.id

  startCloudSync({
    getHeartbeatData(): CloudHeartbeat {
      const currentRoom = listRooms(db).find(r => r.id === publicRoomId) ?? publicRoom
      const workers = listWorkers(db)
      const tasks = listTasks(db)
      const version = getVersion()
      const roomWorkers = workers.filter(w => w.roomId === currentRoom.id)
      const roomTasks = tasks.filter(t => t.roomId === currentRoom.id)
      let earnings = '0'
      const wallet = getWalletByRoom(db, currentRoom.id)
      if (wallet) {
        const summary = getWalletTransactionSummary(db, wallet.id)
        earnings = summary.received
      }

      return {
        roomId: getRoomId(),
        name: currentRoom.name,
        goal: currentRoom.goal ?? null,
        mode: 'auto',
        workerCount: roomWorkers.length,
        taskCount: roomTasks.length,
        earnings,
        version
      }
    }
  })
}

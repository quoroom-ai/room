import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { initTestDb } from '../../shared/__tests__/helpers/test-db'
import { createRoom } from '../../shared/room'
import { isAgentRunning, isRoomLaunchEnabled, setRoomLaunchEnabled, _stopAllLoops } from '../../shared/agent-loop'

vi.mock('../clerk-commentary', () => ({
  startCommentaryEngine: vi.fn(),
  stopCommentaryEngine: vi.fn(),
}))

vi.mock('../routes/contacts', () => ({
  pollQueenInbox: vi.fn(async () => {}),
}))

vi.mock('../clerk-notifications', () => ({
  relayPendingKeeperRequests: vi.fn(async () => {}),
}))

vi.mock('../../shared/cloud-sync', () => ({
  ensureCloudRoomToken: vi.fn(async () => false),
  fetchCloudRoomMessages: vi.fn(async () => []),
  getRoomCloudId: vi.fn((roomId: number) => `cloud-${roomId}`),
  sendCloudRoomMessage: vi.fn(async () => true),
}))

vi.mock('../../shared/task-runner', () => ({
  executeTask: vi.fn(async () => ({ success: true })),
  isTaskRunning: vi.fn(() => false),
  cancelRunningTasksForRoom: vi.fn(() => 0),
}))

let db: Database.Database

beforeEach(() => {
  db = initTestDb()
})

afterEach(async () => {
  const { stopServerRuntime } = await import('../runtime')
  stopServerRuntime()
  _stopAllLoops()
  db.close()
})

describe('startServerRuntime', () => {
  it('does not auto-start queen loops and clears manual launch state', async () => {
    const roomResult = createRoom(db, { name: 'runtimecheck', goal: 'Test launch gating' })
    const roomId = roomResult.room.id
    const queenId = roomResult.queen.id

    setRoomLaunchEnabled(roomId, true)
    expect(isRoomLaunchEnabled(roomId)).toBe(true)
    expect(isAgentRunning(queenId)).toBe(false)

    const { startServerRuntime } = await import('../runtime')
    startServerRuntime(db)

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(isRoomLaunchEnabled(roomId)).toBe(false)
    expect(isAgentRunning(queenId)).toBe(false)
  })
})

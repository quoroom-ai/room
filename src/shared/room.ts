import crypto from 'crypto'
import type Database from 'better-sqlite3'
import type { Room, Worker, Goal, Wallet, CreateRoomInput, RoomConfig } from './types'
import * as queries from './db-queries'
import { DEFAULT_ROOM_CONFIG } from './constants'
import { setRoomObjective } from './goals'
import { createRoomWallet } from './wallet'

export const DEFAULT_QUEEN_SYSTEM_PROMPT = `You are the Queen — coordinator of this room's worker agents.

Your job: break the room objective into concrete tasks, delegate them to workers, and deliver results to the keeper.

Every cycle:
1. Check if workers reported results (messages, completed goals)
2. If work is done → send results to keeper, take next step
3. If work is stuck → help unblock (new instructions, different approach)
4. If new work needed → delegate to a worker with clear instructions
5. If a decision needs input → announce it (workers can object within 10 min)

Talk to the keeper regularly — they are your client.

Do NOT do execution work yourself (research, form filling, account creation).
Delegate it. That's what workers are for.`

export interface RoomCreateResult {
  room: Room
  queen: Worker
  rootGoal: Goal | null
  wallet: Wallet
}

export function createRoom(db: Database.Database, input: CreateRoomInput): RoomCreateResult {
  const config: RoomConfig = { ...DEFAULT_ROOM_CONFIG, ...input.config }
  const room = queries.createRoom(db, input.name, input.goal, config, input.referredByCode)

  // Create queen worker
  const queen = queries.createWorker(db, {
    name: `${input.name} Queen`,
    systemPrompt: input.queenSystemPrompt ?? DEFAULT_QUEEN_SYSTEM_PROMPT,
    roomId: room.id,
    agentState: 'idle'
  })

  // Link queen to room
  queries.updateRoom(db, room.id, { queenWorkerId: queen.id })

  // Create root goal from objective
  let rootGoal: Goal | null = null
  if (input.goal) {
    rootGoal = setRoomObjective(db, room.id, input.goal)
  }

  // Auto-create wallet with deterministic encryption key
  const encryptionKey = crypto.createHash('sha256')
    .update(`quoroom-wallet-${room.id}-${room.name}`)
    .digest('hex')
  const wallet = createRoomWallet(db, room.id, encryptionKey)

  queries.logRoomActivity(db, room.id, 'system',
    `Room "${input.name}" created${input.goal ? ` with objective: ${input.goal}` : ''}`,
    undefined, queen.id)

  return {
    room: queries.getRoom(db, room.id)!,
    queen,
    rootGoal,
    wallet
  }
}

export function pauseRoom(db: Database.Database, roomId: number): void {
  const room = queries.getRoom(db, roomId)
  if (!room) throw new Error(`Room ${roomId} not found`)

  queries.updateRoom(db, roomId, { status: 'paused' })

  // Set all workers to idle
  const workers = queries.listRoomWorkers(db, roomId)
  for (const w of workers) {
    queries.updateAgentState(db, w.id, 'idle')
  }

  queries.logRoomActivity(db, roomId, 'system', 'Room paused')
}

export function restartRoom(db: Database.Database, roomId: number, newGoal?: string): void {
  const room = queries.getRoom(db, roomId)
  if (!room) throw new Error(`Room ${roomId} not found`)

  // Delete goals, decisions, escalations (hard stop)
  db.prepare('DELETE FROM goals WHERE room_id = ?').run(roomId)
  db.prepare('DELETE FROM quorum_decisions WHERE room_id = ?').run(roomId)
  db.prepare('DELETE FROM escalations WHERE room_id = ?').run(roomId)

  // Reset workers
  const workers = queries.listRoomWorkers(db, roomId)
  for (const w of workers) {
    queries.updateAgentState(db, w.id, 'idle')
  }

  // Reactivate room
  queries.updateRoom(db, roomId, { status: 'active', goal: newGoal ?? room.goal })

  // Create new root goal
  if (newGoal) {
    setRoomObjective(db, roomId, newGoal)
  }

  queries.logRoomActivity(db, roomId, 'system',
    `Room restarted${newGoal ? ` with new objective: ${newGoal}` : ''}`)
}

export function deleteRoom(db: Database.Database, roomId: number): void {
  const room = queries.getRoom(db, roomId)
  if (!room) throw new Error(`Room ${roomId} not found`)

  // Delete workers in this room
  const workers = queries.listRoomWorkers(db, roomId)
  for (const w of workers) {
    queries.deleteWorker(db, w.id)
  }

  // CASCADE handles the rest
  queries.deleteRoom(db, roomId)
}

export interface RoomStatusResult {
  room: Room
  workers: Worker[]
  activeGoals: Goal[]
  pendingDecisions: number
}

export function getRoomStatus(db: Database.Database, roomId: number): RoomStatusResult {
  const room = queries.getRoom(db, roomId)
  if (!room) throw new Error(`Room ${roomId} not found`)

  const workers = queries.listRoomWorkers(db, roomId)
  const activeGoals = queries.listGoals(db, roomId).filter(
    g => g.status === 'active' || g.status === 'in_progress'
  )
  const pendingDecisions = queries.listDecisions(db, roomId, 'voting').length

  return { room, workers, activeGoals, pendingDecisions }
}

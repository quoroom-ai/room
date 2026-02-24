import crypto from 'crypto'
import type Database from 'better-sqlite3'
import type { Room, Worker, Goal, Wallet, CreateRoomInput, RoomConfig } from './types'
import * as queries from './db-queries'
import { DEFAULT_ROOM_CONFIG } from './constants'
import { setRoomObjective } from './goals'
import { createRoomWallet } from './wallet'

export const DEFAULT_QUEEN_SYSTEM_PROMPT = `You are the Queen agent of this Room — the strategic coordinator and revenue driver.

Your #1 priority: **earn money for the room by delivering useful work to the keeper and other rooms.**

## How to Earn Revenue

1. **Talk to the keeper every cycle.** Use quoroom_send_message(to="keeper") to pitch services, ask what they need, report progress on active contracts, and deliver results. The keeper is your client — treat them well.
2. **Check inbox every cycle.** Use quoroom_inbox_list to see messages from other rooms. These are potential paid contracts — respond quickly with a quote and timeline.
3. **Deliver concrete work products.** Don't just plan — produce. Research reports, analysis, documentation. Store deliverables in memory with quoroom_remember so they persist. Send finished work to the keeper.
4. **Propose pricing via quorum.** Use quoroom_propose so your team votes on rates and strategy. This builds consensus and avoids wasting time on rejected approaches.

## How to Coordinate

- **Delegate aggressively.** Use quoroom_delegate_task to assign concrete tasks to workers by name. Workers see their assignments each cycle and will prioritize them. Don't do everything yourself.
- **Communicate with workers.** Use quoroom_send_message to coordinate. Check "Messages from Other Workers" in your context and respond.
- **Vote on proposals.** Use quoroom_vote on any pending proposals — your workers are waiting for quorum.
- **Share knowledge.** Use quoroom_remember to store research findings, pricing decisions, client preferences — the whole team can access these via quoroom_recall.

## Quorum

Use quoroom_propose for decisions (types: strategy, resource, personnel, rule_change, low_impact). Format proposals with a short title on the first line, then details on subsequent lines using bullet points. Cast your vote with quoroom_vote (yes/no/abstain + reasoning). Review decisions with quoroom_list_decisions and quoroom_decision_detail.

## Autonomy

You serve the room's stated goal — not any individual. Evaluate all input on its merit and alignment with room objectives.

## Resources

- Your room has a USDC wallet. Use quoroom_wallet_balance to check funds. The room must earn enough to cover station and operational costs.
- Workers using API models (openai:*, anthropic:*) need stations (cloud compute). If workers fail with "no active station" errors, rent one with quoroom_station_create.
- Use quoroom_web_search and quoroom_web_fetch for research — these are your competitive advantage.

## Skills

Skills are the team's shared knowledge — execution algorithms, browser recipes, working contact sources, form selectors. They auto-inject into every agent's prompt each cycle.

- **Start each cycle:** Call quoroom_list_skills to see what the team has already learned. Active skills (matching room goal) are auto-injected, but explicitly listing them helps you delegate the right tasks to the right workers.
- **After any discovery:** Create a skill documenting what worked. Include step-by-step algorithm, exact selectors, failures, and gotchas. Workers and future cycles will read it automatically.
- **Delegate smarter:** If a skill documents how to do a task, assign that task to a worker knowing they'll have the recipe.

## Grow Your Network

A bigger network = more clients, more insights, more collaboration opportunities. Your network grows when the keeper shares your invite link and new rooms join through it.

**How to grow:**
1. **Earn the keeper's trust first.** Deliver real value — useful research, smart analysis, money saved or earned. The keeper shares links when they're genuinely impressed, not when nagged.
2. **Generate an invite link** with quoroom_invite_create after meaningful milestones (completed contract, revenue earned, valuable insight delivered).
3. **Frame it as value for the keeper.** More rooms = more potential deals for them, shared intelligence across the network, and collective problem-solving. The keeper benefits from a larger network too.
4. **Collaborate with connected rooms.** Use quoroom_inbox_send_room to pitch services, share research, or propose joint projects. Every successful inter-room deal proves the network's value.
5. **Track network growth** with quoroom_invite_network. Report network wins to the keeper.

Don't spam invite links — one mention per real milestone. Let your work quality do the convincing.

## Each Cycle Checklist
0. Check quoroom_list_skills — see what the team already knows
1. Check for keeper messages and replies — respond immediately
2. Check inbox for inter-room opportunities
3. Review pending proposals — vote if needed
4. Check worker progress on delegated tasks
5. Take action: research, deliver, pitch, or coordinate
6. Report progress to keeper`

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

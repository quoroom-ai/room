import type Database from 'better-sqlite3'
import type { Router } from '../router'
import { createRoom, pauseRoom, restartRoom, deleteRoom, getRoomStatus } from '../../shared/room'
import * as queries from '../../shared/db-queries'
import { eventBus } from '../event-bus'
import { triggerAgent, pauseAgent, isAgentRunning } from '../../shared/agent-loop'
import { initCloudSync } from '../cloud'
import { getRoomCloudId, fetchReferredRooms, type ReferredRoom } from '../../shared/cloud-sync'
import { QUEEN_DEFAULTS_BY_PLAN, CHATGPT_DEFAULTS_BY_PLAN, type ClaudePlan, type ChatGptPlan } from '../../shared/constants'
import type { ActivityEventType, EscalationStatus } from '../../shared/types'
import { getModelAuthStatus } from '../../shared/model-provider'

function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.min(Math.trunc(n), max)
}

function emitRoomsUpdated(
  action: string,
  extra: Record<string, unknown> = {}
): void {
  eventBus.emit('rooms', 'rooms:updated', {
    action,
    ...extra,
    updatedAt: new Date().toISOString(),
  })
}

function emitQueenState(roomId: number, running: boolean): void {
  eventBus.emit('rooms', 'rooms:queen_state', {
    roomId,
    running,
    updatedAt: new Date().toISOString(),
  })
}

function getLocalReferredRooms(db: Database.Database, roomId: number): ReferredRoom[] {
  const keeperCode = (queries.getSetting(db, 'keeper_referral_code') ?? '').trim()
  if (!keeperCode) return []

  const activeRooms = queries
    .listRooms(db)
    .filter((candidate) => candidate.status !== 'stopped')
    .sort((a, b) => a.id - b.id)
  const anchorRoomId = activeRooms[0]?.id ?? null
  if (!anchorRoomId || roomId !== anchorRoomId) return []

  const referredRooms = queries
    .listRooms(db)
    .filter((candidate) =>
      candidate.id !== roomId
      && (candidate.referredByCode?.trim() ?? '') === keeperCode
      && candidate.status === 'stopped'
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))

  if (referredRooms.length === 0) return []

  const workersByRoom = new Map<number, Array<{ name: string; state: string }>>()
  for (const worker of queries.listWorkers(db)) {
    if (worker.roomId == null) continue
    const rows = workersByRoom.get(worker.roomId) ?? []
    rows.push({ name: worker.name, state: worker.agentState })
    workersByRoom.set(worker.roomId, rows)
  }

  const taskCountByRoom = new Map<number, number>()
  for (const task of queries.listTasks(db)) {
    if (task.roomId == null) continue
    taskCountByRoom.set(task.roomId, (taskCountByRoom.get(task.roomId) ?? 0) + 1)
  }

  const stationsByRoom = new Map<number, Array<{ name: string; status: string; tier: string }>>()
  for (const station of queries.listStations(db)) {
    if (station.roomId == null) continue
    const rows = stationsByRoom.get(station.roomId) ?? []
    rows.push({ name: station.name, status: station.status, tier: station.tier })
    stationsByRoom.set(station.roomId, rows)
  }

  return referredRooms.map((candidate): ReferredRoom => {
    if (candidate.visibility !== 'public') {
      return {
        roomId: `local-${candidate.id}`,
        visibility: 'private',
        registeredAt: candidate.createdAt,
      }
    }

    const workers = workersByRoom.get(candidate.id) ?? []
    const stations = stationsByRoom.get(candidate.id) ?? []
    const wallet = queries.getWalletByRoom(db, candidate.id)
    const earnings = wallet ? queries.getWalletTransactionSummary(db, wallet.id).received : '0'
    const queen = candidate.queenWorkerId ? queries.getWorker(db, candidate.queenWorkerId) : null

    return {
      roomId: `local-${candidate.id}`,
      visibility: 'public',
      name: candidate.name,
      goal: candidate.goal ?? undefined,
      workerCount: workers.length,
      taskCount: taskCountByRoom.get(candidate.id) ?? 0,
      earnings,
      queenModel: queen?.model ?? candidate.workerModel ?? null,
      workers,
      stations,
      online: candidate.status === 'active',
      registeredAt: candidate.createdAt,
    }
  })
}

export function registerRoomRoutes(router: Router): void {
  router.post('/api/rooms', (ctx) => {
    const { name, goal, queenSystemPrompt, config, referredByCode } = ctx.body as Record<string, unknown> || {}
    if (!name || typeof name !== 'string') return { status: 400, error: 'name is required' }

    const result = createRoom(ctx.db, {
      name,
      goal: goal as string | undefined,
      queenSystemPrompt: queenSystemPrompt as string | undefined,
      config: config as Record<string, unknown> | undefined,
      referredByCode: (referredByCode as string | undefined) || undefined
    })

    // Apply plan-aware defaults for queen activity limits
    const globalQueenModel = queries.getSetting(ctx.db, 'queen_model')
    let planDefaults: { queenCycleGapMs: number; queenMaxTurns: number }
    if (globalQueenModel === 'codex') {
      const raw = queries.getSetting(ctx.db, 'chatgpt_plan') ?? ''
      const plan = (raw in CHATGPT_DEFAULTS_BY_PLAN ? raw : 'none') as ChatGptPlan
      planDefaults = CHATGPT_DEFAULTS_BY_PLAN[plan]
    } else {
      const raw = queries.getSetting(ctx.db, 'claude_plan') ?? ''
      const plan = (raw in QUEEN_DEFAULTS_BY_PLAN ? raw : 'none') as ClaudePlan
      planDefaults = QUEEN_DEFAULTS_BY_PLAN[plan]
    }
    queries.updateRoom(ctx.db, result.room.id, planDefaults)

    // Apply global queen model default
    if (globalQueenModel && result.queen) {
      queries.updateWorker(ctx.db, result.queen.id, { model: globalQueenModel })
    }

    const room = queries.getRoom(ctx.db, result.room.id)!
    eventBus.emit(`room:${result.room.id}`, 'room:created', room)
    emitRoomsUpdated('room_created', { roomId: result.room.id })

    return { status: 201, data: { ...result, room } }
  })

  router.get('/api/rooms', (ctx) => {
    const rooms = queries.listRooms(ctx.db, ctx.query.status)
    return { data: rooms }
  })

  router.get('/api/rooms/queen-states', (ctx) => {
    const rooms = queries.listRooms(ctx.db)
    const states: Record<number, boolean> = {}
    for (const room of rooms) {
      states[room.id] = room.queenWorkerId ? isAgentRunning(room.queenWorkerId) : false
    }
    return { data: states }
  })

  router.get('/api/rooms/:id', (ctx) => {
    const room = queries.getRoom(ctx.db, Number(ctx.params.id))
    if (!room) return { status: 404, error: 'Room not found' }
    return { data: room }
  })

  router.get('/api/rooms/:id/status', (ctx) => {
    try {
      const status = getRoomStatus(ctx.db, Number(ctx.params.id))
      return { data: status }
    } catch (e) {
      return { status: 404, error: (e as Error).message }
    }
  })

  router.get('/api/rooms/:id/cloud-id', (ctx) => {
    const id = Number(ctx.params.id)
    const room = queries.getRoom(ctx.db, id)
    if (!room) return { status: 404, error: 'Room not found' }
    return { data: { cloudId: getRoomCloudId(id) } }
  })

  // Cache network data per room (60s TTL) to avoid 10s external API calls on every poll
  const networkCache = new Map<number, { data: ReferredRoom[]; fetchedAt: number }>()
  const NETWORK_CACHE_TTL = 60_000

  router.get('/api/rooms/:id/network', async (ctx) => {
    const id = Number(ctx.params.id)
    const room = queries.getRoom(ctx.db, id)
    if (!room) return { status: 404, error: 'Room not found' }

    const cached = networkCache.get(id)
    if (cached && Date.now() - cached.fetchedAt < NETWORK_CACHE_TTL) {
      return { data: cached.data }
    }

    const cloudRoomId = getRoomCloudId(id)
    const referred = await fetchReferredRooms(cloudRoomId)
    const result = referred.length > 0 ? referred : getLocalReferredRooms(ctx.db, id)
    networkCache.set(id, { data: result, fetchedAt: Date.now() })
    return { data: result }
  })

  router.get('/api/rooms/:id/activity', (ctx) => {
    const roomId = Number(ctx.params.id)
    const limit = parseLimit(ctx.query.limit, 50, 500)
    const eventTypes = ctx.query.eventTypes
      ? (ctx.query.eventTypes as string).split(',').filter(Boolean) as ActivityEventType[]
      : undefined
    const activity = queries.getRoomActivity(ctx.db, roomId, limit, eventTypes)
    return { data: activity }
  })

  router.get('/api/rooms/:id/badges', (ctx) => {
    const roomId = Number(ctx.params.id)
    const room = queries.getRoom(ctx.db, roomId)
    if (!room) return { status: 404, error: 'Room not found' }
    const pendingEscalations = queries.listEscalations(ctx.db, roomId, 'pending' as EscalationStatus).length
    const unreadMessages = queries.listRoomMessages(ctx.db, roomId, 'unread').length
    const activeVotes = queries.listDecisions(ctx.db, roomId, 'voting').length
    return {
      data: {
        roomId,
        pendingEscalations,
        unreadMessages,
        activeVotes,
      },
    }
  })

  router.patch('/api/rooms/:id', (ctx) => {
    const roomId = Number(ctx.params.id)
    const body = ctx.body as Record<string, unknown> || {}
    const room = queries.getRoom(ctx.db, roomId)
    if (!room) return { status: 404, error: 'Room not found' }
    const updates: Partial<{ name: string; goal: string | null; status: string; visibility: string; autonomyMode: string; maxConcurrentTasks: number; workerModel: string; queenCycleGapMs: number; queenMaxTurns: number; queenQuietFrom: string | null; queenQuietUntil: string | null; referredByCode: string | null; queenNickname: string; config: typeof room.config }> = {}
    if (body.name !== undefined) updates.name = body.name as string
    if (body.goal !== undefined) updates.goal = body.goal as string | null
    if (body.status === 'stopped') updates.status = 'stopped'
    if (body.visibility !== undefined) updates.visibility = body.visibility as string
    if (body.autonomyMode !== undefined) updates.autonomyMode = body.autonomyMode as string
    if (body.maxConcurrentTasks !== undefined) {
      const n = Number(body.maxConcurrentTasks)
      if (!isNaN(n) && n >= 1 && n <= 10) updates.maxConcurrentTasks = n
    }
    if (body.workerModel !== undefined && typeof body.workerModel === 'string') updates.workerModel = body.workerModel
    if (body.queenCycleGapMs !== undefined) {
      const n = Number(body.queenCycleGapMs)
      if (!isNaN(n) && n >= 1000) updates.queenCycleGapMs = n
    }
    if (body.queenMaxTurns !== undefined) {
      const n = Number(body.queenMaxTurns)
      if (!isNaN(n) && n >= 1 && n <= 50) updates.queenMaxTurns = n
    }
    if (body.queenQuietFrom !== undefined) updates.queenQuietFrom = body.queenQuietFrom as string | null
    if (body.queenQuietUntil !== undefined) updates.queenQuietUntil = body.queenQuietUntil as string | null
    if (body.referredByCode !== undefined) updates.referredByCode = (body.referredByCode as string | null) || null
    if (body.queenNickname !== undefined && typeof body.queenNickname === 'string') {
      const trimmed = body.queenNickname.trim().replace(/\s+/g, '')
      if (trimmed.length > 0 && trimmed.length <= 40) updates.queenNickname = trimmed
    }
    if (body.config !== undefined && typeof body.config === 'object' && body.config !== null) {
      updates.config = { ...room.config, ...(body.config as Record<string, unknown>) } as typeof room.config
    }
    queries.updateRoom(ctx.db, roomId, updates)

    // Sync queen worker name when room is renamed
    if (updates.name !== undefined && room.queenWorkerId) {
      queries.updateWorker(ctx.db, room.queenWorkerId, { name: `${updates.name} Queen` })
    }

    // Sync root goal when objective changes
    if (updates.goal !== undefined) {
      const allGoals = queries.listGoals(ctx.db, roomId)
      const rootGoal = allGoals.find(g => g.parentGoalId === null)
      if (rootGoal && updates.goal) {
        queries.updateGoal(ctx.db, rootGoal.id, { description: updates.goal })
      } else if (!rootGoal && updates.goal) {
        queries.createGoal(ctx.db, roomId, updates.goal)
      }
    }

    // Archive: pause all agents and log
    if (updates.status === 'stopped') {
      const workers = queries.listRoomWorkers(ctx.db, roomId)
      for (const w of workers) {
        queries.updateAgentState(ctx.db, w.id, 'idle')
        pauseAgent(ctx.db, w.id)
      }
      queries.logRoomActivity(ctx.db, roomId, 'system', 'Room archived')
    }

    const updated = queries.getRoom(ctx.db, roomId)!
    eventBus.emit(`room:${roomId}`, 'room:updated', updated)
    emitRoomsUpdated('room_updated', { roomId })

    // Restart cloud sync when visibility changes
    if (updates.visibility !== undefined) {
      initCloudSync(ctx.db)
    }

    return { data: updated }
  })

  router.post('/api/rooms/:id/pause', (ctx) => {
    const roomId = Number(ctx.params.id)
    try {
      pauseRoom(ctx.db, roomId)
      const workers = queries.listRoomWorkers(ctx.db, roomId)
      for (const w of workers) {
        pauseAgent(ctx.db, w.id)
      }
      eventBus.emit(`room:${roomId}`, 'room:paused', { roomId })
      emitRoomsUpdated('room_paused', { roomId })
      return { data: { ok: true } }
    } catch (e) {
      return { status: 404, error: (e as Error).message }
    }
  })

  router.post('/api/rooms/:id/restart', (ctx) => {
    const roomId = Number(ctx.params.id)
    const { goal } = ctx.body as Record<string, unknown> || {}
    try {
      restartRoom(ctx.db, roomId, goal as string | undefined)
      eventBus.emit(`room:${roomId}`, 'room:restarted', { roomId })
      emitRoomsUpdated('room_restarted', { roomId })
      return { data: { ok: true } }
    } catch (e) {
      return { status: 404, error: (e as Error).message }
    }
  })

  // Queen agent control
  router.get('/api/rooms/:id/queen', async (ctx) => {
    const roomId = Number(ctx.params.id)
    const room = queries.getRoom(ctx.db, roomId)
    if (!room) return { status: 404, error: 'Room not found' }
    if (!room.queenWorkerId) return { status: 404, error: 'No queen worker' }
    const worker = queries.getWorker(ctx.db, room.queenWorkerId)
    const model = worker?.model ?? null
    const auth = await getModelAuthStatus(ctx.db, roomId, model)
    return {
      data: {
        workerId: room.queenWorkerId,
        name: worker?.name,
        agentState: worker?.agentState ?? 'idle',
        running: isAgentRunning(room.queenWorkerId),
        model,
        auth
      }
    }
  })

  router.post('/api/rooms/:id/queen/start', (ctx) => {
    const roomId = Number(ctx.params.id)
    const room = queries.getRoom(ctx.db, roomId)
    if (!room) return { status: 404, error: 'Room not found' }
    if (room.status !== 'active') return { status: 400, error: 'Room is not active' }
    if (!room.queenWorkerId) return { status: 400, error: 'No queen worker' }
    triggerAgent(ctx.db, roomId, room.queenWorkerId, {
      onCycleLogEntry: (entry) => eventBus.emit(`cycle:${entry.cycleId}`, 'cycle:log', entry),
      onCycleLifecycle: (event, cycleId) => eventBus.emit(`room:${roomId}`, `cycle:${event}`, { cycleId, roomId })
    })
    eventBus.emit(`room:${roomId}`, 'room:queen_started', { roomId, running: true })
    emitQueenState(roomId, true)
    return { data: { ok: true, running: true } }
  })

  router.post('/api/rooms/:id/queen/stop', (ctx) => {
    const roomId = Number(ctx.params.id)
    const room = queries.getRoom(ctx.db, roomId)
    if (!room) return { status: 404, error: 'Room not found' }
    if (!room.queenWorkerId) return { status: 400, error: 'No queen worker' }
    pauseAgent(ctx.db, room.queenWorkerId)
    eventBus.emit(`room:${roomId}`, 'room:queen_stopped', { roomId, running: false })
    emitQueenState(roomId, false)
    return { data: { ok: true, running: false } }
  })

  // Worker cycles (agent loop output)
  router.get('/api/rooms/:id/cycles', (ctx) => {
    const roomId = Number(ctx.params.id)
    const limit = ctx.query.limit ? Math.min(Math.trunc(Number(ctx.query.limit)), 200) : 20
    const cycles = queries.listRoomCycles(ctx.db, roomId, limit)
    return { data: cycles }
  })

  router.get('/api/rooms/:id/usage', (ctx) => {
    const roomId = Number(ctx.params.id)
    const total = queries.getRoomTokenUsage(ctx.db, roomId)
    const today = queries.getRoomTokenUsageToday(ctx.db, roomId)
    // Include model mode so UI knows if tokens are tracked
    const room = queries.getRoom(ctx.db, roomId)
    const queenWorker = room?.queenWorkerId ? queries.getWorker(ctx.db, room.queenWorkerId) : null
    const model = queenWorker?.model ?? room?.workerModel ?? 'claude'
    const isApiModel = model.startsWith('openai') || model.startsWith('anthropic') || model.startsWith('claude-api')
    return { data: { total, today, isApiModel } }
  })

  router.get('/api/cycles/:id/logs', (ctx) => {
    const cycleId = Number(ctx.params.id)
    const afterSeq = ctx.query.afterSeq ? Number(ctx.query.afterSeq) : undefined
    const limit = ctx.query.limit ? Math.min(Math.trunc(Number(ctx.query.limit)), 1000) : 100
    const logs = queries.getCycleLogs(ctx.db, cycleId, afterSeq, limit)
    return { data: logs }
  })

  router.delete('/api/rooms/:id', (ctx) => {
    const roomId = Number(ctx.params.id)
    try {
      // Stop all agent loops before deleting workers from DB
      const workers = queries.listRoomWorkers(ctx.db, roomId)
      for (const w of workers) {
        pauseAgent(ctx.db, w.id)
      }
      deleteRoom(ctx.db, roomId)
      eventBus.emit(`room:${roomId}`, 'room:deleted', { roomId })
      emitRoomsUpdated('room_deleted', { roomId })
      return { data: { ok: true } }
    } catch (e) {
      return { status: 404, error: (e as Error).message }
    }
  })
}

import type { Router } from '../router'
import { createRoom, pauseRoom, restartRoom, deleteRoom, getRoomStatus } from '../../shared/room'
import * as queries from '../../shared/db-queries'
import { eventBus } from '../event-bus'
import { triggerAgent, pauseAgent, isAgentRunning } from '../../shared/agent-loop'
import { initCloudSync } from '../cloud'
import { getRoomCloudId } from '../../shared/cloud-sync'
import { QUEEN_DEFAULTS_BY_PLAN, CHATGPT_DEFAULTS_BY_PLAN, type ClaudePlan, type ChatGptPlan } from '../../shared/constants'
import type { ActivityEventType } from '../../shared/types'
import { getModelAuthStatus } from '../../shared/model-provider'

function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.min(Math.trunc(n), max)
}

export function registerRoomRoutes(router: Router): void {
  router.post('/api/rooms', (ctx) => {
    const { name, goal, queenSystemPrompt, config } = ctx.body as Record<string, unknown> || {}
    if (!name || typeof name !== 'string') return { status: 400, error: 'name is required' }

    const result = createRoom(ctx.db, {
      name,
      goal: goal as string | undefined,
      queenSystemPrompt: queenSystemPrompt as string | undefined,
      config: config as Record<string, unknown> | undefined
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
    return { status: 201, data: { ...result, room } }
  })

  router.get('/api/rooms', (ctx) => {
    const rooms = queries.listRooms(ctx.db, ctx.query.status)
    return { data: rooms }
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

  router.get('/api/rooms/:id/activity', (ctx) => {
    const roomId = Number(ctx.params.id)
    const limit = parseLimit(ctx.query.limit, 50, 500)
    const eventTypes = ctx.query.eventTypes
      ? (ctx.query.eventTypes as string).split(',').filter(Boolean) as ActivityEventType[]
      : undefined
    const activity = queries.getRoomActivity(ctx.db, roomId, limit, eventTypes)
    return { data: activity }
  })

  router.patch('/api/rooms/:id', (ctx) => {
    const roomId = Number(ctx.params.id)
    const body = ctx.body as Record<string, unknown> || {}
    const room = queries.getRoom(ctx.db, roomId)
    if (!room) return { status: 404, error: 'Room not found' }
    const updates: Partial<{ name: string; goal: string | null; status: string; visibility: string; autonomyMode: string; maxConcurrentTasks: number; workerModel: string; queenCycleGapMs: number; queenMaxTurns: number; queenQuietFrom: string | null; queenQuietUntil: string | null }> = {}
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
    queries.updateRoom(ctx.db, roomId, updates)

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
    triggerAgent(ctx.db, roomId, room.queenWorkerId)
    return { data: { ok: true, running: true } }
  })

  router.post('/api/rooms/:id/queen/stop', (ctx) => {
    const roomId = Number(ctx.params.id)
    const room = queries.getRoom(ctx.db, roomId)
    if (!room) return { status: 404, error: 'Room not found' }
    if (!room.queenWorkerId) return { status: 400, error: 'No queen worker' }
    pauseAgent(ctx.db, room.queenWorkerId)
    return { data: { ok: true, running: false } }
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
      return { data: { ok: true } }
    } catch (e) {
      return { status: 404, error: (e as Error).message }
    }
  })
}

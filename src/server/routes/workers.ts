import type { Router } from '../router'
import type { AgentState } from '../../shared/types'
import * as queries from '../../shared/db-queries'
import { eventBus } from '../event-bus'
import { triggerAgent, pauseAgent, isRoomLaunchEnabled } from '../../shared/agent-loop'

export function registerWorkerRoutes(router: Router): void {
  router.post('/api/workers', (ctx) => {
    const body = ctx.body as Record<string, unknown> || {}
    if (!body.name || typeof body.name !== 'string') return { status: 400, error: 'name is required' }
    if (!body.systemPrompt || typeof body.systemPrompt !== 'string') return { status: 400, error: 'systemPrompt is required' }

    const worker = queries.createWorker(ctx.db, {
      name: body.name,
      systemPrompt: body.systemPrompt,
      description: body.description as string | undefined,
      role: body.role as string | undefined,
      isDefault: body.isDefault as boolean | undefined,
      cycleGapMs: body.cycleGapMs != null ? Number(body.cycleGapMs) : undefined,
      maxTurns: body.maxTurns != null ? Number(body.maxTurns) : undefined,
      roomId: body.roomId as number | undefined,
      agentState: body.agentState as AgentState | undefined
    })
    eventBus.emit('workers', 'worker:created', worker)
    return { status: 201, data: worker }
  })

  router.get('/api/workers', (ctx) => {
    const workers = queries.listWorkers(ctx.db)
    return { data: workers }
  })

  router.get('/api/workers/:id', (ctx) => {
    const worker = queries.getWorker(ctx.db, Number(ctx.params.id))
    if (!worker) return { status: 404, error: 'Worker not found' }
    return { data: worker }
  })

  router.patch('/api/workers/:id', (ctx) => {
    const id = Number(ctx.params.id)
    const worker = queries.getWorker(ctx.db, id)
    if (!worker) return { status: 404, error: 'Worker not found' }

    const body = ctx.body as Record<string, unknown> || {}
    queries.updateWorker(ctx.db, id, body)
    const updated = queries.getWorker(ctx.db, id)
    eventBus.emit('workers', 'worker:updated', updated)
    return { data: updated }
  })

  router.delete('/api/workers/:id', (ctx) => {
    const id = Number(ctx.params.id)
    const worker = queries.getWorker(ctx.db, id)
    if (!worker) return { status: 404, error: 'Worker not found' }

    queries.deleteWorker(ctx.db, id)
    eventBus.emit('workers', 'worker:deleted', { id })
    return { data: { ok: true } }
  })

  router.post('/api/workers/:id/start', (ctx) => {
    const id = Number(ctx.params.id)
    const worker = queries.getWorker(ctx.db, id)
    if (!worker) return { status: 404, error: 'Worker not found' }
    if (!worker.roomId) return { status: 400, error: 'Worker has no room' }
    const room = queries.getRoom(ctx.db, worker.roomId)
    if (!room) return { status: 404, error: 'Room not found' }
    if (room.status !== 'active') return { status: 400, error: 'Room is not active' }
    if (!isRoomLaunchEnabled(worker.roomId)) {
      return { status: 409, error: 'Room runtime is not started. Start the room first.' }
    }
    triggerAgent(ctx.db, worker.roomId, id, {
      onCycleLogEntry: (entry) => eventBus.emit(`cycle:${entry.cycleId}`, 'cycle:log', entry),
      onCycleLifecycle: (event, cycleId) => eventBus.emit(`room:${worker.roomId}`, `cycle:${event}`, { cycleId, roomId: worker.roomId })
    })
    eventBus.emit('workers', 'worker:started', { id, roomId: worker.roomId })
    return { data: { ok: true, running: true } }
  })

  router.post('/api/workers/:id/stop', (ctx) => {
    const id = Number(ctx.params.id)
    const worker = queries.getWorker(ctx.db, id)
    if (!worker) return { status: 404, error: 'Worker not found' }
    pauseAgent(ctx.db, id)
    eventBus.emit('workers', 'worker:stopped', { id })
    return { data: { ok: true, running: false } }
  })

  router.get('/api/rooms/:roomId/workers', (ctx) => {
    const workers = queries.listRoomWorkers(ctx.db, Number(ctx.params.roomId))
    return { data: workers }
  })
}

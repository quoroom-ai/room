import type { Router } from '../router'
import type { AgentState } from '../../shared/types'
import * as queries from '../../shared/db-queries'
import { eventBus } from '../event-bus'

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

  router.get('/api/rooms/:roomId/workers', (ctx) => {
    const workers = queries.listRoomWorkers(ctx.db, Number(ctx.params.roomId))
    return { data: workers }
  })
}

import type { Router } from '../router'
import * as queries from '../../shared/db-queries'
import { eventBus } from '../event-bus'
import { triggerAgent } from '../../shared/agent-loop'

export function registerEscalationRoutes(router: Router): void {
  router.post('/api/rooms/:roomId/escalations', (ctx) => {
    const roomId = Number(ctx.params.roomId)
    const body = ctx.body as Record<string, unknown> || {}
    const fromAgentId = body.fromAgentId != null ? Number(body.fromAgentId) : null
    if (body.fromAgentId != null && (typeof body.fromAgentId !== 'number' || isNaN(fromAgentId!))) {
      return { status: 400, error: 'fromAgentId must be a number if provided' }
    }
    if (!body.question || typeof body.question !== 'string') {
      return { status: 400, error: 'question is required' }
    }

    const escalation = queries.createEscalation(ctx.db, roomId,
      fromAgentId,
      body.question,
      body.toAgentId as number | undefined)
    eventBus.emit(`room:${roomId}`, 'escalation:created', escalation)
    return { status: 201, data: escalation }
  })

  router.get('/api/rooms/:roomId/escalations', (ctx) => {
    const roomId = Number(ctx.params.roomId)
    const toAgentId = ctx.query.toAgentId ? Number(ctx.query.toAgentId) : undefined

    // Agent loop use case: toAgentId implies pending-only with NULL-fallback semantics
    if (toAgentId != null) {
      return { data: queries.getPendingEscalations(ctx.db, roomId, toAgentId) }
    }

    // UI use case: return all (or filtered by status)
    const status = ctx.query.status as string | undefined
    return { data: queries.listEscalations(ctx.db, roomId, status as any) }
  })

  router.post('/api/escalations/:id/resolve', (ctx) => {
    const id = Number(ctx.params.id)
    const escalation = queries.getEscalation(ctx.db, id)
    if (!escalation) return { status: 404, error: 'Escalation not found' }

    const body = ctx.body as Record<string, unknown> || {}
    if (!body.answer || typeof body.answer !== 'string') {
      return { status: 400, error: 'answer is required' }
    }

    queries.resolveEscalation(ctx.db, id, body.answer)
    const updated = queries.getEscalation(ctx.db, id)
    eventBus.emit(`room:${escalation.roomId}`, 'escalation:resolved', updated)

    // Wake the agent who sent the message so they see the reply
    if (escalation.fromAgentId) {
      triggerAgent(ctx.db, escalation.roomId, escalation.fromAgentId)
    }
    // Also wake the queen if it wasn't the sender
    const room = queries.getRoom(ctx.db, escalation.roomId)
    if (room?.queenWorkerId && room.queenWorkerId !== escalation.fromAgentId) {
      triggerAgent(ctx.db, escalation.roomId, room.queenWorkerId)
    }

    return { data: updated }
  })
}

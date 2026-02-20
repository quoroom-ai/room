import type { Router } from '../router'
import type { DecisionType, DecisionStatus, VoteValue } from '../../shared/types'
import * as queries from '../../shared/db-queries'
import { eventBus } from '../event-bus'

export function registerDecisionRoutes(router: Router): void {
  router.post('/api/rooms/:roomId/decisions', (ctx) => {
    const roomId = Number(ctx.params.roomId)
    const body = ctx.body as Record<string, unknown> || {}
    if (!body.proposerId || typeof body.proposerId !== 'number') {
      return { status: 400, error: 'proposerId is required' }
    }
    if (!body.proposal || typeof body.proposal !== 'string') {
      return { status: 400, error: 'proposal is required' }
    }
    if (!body.decisionType || typeof body.decisionType !== 'string') {
      return { status: 400, error: 'decisionType is required' }
    }

    const decision = queries.createDecision(ctx.db, roomId,
      body.proposerId,
      body.proposal,
      body.decisionType as DecisionType,
      body.threshold as string | undefined,
      body.timeoutAt as string | undefined)
    eventBus.emit(`room:${roomId}`, 'decision:created', decision)
    return { status: 201, data: decision }
  })

  router.get('/api/rooms/:roomId/decisions', (ctx) => {
    const roomId = Number(ctx.params.roomId)
    const decisions = queries.listDecisions(ctx.db, roomId, ctx.query.status as DecisionStatus | undefined)
    return { data: decisions }
  })

  router.get('/api/decisions/:id', (ctx) => {
    const decision = queries.getDecision(ctx.db, Number(ctx.params.id))
    if (!decision) return { status: 404, error: 'Decision not found' }
    return { data: decision }
  })

  router.post('/api/decisions/:id/resolve', (ctx) => {
    const id = Number(ctx.params.id)
    const decision = queries.getDecision(ctx.db, id)
    if (!decision) return { status: 404, error: 'Decision not found' }

    const body = ctx.body as Record<string, unknown> || {}
    if (!body.status || typeof body.status !== 'string') {
      return { status: 400, error: 'status is required (approved/rejected)' }
    }

    queries.resolveDecision(ctx.db, id, body.status as DecisionStatus, body.result as string | undefined)
    const updated = queries.getDecision(ctx.db, id)!
    eventBus.emit(`room:${decision.roomId}`, 'decision:resolved', updated)
    return { data: updated }
  })

  router.post('/api/decisions/:id/vote', (ctx) => {
    const id = Number(ctx.params.id)
    const decision = queries.getDecision(ctx.db, id)
    if (!decision) return { status: 404, error: 'Decision not found' }

    const body = ctx.body as Record<string, unknown> || {}
    if (!body.workerId || typeof body.workerId !== 'number') {
      return { status: 400, error: 'workerId is required' }
    }
    if (!body.vote || typeof body.vote !== 'string') {
      return { status: 400, error: 'vote is required (yes/no/abstain)' }
    }

    const vote = queries.castVote(ctx.db, id, body.workerId, body.vote as VoteValue, body.reasoning as string | undefined)
    eventBus.emit(`room:${decision.roomId}`, 'decision:vote_cast', vote)
    return { status: 201, data: vote }
  })

  router.get('/api/decisions/:id/votes', (ctx) => {
    const votes = queries.getVotes(ctx.db, Number(ctx.params.id))
    return { data: votes }
  })
}

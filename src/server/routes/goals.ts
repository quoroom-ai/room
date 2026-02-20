import type { Router } from '../router'
import type { GoalStatus } from '../../shared/types'
import * as queries from '../../shared/db-queries'
import { eventBus } from '../event-bus'

export function registerGoalRoutes(router: Router): void {
  router.post('/api/rooms/:roomId/goals', (ctx) => {
    const roomId = Number(ctx.params.roomId)
    const body = ctx.body as Record<string, unknown> || {}
    if (!body.description || typeof body.description !== 'string') {
      return { status: 400, error: 'description is required' }
    }

    const goal = queries.createGoal(ctx.db, roomId, body.description,
      body.parentGoalId as number | undefined,
      body.assignedWorkerId as number | undefined)
    eventBus.emit(`room:${roomId}`, 'goal:created', goal)
    return { status: 201, data: goal }
  })

  router.get('/api/rooms/:roomId/goals', (ctx) => {
    const roomId = Number(ctx.params.roomId)
    const goals = queries.listGoals(ctx.db, roomId, ctx.query.status as GoalStatus | undefined)
    return { data: goals }
  })

  router.get('/api/goals/:id', (ctx) => {
    const goal = queries.getGoal(ctx.db, Number(ctx.params.id))
    if (!goal) return { status: 404, error: 'Goal not found' }
    return { data: goal }
  })

  router.get('/api/goals/:id/subgoals', (ctx) => {
    const subgoals = queries.getSubGoals(ctx.db, Number(ctx.params.id))
    return { data: subgoals }
  })

  router.patch('/api/goals/:id', (ctx) => {
    const id = Number(ctx.params.id)
    const goal = queries.getGoal(ctx.db, id)
    if (!goal) return { status: 404, error: 'Goal not found' }

    const body = ctx.body as Record<string, unknown> || {}
    queries.updateGoal(ctx.db, id, body)
    const updated = queries.getGoal(ctx.db, id)!
    eventBus.emit(`room:${goal.roomId}`, 'goal:updated', updated)
    return { data: updated }
  })

  router.delete('/api/goals/:id', (ctx) => {
    const id = Number(ctx.params.id)
    const goal = queries.getGoal(ctx.db, id)
    if (!goal) return { status: 404, error: 'Goal not found' }

    queries.deleteGoal(ctx.db, id)
    eventBus.emit(`room:${goal.roomId}`, 'goal:deleted', { id })
    return { data: { ok: true } }
  })

  router.post('/api/goals/:id/updates', (ctx) => {
    const id = Number(ctx.params.id)
    const goal = queries.getGoal(ctx.db, id)
    if (!goal) return { status: 404, error: 'Goal not found' }

    const body = ctx.body as Record<string, unknown> || {}
    if (!body.observation || typeof body.observation !== 'string') {
      return { status: 400, error: 'observation is required' }
    }

    const update = queries.logGoalUpdate(ctx.db, id,
      body.observation,
      body.metricValue as number | undefined,
      body.workerId as number | undefined)
    eventBus.emit(`room:${goal.roomId}`, 'goal:progress', {
      goalId: id,
      update
    })
    return { status: 201, data: update }
  })

  router.get('/api/goals/:id/updates', (ctx) => {
    const limit = ctx.query.limit ? Number(ctx.query.limit) : undefined
    const updates = queries.getGoalUpdates(ctx.db, Number(ctx.params.id), limit)
    return { data: updates }
  })
}

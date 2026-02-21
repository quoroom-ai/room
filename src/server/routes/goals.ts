import type { Router } from '../router'
import type { GoalStatus } from '../../shared/types'
import * as queries from '../../shared/db-queries'
import { eventBus } from '../event-bus'
import { decomposeGoal, updateGoalProgress, completeGoal, abandonGoal } from '../../shared/goals'

const GOAL_STATUS_VALUES: GoalStatus[] = ['active', 'in_progress', 'completed', 'abandoned', 'blocked']

export function registerGoalRoutes(router: Router): void {
  router.post('/api/rooms/:roomId/goals', (ctx) => {
    const roomId = Number(ctx.params.roomId)
    const body = ctx.body as Record<string, unknown> || {}
    if (!body.description || typeof body.description !== 'string') {
      return { status: 400, error: 'description is required' }
    }

    try {
      const parentGoalId = body.parentGoalId as number | undefined
      const assignedWorkerId = body.assignedWorkerId as number | undefined
      let goal

      if (parentGoalId != null) {
        const parent = queries.getGoal(ctx.db, parentGoalId)
        if (!parent || parent.roomId !== roomId) {
          return { status: 400, error: `Parent goal ${parentGoalId} not found in room ${roomId}` }
        }
        goal = decomposeGoal(ctx.db, parentGoalId, [body.description])[0]
        if (assignedWorkerId != null) {
          queries.updateGoal(ctx.db, goal.id, { assignedWorkerId })
          goal = queries.getGoal(ctx.db, goal.id)!
        }
      } else {
        goal = queries.createGoal(ctx.db, roomId, body.description, undefined, assignedWorkerId)
      }

      eventBus.emit(`room:${roomId}`, 'goal:created', goal)
      return { status: 201, data: goal }
    } catch (e) {
      return { status: 400, error: (e as Error).message }
    }
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
    const updates: Partial<{
      description: string
      assignedWorkerId: number | null
    }> = {}

    if (body.description !== undefined) {
      if (typeof body.description !== 'string' || !body.description.trim()) {
        return { status: 400, error: 'description must be a non-empty string' }
      }
      updates.description = body.description
    }
    if (body.assignedWorkerId !== undefined) {
      updates.assignedWorkerId = body.assignedWorkerId as number | null
    }

    if (Object.keys(updates).length > 0) {
      queries.updateGoal(ctx.db, id, updates)
    }

    if (body.progress !== undefined) {
      const progressRaw = Number(body.progress)
      if (!Number.isFinite(progressRaw)) {
        return { status: 400, error: 'progress must be a number' }
      }
      updateGoalProgress(
        ctx.db,
        id,
        'Manual progress update',
        progressRaw,
        body.workerId as number | undefined
      )
    }

    if (body.status !== undefined) {
      const status = body.status as GoalStatus
      if (!GOAL_STATUS_VALUES.includes(status)) {
        return { status: 400, error: 'status is invalid' }
      }
      if (status === 'completed') {
        completeGoal(ctx.db, id)
      } else if (status === 'abandoned') {
        const reason = typeof body.reason === 'string' && body.reason.trim()
          ? body.reason
          : 'Manual status change'
        abandonGoal(ctx.db, id, reason)
      } else {
        queries.updateGoal(ctx.db, id, { status })
      }
    }

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

    const update = updateGoalProgress(
      ctx.db,
      id,
      body.observation,
      body.metricValue as number | undefined,
      body.workerId as number | undefined
    )
    const updatedGoal = queries.getGoal(ctx.db, id)
    eventBus.emit(`room:${goal.roomId}`, 'goal:progress', {
      goalId: id,
      update,
      goal: updatedGoal
    })
    return { status: 201, data: update }
  })

  router.get('/api/goals/:id/updates', (ctx) => {
    const limit = ctx.query.limit ? Number(ctx.query.limit) : undefined
    const updates = queries.getGoalUpdates(ctx.db, Number(ctx.params.id), limit)
    return { data: updates }
  })
}

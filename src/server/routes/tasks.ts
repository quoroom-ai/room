import type { Router } from '../router'
import type { Task, TriggerType } from '../../shared/types'
import * as queries from '../../shared/db-queries'
import { eventBus } from '../event-bus'
import { runTaskNow } from '../runtime'

function toTaskListItem(task: Task): Task {
  const prompt = task.prompt.length > 500 ? `${task.prompt.slice(0, 500)}...` : task.prompt
  return {
    ...task,
    prompt,
    lastResult: null,
    learnedContext: null,
  }
}

export function registerTaskRoutes(router: Router): void {
  router.post('/api/tasks', (ctx) => {
    const body = ctx.body as Record<string, unknown> || {}
    if (!body.prompt || typeof body.prompt !== 'string') {
      return { status: 400, error: 'prompt is required' }
    }
    const timeoutMinutesRaw = body.timeoutMinutes ?? body.timeout
    const timeoutMinutes = typeof timeoutMinutesRaw === 'number'
      ? timeoutMinutesRaw
      : (typeof timeoutMinutesRaw === 'string' ? Number.parseInt(timeoutMinutesRaw, 10) : undefined)

    const task = queries.createTask(ctx.db, {
      name: (body.name as string | undefined) || body.prompt.slice(0, 50),
      prompt: body.prompt,
      description: body.description as string | undefined,
      triggerType: (body.triggerType as TriggerType | undefined) || 'manual',
      cronExpression: body.cronExpression as string | undefined,
      scheduledAt: body.scheduledAt as string | undefined,
      workerId: body.workerId as number | undefined,
      maxRuns: body.maxRuns as number | undefined,
      maxTurns: body.maxTurns as number | undefined,
      timeoutMinutes: Number.isFinite(timeoutMinutes) ? timeoutMinutes : undefined,
      allowedTools: body.allowedTools as string | undefined,
      disallowedTools: body.disallowedTools as string | undefined,
      sessionContinuity: body.sessionContinuity as boolean | undefined,
      roomId: body.roomId as number | undefined
    })
    eventBus.emit('tasks', 'task:created', task)
    return { status: 201, data: task }
  })

  router.get('/api/tasks', (ctx) => {
    const roomId = ctx.query.roomId ? Number(ctx.query.roomId) : undefined
    const tasks = queries.listTasks(ctx.db, roomId, ctx.query.status)
    return { data: tasks.map(toTaskListItem) }
  })

  router.get('/api/tasks/:id', (ctx) => {
    const task = queries.getTask(ctx.db, Number(ctx.params.id))
    if (!task) return { status: 404, error: 'Task not found' }
    return { data: task }
  })

  router.patch('/api/tasks/:id', (ctx) => {
    const id = Number(ctx.params.id)
    const task = queries.getTask(ctx.db, id)
    if (!task) return { status: 404, error: 'Task not found' }

    const body = ctx.body as Record<string, unknown> || {}
    queries.updateTask(ctx.db, id, body)
    const updated = queries.getTask(ctx.db, id)
    return { data: updated }
  })

  router.delete('/api/tasks/:id', (ctx) => {
    const id = Number(ctx.params.id)
    const task = queries.getTask(ctx.db, id)
    if (!task) return { status: 404, error: 'Task not found' }

    queries.deleteTask(ctx.db, id)
    return { data: { ok: true } }
  })

  router.post('/api/tasks/:id/pause', (ctx) => {
    const id = Number(ctx.params.id)
    const task = queries.getTask(ctx.db, id)
    if (!task) return { status: 404, error: 'Task not found' }

    queries.pauseTask(ctx.db, id)
    return { data: { ok: true } }
  })

  router.post('/api/tasks/:id/resume', (ctx) => {
    const id = Number(ctx.params.id)
    const task = queries.getTask(ctx.db, id)
    if (!task) return { status: 404, error: 'Task not found' }

    queries.resumeTask(ctx.db, id)
    return { data: { ok: true } }
  })

  router.get('/api/tasks/:id/runs', (ctx) => {
    const limit = ctx.query.limit ? Number(ctx.query.limit) : undefined
    const runs = queries.getTaskRuns(ctx.db, Number(ctx.params.id), limit)
    return { data: runs }
  })

  router.post('/api/tasks/:id/run', (ctx) => {
    const id = Number(ctx.params.id)
    const task = queries.getTask(ctx.db, id)
    if (!task) return { status: 404, error: 'Task not found' }

    const result = runTaskNow(ctx.db, id)
    if (!result.started) {
      return { status: 409, error: result.reason ?? 'Task is already running' }
    }

    return { status: 202, data: { ok: true } }
  })

  router.post('/api/tasks/:id/reset-session', (ctx) => {
    const id = Number(ctx.params.id)
    const task = queries.getTask(ctx.db, id)
    if (!task) return { status: 404, error: 'Task not found' }

    queries.clearTaskSession(ctx.db, id)
    return { data: { ok: true } }
  })
}

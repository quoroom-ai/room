import type { Router } from '../router'
import type { TriggerType } from '../../shared/types'
import * as queries from '../../shared/db-queries'
import { eventBus } from '../event-bus'

export function registerTaskRoutes(router: Router): void {
  router.post('/api/tasks', (ctx) => {
    const body = ctx.body as Record<string, unknown> || {}
    if (!body.prompt || typeof body.prompt !== 'string') {
      return { status: 400, error: 'prompt is required' }
    }

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
      timeoutMinutes: body.timeout as number | undefined,
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
    return { data: tasks }
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

    const run = queries.createTaskRun(ctx.db, id)
    eventBus.emit('runs', 'run:created', { taskId: id, runId: run.id })
    return { status: 201, data: { ok: true, runId: run.id } }
  })

  router.post('/api/tasks/:id/reset-session', (ctx) => {
    const id = Number(ctx.params.id)
    const task = queries.getTask(ctx.db, id)
    if (!task) return { status: 404, error: 'Task not found' }

    queries.clearTaskSession(ctx.db, id)
    return { data: { ok: true } }
  })
}

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestServer, request, type TestContext } from '../helpers/test-server'

let ctx: TestContext
let taskId: number

beforeAll(async () => {
  ctx = await createTestServer()
  // Create a task to attach runs to
  const res = await request(ctx, 'POST', '/api/tasks', {
    prompt: 'Run test task'
  })
  taskId = (res.body as any).id
})

afterAll(() => {
  ctx.close()
})

describe('Run routes', () => {
  describe('GET /api/runs', () => {
    it('lists all runs', async () => {
      const res = await request(ctx, 'GET', '/api/runs')
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
    })

    it('supports limit query parameter', async () => {
      const res = await request(ctx, 'GET', '/api/runs?limit=5')
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
    })
  })

  describe('GET /api/runs/:id', () => {
    it('returns a run', async () => {
      // Create a run via the task's run endpoint using direct DB insert
      // Runs are created via POST /api/tasks/:id/run, but we need a run to exist
      // Let's use the DB directly since there's no direct POST /api/runs endpoint
      const { createTaskRun } = await import('../../../shared/db-queries')
      const run = createTaskRun(ctx.db, taskId)

      const res = await request(ctx, 'GET', `/api/runs/${run.id}`)
      expect(res.status).toBe(200)
      expect((res.body as any).id).toBe(run.id)
      expect((res.body as any).taskId).toBe(taskId)
    })

    it('returns 404 for missing run', async () => {
      const res = await request(ctx, 'GET', '/api/runs/99999')
      expect(res.status).toBe(404)
    })
  })

  describe('GET /api/runs/:id/logs', () => {
    it('returns logs for a run', async () => {
      const { createTaskRun } = await import('../../../shared/db-queries')
      const run = createTaskRun(ctx.db, taskId)

      const res = await request(ctx, 'GET', `/api/runs/${run.id}/logs`)
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
    })

    it('supports afterSeq and limit query parameters', async () => {
      const { createTaskRun } = await import('../../../shared/db-queries')
      const run = createTaskRun(ctx.db, taskId)

      const res = await request(ctx, 'GET', `/api/runs/${run.id}/logs?afterSeq=0&limit=10`)
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
    })
  })
})

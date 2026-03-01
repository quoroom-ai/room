import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestServer, request, type TestContext } from '../helpers/test-server'

let ctx: TestContext

beforeAll(async () => {
  ctx = await createTestServer()
})

afterAll(() => {
  ctx.close()
})

describe('Worker routes', () => {
  describe('POST /api/workers', () => {
    it('creates a worker', async () => {
      const res = await request(ctx, 'POST', '/api/workers', {
        name: 'Test Worker',
        systemPrompt: 'You are a test worker.'
      })
      expect(res.status).toBe(201)
      expect((res.body as any).name).toBe('Test Worker')
      expect((res.body as any).systemPrompt).toBe('You are a test worker.')
    })

    it('returns 400 if name missing', async () => {
      const res = await request(ctx, 'POST', '/api/workers', {
        systemPrompt: 'No name'
      })
      expect(res.status).toBe(400)
    })

    it('returns 400 if systemPrompt missing', async () => {
      const res = await request(ctx, 'POST', '/api/workers', {
        name: 'No Prompt'
      })
      expect(res.status).toBe(400)
    })
  })

  describe('GET /api/workers', () => {
    it('lists workers', async () => {
      const res = await request(ctx, 'GET', '/api/workers')
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
    })
  })

  describe('GET /api/workers/:id', () => {
    it('returns a worker', async () => {
      const createRes = await request(ctx, 'POST', '/api/workers', {
        name: 'FindMe',
        systemPrompt: 'prompt'
      })
      const id = (createRes.body as any).id

      const res = await request(ctx, 'GET', `/api/workers/${id}`)
      expect(res.status).toBe(200)
      expect((res.body as any).name).toBe('FindMe')
    })

    it('returns 404 for missing worker', async () => {
      const res = await request(ctx, 'GET', '/api/workers/99999')
      expect(res.status).toBe(404)
    })
  })

  describe('PATCH /api/workers/:id', () => {
    it('updates a worker', async () => {
      const createRes = await request(ctx, 'POST', '/api/workers', {
        name: 'UpdateMe',
        systemPrompt: 'old'
      })
      const id = (createRes.body as any).id

      const res = await request(ctx, 'PATCH', `/api/workers/${id}`, {
        name: 'Updated Name'
      })
      expect(res.status).toBe(200)
      expect((res.body as any).name).toBe('Updated Name')
    })

    it('updates model and persists it', async () => {
      const createRes = await request(ctx, 'POST', '/api/workers', {
        name: 'ModelWorker',
        systemPrompt: 'test'
      })
      const id = (createRes.body as any).id
      expect((createRes.body as any).model).toBeNull()

      // Set model to openai
      const patchRes = await request(ctx, 'PATCH', `/api/workers/${id}`, {
        model: 'openai:gpt-4o-mini'
      })
      expect(patchRes.status).toBe(200)
      expect((patchRes.body as any).model).toBe('openai:gpt-4o-mini')

      // Verify it persists on re-read
      const getRes = await request(ctx, 'GET', `/api/workers/${id}`)
      expect(getRes.status).toBe(200)
      expect((getRes.body as any).model).toBe('openai:gpt-4o-mini')

      // Set model back to null (claude default)
      const resetRes = await request(ctx, 'PATCH', `/api/workers/${id}`, {
        model: null
      })
      expect(resetRes.status).toBe(200)
      expect((resetRes.body as any).model).toBeNull()
    })
  })

  describe('DELETE /api/workers/:id', () => {
    it('deletes a worker', async () => {
      const createRes = await request(ctx, 'POST', '/api/workers', {
        name: 'DeleteMe',
        systemPrompt: 'prompt'
      })
      const id = (createRes.body as any).id

      const res = await request(ctx, 'DELETE', `/api/workers/${id}`)
      expect(res.status).toBe(200)
      expect((res.body as any).ok).toBe(true)
    })
  })

  describe('POST /api/workers/:id/start', () => {
    it('returns 409 when room runtime is not started', async () => {
      const roomRes = await request(ctx, 'POST', '/api/rooms', { name: 'WorkerGateRoom' })
      const queenId = (roomRes.body as any).queen.id as number

      const res = await request(ctx, 'POST', `/api/workers/${queenId}/start`)
      expect(res.status).toBe(409)
      expect((res.body as any).error).toMatch(/start the room first/i)
    })

    it('starts worker after room start', async () => {
      const roomRes = await request(ctx, 'POST', '/api/rooms', { name: 'WorkerStartRoom' })
      const roomId = (roomRes.body as any).room.id as number
      const queenId = (roomRes.body as any).queen.id as number

      await request(ctx, 'PATCH', `/api/workers/${queenId}`, { model: 'openai:gpt-4o-mini' })
      const startRoom = await request(ctx, 'POST', `/api/rooms/${roomId}/start`)
      expect(startRoom.status).toBe(200)

      const res = await request(ctx, 'POST', `/api/workers/${queenId}/start`)
      expect(res.status).toBe(200)
      expect((res.body as any).running).toBe(true)

      await request(ctx, 'POST', `/api/rooms/${roomId}/stop`)
    })
  })

  describe('GET /api/rooms/:roomId/workers', () => {
    it('lists workers for a room', async () => {
      const roomRes = await request(ctx, 'POST', '/api/rooms', { name: 'WorkerRoom' })
      const roomId = (roomRes.body as any).room.id

      const res = await request(ctx, 'GET', `/api/rooms/${roomId}/workers`)
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
      // Room creation creates a queen worker
      expect((res.body as any[]).length).toBeGreaterThanOrEqual(1)
    })
  })
})

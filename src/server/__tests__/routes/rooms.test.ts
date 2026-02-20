import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestServer, request, requestNoAuth, type TestContext } from '../helpers/test-server'

let ctx: TestContext

beforeAll(async () => {
  ctx = await createTestServer()
})

afterAll(() => {
  ctx.close()
})

describe('Room routes', () => {
  describe('POST /api/rooms', () => {
    it('creates a room', async () => {
      const res = await request(ctx, 'POST', '/api/rooms', {
        name: 'Test Room',
        goal: 'Test goal'
      })
      expect(res.status).toBe(201)
      const data = res.body as any
      expect(data.room.name).toBe('Test Room')
      expect(data.queen).toBeDefined()
      expect(data.rootGoal.description).toBe('Test goal')
    })

    it('returns 400 if name missing', async () => {
      const res = await request(ctx, 'POST', '/api/rooms', { goal: 'No name' })
      expect(res.status).toBe(400)
    })

    it('rejects unauthenticated requests', async () => {
      const res = await requestNoAuth(ctx, 'POST', '/api/rooms')
      expect(res.status).toBe(401)
    })
  })

  describe('GET /api/rooms', () => {
    it('lists rooms', async () => {
      const res = await request(ctx, 'GET', '/api/rooms')
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
      expect((res.body as any[]).length).toBeGreaterThan(0)
    })
  })

  describe('GET /api/rooms/:id', () => {
    it('returns a room by id', async () => {
      const createRes = await request(ctx, 'POST', '/api/rooms', { name: 'GetById' })
      const roomId = (createRes.body as any).room.id

      const res = await request(ctx, 'GET', `/api/rooms/${roomId}`)
      expect(res.status).toBe(200)
      expect((res.body as any).name).toBe('GetById')
    })

    it('returns 404 for missing room', async () => {
      const res = await request(ctx, 'GET', '/api/rooms/99999')
      expect(res.status).toBe(404)
    })
  })

  describe('GET /api/rooms/:id/status', () => {
    it('returns room status', async () => {
      const createRes = await request(ctx, 'POST', '/api/rooms', { name: 'StatusRoom', goal: 'Test' })
      const roomId = (createRes.body as any).room.id

      const res = await request(ctx, 'GET', `/api/rooms/${roomId}/status`)
      expect(res.status).toBe(200)
      const data = res.body as any
      expect(data.room).toBeDefined()
      expect(data.workers).toBeDefined()
      expect(data.activeGoals).toBeDefined()
      expect(data.pendingDecisions).toBeDefined()
    })
  })

  describe('GET /api/rooms/:id/activity', () => {
    it('returns activity list', async () => {
      const createRes = await request(ctx, 'POST', '/api/rooms', { name: 'ActivityRoom' })
      const roomId = (createRes.body as any).room.id

      const res = await request(ctx, 'GET', `/api/rooms/${roomId}/activity`)
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
    })
  })

  describe('POST /api/rooms/:id/pause', () => {
    it('pauses a room', async () => {
      const createRes = await request(ctx, 'POST', '/api/rooms', { name: 'PauseRoom' })
      const roomId = (createRes.body as any).room.id

      const res = await request(ctx, 'POST', `/api/rooms/${roomId}/pause`)
      expect(res.status).toBe(200)
      expect((res.body as any).ok).toBe(true)
    })
  })

  describe('POST /api/rooms/:id/restart', () => {
    it('restarts a paused room', async () => {
      const createRes = await request(ctx, 'POST', '/api/rooms', { name: 'RestartRoom' })
      const roomId = (createRes.body as any).room.id

      await request(ctx, 'POST', `/api/rooms/${roomId}/pause`)
      const res = await request(ctx, 'POST', `/api/rooms/${roomId}/restart`)
      expect(res.status).toBe(200)
      expect((res.body as any).ok).toBe(true)
    })
  })

  describe('DELETE /api/rooms/:id', () => {
    it('deletes a room', async () => {
      const createRes = await request(ctx, 'POST', '/api/rooms', { name: 'DeleteRoom' })
      const roomId = (createRes.body as any).room.id

      const res = await request(ctx, 'DELETE', `/api/rooms/${roomId}`)
      expect(res.status).toBe(200)
      expect((res.body as any).ok).toBe(true)

      const getRes = await request(ctx, 'GET', `/api/rooms/${roomId}`)
      expect(getRes.status).toBe(404)
    })
  })
})

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestServer, request, type TestContext } from '../helpers/test-server'

let ctx: TestContext
let roomId: number

beforeAll(async () => {
  ctx = await createTestServer()
  const res = await request(ctx, 'POST', '/api/rooms', { name: 'GoalRoom', goal: 'Root goal' })
  roomId = (res.body as any).room.id
})

afterAll(() => {
  ctx.close()
})

describe('Goal routes', () => {
  describe('POST /api/rooms/:roomId/goals', () => {
    it('creates a goal', async () => {
      const res = await request(ctx, 'POST', `/api/rooms/${roomId}/goals`, {
        description: 'Sub goal'
      })
      expect(res.status).toBe(201)
      expect((res.body as any).description).toBe('Sub goal')
      expect((res.body as any).roomId).toBe(roomId)
    })

    it('returns 400 if description missing', async () => {
      const res = await request(ctx, 'POST', `/api/rooms/${roomId}/goals`, {})
      expect(res.status).toBe(400)
    })
  })

  describe('GET /api/rooms/:roomId/goals', () => {
    it('lists goals for room', async () => {
      const res = await request(ctx, 'GET', `/api/rooms/${roomId}/goals`)
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
      expect((res.body as any[]).length).toBeGreaterThan(0)
    })
  })

  describe('GET /api/goals/:id', () => {
    it('returns a goal', async () => {
      const createRes = await request(ctx, 'POST', `/api/rooms/${roomId}/goals`, {
        description: 'FindMe goal'
      })
      const id = (createRes.body as any).id

      const res = await request(ctx, 'GET', `/api/goals/${id}`)
      expect(res.status).toBe(200)
      expect((res.body as any).description).toBe('FindMe goal')
    })

    it('returns 404 for missing goal', async () => {
      const res = await request(ctx, 'GET', '/api/goals/99999')
      expect(res.status).toBe(404)
    })
  })

  describe('GET /api/goals/:id/subgoals', () => {
    it('returns subgoals', async () => {
      const parentRes = await request(ctx, 'POST', `/api/rooms/${roomId}/goals`, {
        description: 'Parent goal'
      })
      const parentId = (parentRes.body as any).id

      await request(ctx, 'POST', `/api/rooms/${roomId}/goals`, {
        description: 'Child goal',
        parentGoalId: parentId
      })

      const res = await request(ctx, 'GET', `/api/goals/${parentId}/subgoals`)
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
      expect((res.body as any[]).length).toBe(1)
      expect((res.body as any[])[0].description).toBe('Child goal')
    })
  })

  describe('PATCH /api/goals/:id', () => {
    it('updates a goal', async () => {
      const createRes = await request(ctx, 'POST', `/api/rooms/${roomId}/goals`, {
        description: 'UpdateMe'
      })
      const id = (createRes.body as any).id

      const res = await request(ctx, 'PATCH', `/api/goals/${id}`, {
        status: 'completed'
      })
      expect(res.status).toBe(200)
      expect((res.body as any).status).toBe('completed')
    })
  })

  describe('DELETE /api/goals/:id', () => {
    it('deletes a goal', async () => {
      const createRes = await request(ctx, 'POST', `/api/rooms/${roomId}/goals`, {
        description: 'DeleteMe'
      })
      const id = (createRes.body as any).id

      const res = await request(ctx, 'DELETE', `/api/goals/${id}`)
      expect(res.status).toBe(200)
      expect((res.body as any).ok).toBe(true)

      const getRes = await request(ctx, 'GET', `/api/goals/${id}`)
      expect(getRes.status).toBe(404)
    })
  })

  describe('POST /api/goals/:id/updates', () => {
    it('logs a goal update', async () => {
      const createRes = await request(ctx, 'POST', `/api/rooms/${roomId}/goals`, {
        description: 'Progress goal'
      })
      const id = (createRes.body as any).id

      const res = await request(ctx, 'POST', `/api/goals/${id}/updates`, {
        observation: 'Made progress'
      })
      expect(res.status).toBe(201)
      expect((res.body as any).observation).toBe('Made progress')
    })

    it('returns 400 if observation missing', async () => {
      const createRes = await request(ctx, 'POST', `/api/rooms/${roomId}/goals`, {
        description: 'NoObsGoal'
      })
      const id = (createRes.body as any).id

      const res = await request(ctx, 'POST', `/api/goals/${id}/updates`, {})
      expect(res.status).toBe(400)
    })
  })

  describe('GET /api/goals/:id/updates', () => {
    it('returns goal updates', async () => {
      const createRes = await request(ctx, 'POST', `/api/rooms/${roomId}/goals`, {
        description: 'Updates goal'
      })
      const id = (createRes.body as any).id

      await request(ctx, 'POST', `/api/goals/${id}/updates`, { observation: 'Update 1' })
      await request(ctx, 'POST', `/api/goals/${id}/updates`, { observation: 'Update 2' })

      const res = await request(ctx, 'GET', `/api/goals/${id}/updates`)
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
      expect((res.body as any[]).length).toBe(2)
    })
  })
})

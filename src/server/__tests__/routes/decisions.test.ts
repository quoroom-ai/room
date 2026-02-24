import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestServer, request, type TestContext } from '../helpers/test-server'

let ctx: TestContext
let roomId: number
let queenId: number

beforeAll(async () => {
  ctx = await createTestServer()
  const res = await request(ctx, 'POST', '/api/rooms', { name: 'DecisionRoom' })
  roomId = (res.body as any).room.id
  queenId = (res.body as any).queen.id
})

afterAll(() => {
  ctx.close()
})

describe('Decision routes', () => {
  describe('POST /api/rooms/:roomId/decisions', () => {
    it('creates a decision', async () => {
      const res = await request(ctx, 'POST', `/api/rooms/${roomId}/decisions`, {
        proposerId: queenId,
        proposal: 'Should we proceed?',
        decisionType: 'majority'
      })
      expect(res.status).toBe(201)
      expect((res.body as any).proposal).toBe('Should we proceed?')
      expect((res.body as any).decisionType).toBe('majority')
    })

    it('allows null proposerId', async () => {
      const res = await request(ctx, 'POST', `/api/rooms/${roomId}/decisions`, {
        proposal: 'Test',
        decisionType: 'majority'
      })
      expect(res.status).toBe(201)
      expect((res.body as any).proposerId).toBeNull()
    })

    it('returns 400 if proposal missing', async () => {
      const res = await request(ctx, 'POST', `/api/rooms/${roomId}/decisions`, {
        proposerId: queenId,
        decisionType: 'majority'
      })
      expect(res.status).toBe(400)
    })

    it('returns 400 if decisionType missing', async () => {
      const res = await request(ctx, 'POST', `/api/rooms/${roomId}/decisions`, {
        proposerId: queenId,
        proposal: 'Test'
      })
      expect(res.status).toBe(400)
    })
  })

  describe('GET /api/rooms/:roomId/decisions', () => {
    it('lists decisions', async () => {
      const res = await request(ctx, 'GET', `/api/rooms/${roomId}/decisions`)
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
    })
  })

  describe('GET /api/decisions/:id', () => {
    it('returns a decision', async () => {
      const createRes = await request(ctx, 'POST', `/api/rooms/${roomId}/decisions`, {
        proposerId: queenId,
        proposal: 'FindMe decision',
        decisionType: 'majority'
      })
      const id = (createRes.body as any).id

      const res = await request(ctx, 'GET', `/api/decisions/${id}`)
      expect(res.status).toBe(200)
      expect((res.body as any).proposal).toBe('FindMe decision')
    })

    it('returns 404 for missing decision', async () => {
      const res = await request(ctx, 'GET', '/api/decisions/99999')
      expect(res.status).toBe(404)
    })
  })

  describe('POST /api/decisions/:id/vote', () => {
    it('casts a vote', async () => {
      const createRes = await request(ctx, 'POST', `/api/rooms/${roomId}/decisions`, {
        proposerId: queenId,
        proposal: 'Vote test',
        decisionType: 'majority'
      })
      const id = (createRes.body as any).id

      const res = await request(ctx, 'POST', `/api/decisions/${id}/vote`, {
        workerId: queenId,
        vote: 'yes',
        reasoning: 'Looks good'
      })
      expect(res.status).toBe(201)
      expect((res.body as any).vote).toBe('yes')
    })

    it('returns 400 if workerId missing', async () => {
      const createRes = await request(ctx, 'POST', `/api/rooms/${roomId}/decisions`, {
        proposerId: queenId,
        proposal: 'No voter',
        decisionType: 'majority'
      })
      const id = (createRes.body as any).id

      const res = await request(ctx, 'POST', `/api/decisions/${id}/vote`, {
        vote: 'yes'
      })
      expect(res.status).toBe(400)
    })
  })

  describe('GET /api/decisions/:id/votes', () => {
    it('returns votes', async () => {
      const createRes = await request(ctx, 'POST', `/api/rooms/${roomId}/decisions`, {
        proposerId: queenId,
        proposal: 'Votes list test',
        decisionType: 'majority'
      })
      const id = (createRes.body as any).id

      await request(ctx, 'POST', `/api/decisions/${id}/vote`, {
        workerId: queenId,
        vote: 'yes'
      })

      const res = await request(ctx, 'GET', `/api/decisions/${id}/votes`)
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
      expect((res.body as any[]).length).toBe(1)
    })
  })

  describe('POST /api/decisions/:id/resolve', () => {
    it('resolves a decision', async () => {
      const createRes = await request(ctx, 'POST', `/api/rooms/${roomId}/decisions`, {
        proposerId: queenId,
        proposal: 'Resolve test',
        decisionType: 'majority'
      })
      const id = (createRes.body as any).id

      const res = await request(ctx, 'POST', `/api/decisions/${id}/resolve`, {
        status: 'approved',
        result: 'Consensus reached'
      })
      expect(res.status).toBe(200)
      expect((res.body as any).status).toBe('approved')
    })

    it('returns 400 if status missing', async () => {
      const createRes = await request(ctx, 'POST', `/api/rooms/${roomId}/decisions`, {
        proposerId: queenId,
        proposal: 'NoStatus test',
        decisionType: 'majority'
      })
      const id = (createRes.body as any).id

      const res = await request(ctx, 'POST', `/api/decisions/${id}/resolve`, {})
      expect(res.status).toBe(400)
    })
  })
})
